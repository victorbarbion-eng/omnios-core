-- =============================================================
-- 0004_guards_and_audit.sql
-- Enforcement. These triggers run for EVERY connection, including
-- the service-role key that bypasses row-level security. That is
-- deliberate: it is the one control an agent with a powerful key
-- still cannot talk its way around.
-- =============================================================

-- A job type and an approval action type must exist in the policy
-- table. No inventing new powers at runtime.
alter table jobs
  add constraint jobs_job_type_known
  foreign key (job_type) references action_policies (action_type);

alter table approvals
  add constraint approvals_action_type_known
  foreign key (action_type) references action_policies (action_type);

-- ---- updated_at ---------------------------------------------
create or replace function os_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['projects','agents','tasks','artifacts','jobs','approvals','evidence','action_policies','system_settings']
  loop
    execute format(
      'create trigger %I_touch_updated_at before update on %I for each row execute function os_touch_updated_at()',
      t, t);
  end loop;
end;
$$;

-- ---- Job guard ----------------------------------------------
create or replace function os_guard_jobs() returns trigger
language plpgsql as $$
declare
  v_risk       risk_class;
  v_auto       boolean;
  v_approved   boolean;
  v_allowed    boolean;
begin
  v_risk := os_risk_level(new.job_type);
  v_auto := os_is_auto_allowed(new.job_type);

  -- Nothing prohibited is ever queued, at any autonomy level.
  if v_risk = 'prohibited' then
    raise exception 'OMNIOS_PROHIBITED: action type "%" is prohibited by policy and cannot be queued.', new.job_type
      using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  -- Below here: UPDATE only.
  if new.status is distinct from old.status then

    -- 1. Legal state transitions only. A stuck or lying agent cannot
    --    jump straight from queued to completed.
    v_allowed := case old.status
      when 'queued'            then new.status in ('claimed','cancelled','failed')
      when 'claimed'           then new.status in ('running','awaiting_approval','queued','failed','cancelled')
      when 'running'           then new.status in ('awaiting_approval','completed','failed','cancelled')
      when 'awaiting_approval' then new.status in ('running','completed','failed','cancelled')
      when 'failed'            then new.status in ('queued','cancelled')
      when 'completed'         then false
      when 'cancelled'         then false
    end;

    if not v_allowed then
      raise exception 'OMNIOS_BAD_TRANSITION: job % cannot move from % to %.', new.id, old.status, new.status
        using errcode = 'check_violation';
    end if;

    -- 2. The kill switch. While paused, only read-class work starts.
    if new.status in ('claimed','running') and os_emergency_pause() and v_risk <> 'read' then
      raise exception 'OMNIOS_EMERGENCY_PAUSE: system is paused; only risk_level=read jobs may start (job % is %).',
        new.id, v_risk
        using errcode = 'check_violation';
    end if;

    -- 3. The approval gate. An action that is not auto_allowed may
    --    not execute until an approval row for THIS job is approved.
    if new.status in ('running','completed') and not v_auto then
      select exists (
        select 1 from approvals a
         where a.job_id = new.id
           and a.action_type = new.job_type
           and a.status = 'approved'
      ) into v_approved;

      if not v_approved then
        raise exception
          'OMNIOS_APPROVAL_REQUIRED: job % (%) needs an approved approval record before it can run. Set status to awaiting_approval and create one.',
          new.id, new.job_type
          using errcode = 'check_violation';
      end if;
    end if;

    -- 4. Timestamp bookkeeping, so durations are always trustworthy.
    if new.status = 'claimed'   and new.claimed_at  is null then new.claimed_at  := now(); end if;
    if new.status = 'running'   and new.started_at  is null then new.started_at  := now(); end if;
    if new.status in ('completed','failed','cancelled') and new.finished_at is null then
      new.finished_at := now();
    end if;
  end if;

  if new.attempt_count > new.max_attempts then
    raise exception 'OMNIOS_RETRY_LIMIT: job % exceeded max_attempts (%).', new.id, new.max_attempts
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger jobs_guard
  before insert or update on jobs
  for each row execute function os_guard_jobs();

