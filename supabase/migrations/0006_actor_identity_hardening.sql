-- =============================================================
-- 0006_actor_identity_hardening.sql
--
-- Problem this fixes: the local agent talks to the database through
-- PostgREST with the service-role key, where `set local` session
-- variables are not available. So os_actor_type() had no way to see
-- agent traffic over that transport, and — more importantly — the
-- self-approval guard leaned on a value the caller controls.
--
-- Fix, in two parts:
--   1. Attribution: also read an `x-omnios-actor` request header, so
--      agent traffic is labelled correctly in the audit trail.
--   2. Enforcement: a decision on an approval now additionally
--      requires a real end-user session (auth.uid() is not null).
--      The service-role key has no auth.uid(), so anything holding
--      that key can REQUEST an approval and can never GRANT one.
--      That boundary does not depend on a self-declared header.
-- =============================================================

create or replace function os_actor_type() returns actor_type
language plpgsql stable as $$
declare
  v_raw text;
begin
  -- 1. Direct Postgres connection (psql, pg driver): set local omnios.actor_type
  v_raw := nullif(current_setting('omnios.actor_type', true), '');

  -- 2. PostgREST: x-omnios-actor request header
  if v_raw is null then
    begin
      v_raw := nullif(
        (nullif(current_setting('request.headers', true), '')::jsonb) ->> 'x-omnios-actor',
        '');
    exception when others then
      v_raw := null;
    end;
  end if;

  if v_raw not in ('user', 'agent', 'system') then
    -- Anything unrecognised is attributed to the system, never to the
    -- user, so an odd header cannot dress agent work up as human work.
    return case when v_raw is null then 'user'::actor_type else 'system'::actor_type end;
  end if;

  return v_raw::actor_type;
end;
$$;

create or replace function os_actor_name() returns text
language plpgsql stable as $$
declare
  v text;
begin
  v := nullif(current_setting('omnios.actor_name', true), '');
  if v is null then
    begin
      v := nullif(
        (nullif(current_setting('request.headers', true), '')::jsonb) ->> 'x-omnios-actor-name',
        '');
    exception when others then
      v := null;
    end;
  end if;
  return left(v, 120);
end;
$$;

-- ---- Hardened approval decision guard ------------------------
create or replace function os_guard_approval_decision() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status
     and new.status in ('approved', 'denied') then

    -- HARD BOUNDARY: a decision requires a signed-in human session.
    -- The service-role key used by agents has no auth.uid().
    if auth.uid() is null then
      raise exception
        'OMNIOS_HUMAN_SESSION_REQUIRED: approval % can only be decided by a signed-in user. This connection has no end-user session.',
        new.id
        using errcode = 'insufficient_privilege';
    end if;

    -- Defence in depth: refuse self-declared agent traffic outright.
    if os_actor_type() = 'agent' then
      raise exception 'OMNIOS_SELF_APPROVAL_BLOCKED: an agent cannot approve or deny approval %.', new.id
        using errcode = 'insufficient_privilege';
    end if;

    if old.status <> 'pending' then
      raise exception 'OMNIOS_NOT_PENDING: approval % is % and can no longer be decided.', new.id, old.status
        using errcode = 'check_violation';
    end if;

    if old.expires_at < now() then
      raise exception 'OMNIOS_EXPIRED: approval % expired on % and must be requested again.', new.id, old.expires_at
        using errcode = 'check_violation';
    end if;

    new.decided_at            := coalesce(new.decided_at, now());
    new.decided_by_actor_type := 'user';
    new.decided_by            := auth.uid();
  end if;

  if old.status = 'completed' and new.status is distinct from old.status then
    raise exception 'OMNIOS_IMMUTABLE: approval % is already completed.', new.id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ---- Kill switch helpers -------------------------------------
-- Flipping the pause is a human action, so it also requires a real
-- session. Exposed as RPCs the dashboard can call.
create or replace function os_set_emergency_pause(p_on boolean, p_reason text default null)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null and os_actor_type() = 'agent' then
    raise exception 'OMNIOS_HUMAN_SESSION_REQUIRED: only a signed-in user may change the emergency pause.'
      using errcode = 'insufficient_privilege';
  end if;

  update system_settings
     set value = to_jsonb(p_on),
         updated_at = now(),
         updated_by = coalesce(os_actor_name(), os_actor_type()::text)
   where key = 'emergency_pause';

  insert into audit_events (owner_id, actor_type, actor_id, actor_name, action, entity_type, entity_id, after_data, metadata)
  values (
    coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid),
    os_actor_type(), auth.uid(), coalesce(os_actor_name(), 'user'),
    case when p_on then 'system.emergency_pause_engaged' else 'system.emergency_pause_released' end,
    'system_settings', 'emergency_pause',
    to_jsonb(p_on),
    jsonb_build_object('reason', left(coalesce(p_reason, ''), 500))
  );

  return p_on;
end;
$$;

comment on function os_set_emergency_pause is
  'Kill switch. While on, os_guard_jobs() refuses to start any job whose action type is not risk_level=read.';
