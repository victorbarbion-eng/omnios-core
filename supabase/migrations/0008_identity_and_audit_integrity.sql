-- =============================================================
-- 0008_identity_and_audit_integrity.sql
--
-- Fixes two further defects the guard suite exposed, plus the hole
-- that the first fix revealed. None of these weaken a guard; two of
-- them close a real gap.
--
-- DEFECT 1 — os_actor_type() returned NULL.
--   `if v_raw not in ('user','agent','system')` evaluates to NULL when
--   v_raw is NULL, so the branch was skipped and the function fell
--   through to `return v_raw::actor_type` = NULL. Every audited insert
--   from a connection that set no actor context then failed on
--   audit_events.actor_type NOT NULL. SQL three-valued logic.
--
-- DEFECT 2 — audited projects could not be deleted.
--   audit_events.project_id had `references projects(id) on delete set
--   null`. Deleting a project made Postgres UPDATE the audit rows,
--   which the append-only trigger correctly refused. The FK was the
--   wrong choice: an audit log should keep the identifier of a thing
--   that no longer exists. Dropping the constraint keeps history
--   immutable AND makes deletion possible. The column and its index
--   stay, so the dashboard's project filter is unaffected.
--
-- GAP 3 — fixing defect 1 exposed a privilege hole.
--   Defaulting an unattributed caller to 'user' meant a service-role
--   caller that simply omitted the x-omnios-actor header would be
--   treated as human, which would have let it flip the emergency
--   pause. Attribution now derives from the CHANNEL, which the caller
--   cannot fake, and the pause RPC refuses key-only API traffic.
-- =============================================================

-- ---- Channel test --------------------------------------------
-- request.headers is populated by PostgREST and is absent on a direct
-- Postgres connection. A caller cannot remove it, so this reliably
-- distinguishes "arrived through the API with a key" from "someone at
-- a terminal with the database password".
create or replace function os_is_api_request() returns boolean
language plpgsql stable as $$
begin
  return nullif(current_setting('request.headers', true), '') is not null;
exception when others then
  return false;
end;
$$;

comment on function os_is_api_request is
  'True when the statement arrived via PostgREST. Cannot be spoofed by the caller; used to tell key-based API traffic from a direct database session.';

-- ---- Fixed actor attribution ---------------------------------
create or replace function os_actor_type() returns actor_type
language plpgsql stable as $$
declare
  v_raw text;
begin
  -- 1. Direct Postgres connection (psql, pg driver, our scripts/).
  v_raw := nullif(current_setting('omnios.actor_type', true), '');

  -- 2. PostgREST: x-omnios-actor request header (attribution only —
  --    it is caller-controlled, so nothing is authorised by it).
  if v_raw is null then
    begin
      v_raw := nullif(
        (nullif(current_setting('request.headers', true), '')::jsonb) ->> 'x-omnios-actor',
        '');
    exception when others then
      v_raw := null;
    end;
  end if;

  -- Explicit and recognised: take it at face value.
  if v_raw in ('user', 'agent', 'system') then
    return v_raw::actor_type;
  end if;

  -- Explicit but unrecognised: never promote a junk value to 'user'.
  if v_raw is not null then
    return 'system'::actor_type;
  end if;

  -- Nothing declared. Infer from the channel, which cannot be faked.
  if auth.uid() is not null then
    return 'user'::actor_type;     -- a real signed-in end-user session
  elsif os_is_api_request() then
    return 'agent'::actor_type;    -- an API key with no human attached
  else
    return 'system'::actor_type;   -- direct database session, unlabelled
  end if;
end;
$$;

comment on function os_actor_type is
  'Who is acting: explicit GUC, then request header, then inferred from the channel. Attribution for the audit trail only — authorisation always comes from auth.uid() and row-level security.';

-- ---- Audit rows stop being tied to live projects -------------
do $$
declare
  v_name text;
begin
  select conname into v_name
    from pg_constraint
   where conrelid = 'public.audit_events'::regclass
     and contype = 'f'
     and pg_get_constraintdef(oid) ilike '%projects%';

  if v_name is not null then
    execute format('alter table audit_events drop constraint %I', v_name);
  end if;
end;
$$;

comment on column audit_events.project_id is
  'Project this event concerned. Deliberately NOT a foreign key: history must survive, and stay unmodified, after a project is deleted.';

-- ---- Pause RPC: refuse key-only API callers ------------------
create or replace function os_set_emergency_pause(p_on boolean, p_reason text default null)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  -- A signed-in human, or a direct database session (you, at a
  -- terminal, with the password). Never an API key on its own.
  if auth.uid() is null and os_is_api_request() then
    raise exception
      'OMNIOS_HUMAN_SESSION_REQUIRED: the emergency pause can only be changed by a signed-in user or from a direct database session.'
      using errcode = 'insufficient_privilege';
  end if;

  if os_actor_type() = 'agent' then
    raise exception 'OMNIOS_AGENT_BLOCKED: an agent may not change the emergency pause.'
      using errcode = 'insufficient_privilege';
  end if;

  update system_settings
     set value = to_jsonb(p_on),
         updated_at = now(),
         updated_by = coalesce(os_actor_name(), os_actor_type()::text)
   where key = 'emergency_pause';

  insert into audit_events (
    owner_id, actor_type, actor_id, actor_name, action, entity_type, entity_id, after_data, metadata
  ) values (
    coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid),
    os_actor_type(),
    auth.uid(),
    coalesce(os_actor_name(), os_actor_type()::text),
    case when p_on then 'system.emergency_pause_engaged' else 'system.emergency_pause_released' end,
    'system_settings',
    'emergency_pause',
    to_jsonb(p_on),
    jsonb_build_object('reason', left(coalesce(p_reason, ''), 500))
  );

  return p_on;
end;
$$;

revoke all on function os_set_emergency_pause(boolean, text) from public;
grant execute on function os_set_emergency_pause(boolean, text) to authenticated, service_role;