-- ---- Approval decision guard --------------------------------
create or replace function os_guard_approval_decision() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status
     and new.status in ('approved','denied') then

    -- An agent may REQUEST but never DECIDE. This is the whole point.
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
    new.decided_by            := coalesce(new.decided_by, auth.uid());
  end if;

  -- Once an approved action has been carried out, freeze it.
  if old.status = 'completed' and new.status is distinct from old.status then
    raise exception 'OMNIOS_IMMUTABLE: approval % is already completed.', new.id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger approvals_decision_guard
  before update on approvals
  for each row execute function os_guard_approval_decision();

-- ---- Audit trail --------------------------------------------
create or replace function os_write_audit() returns trigger
language plpgsql as $$
declare
  v_action  text;
  v_project uuid;
  v_before  jsonb := null;
  v_after   jsonb := null;
  v_entity  text  := tg_table_name;
begin
  if tg_op = 'INSERT' then
    v_action  := v_entity || '.created';
    v_project := case when v_entity = 'projects' then new.id else new.project_id end;
    v_after   := to_jsonb(new);
  else
    v_project := case when v_entity = 'projects' then new.id else new.project_id end;
    if to_jsonb(new) -> 'status' is distinct from to_jsonb(old) -> 'status' then
      v_action := v_entity || '.status_changed';
    else
      v_action := v_entity || '.updated';
    end if;
    v_before := to_jsonb(old);
    v_after  := to_jsonb(new);
  end if;

  -- Keep the trail lightweight and free of document bodies.
  v_before := (v_before - 'inline_body' - 'excerpt' - 'action_payload' - 'input_reference' - 'description');
  v_after  := (v_after  - 'inline_body' - 'excerpt' - 'action_payload' - 'input_reference' - 'description');

  insert into audit_events (
    owner_id, actor_type, actor_id, actor_name, project_id,
    action, entity_type, entity_id, before_data, after_data, metadata
  ) values (
    new.owner_id,
    os_actor_type(),
    auth.uid(),
    coalesce(os_actor_name(), os_actor_type()::text),
    v_project,
    v_action,
    v_entity,
    new.id::text,
    v_before,
    v_after,
    jsonb_build_object('op', tg_op)
  );

  return null;
end;
$$;

create trigger jobs_audit      after insert or update on jobs      for each row execute function os_write_audit();
create trigger approvals_audit after insert or update on approvals for each row execute function os_write_audit();
create trigger tasks_audit     after insert or update on tasks     for each row execute function os_write_audit();
create trigger artifacts_audit after insert or update on artifacts for each row execute function os_write_audit();
create trigger projects_audit  after insert or update on projects  for each row execute function os_write_audit();

-- The audit trail is append-only. Rewriting history is a
-- prohibited action, so block it structurally.
create or replace function os_audit_is_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'OMNIOS_AUDIT_APPEND_ONLY: audit_events cannot be modified or deleted (attempted %).', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_events_no_update before update on audit_events
  for each row execute function os_audit_is_append_only();
create trigger audit_events_no_delete before delete on audit_events
  for each row execute function os_audit_is_append_only();

-- Policy widening must leave a note behind.
create or replace function os_guard_policy_change() returns trigger
language plpgsql as $$
begin
  if new.auto_allowed and not old.auto_allowed then
    if os_actor_type() = 'agent' then
      raise exception 'OMNIOS_SELF_PROMOTION_BLOCKED: an agent cannot widen its own autonomy ("%").', new.action_type
        using errcode = 'insufficient_privilege';
    end if;
    if coalesce(trim(new.promoted_note), '') = '' then
      raise exception 'OMNIOS_PROMOTION_NEEDS_NOTE: set promoted_note explaining why "%" is now automatic.', new.action_type
        using errcode = 'check_violation';
    end if;
    new.promoted_at := now();
  end if;
  return new;
end;
$$;

create trigger action_policies_guard before update on action_policies
  for each row execute function os_guard_policy_change();
