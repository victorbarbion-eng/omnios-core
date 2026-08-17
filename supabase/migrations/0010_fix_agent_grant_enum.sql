-- =============================================================
-- 0010_fix_agent_grant_enum.sql
--
-- Bug in 0009: the guard compared agents.status to 'disabled', which
-- is not a value in the agent_status enum. The real values are
-- offline, idle, running, paused, error. Postgres raised
--   22P02 invalid input value for enum agent_status: "disabled"
-- on EVERY insert of an agent-assigned job, so 0009 did not enforce
-- the grant — it blocked all assigned work outright.
--
-- Caught by the test suite before any real use. Worth noting the
-- failure mode: the guard failed closed rather than open, so nothing
-- was ever wrongly permitted. That is the right direction to fail, but
-- it was still broken.
--
-- 'paused' is the deliberate per-agent off switch. 'offline' just
-- means the runner is not currently connected, which is normal for a
-- laptop and must NOT stop work being queued for it.
-- =============================================================

create or replace function os_guard_agent_grant() returns trigger
language plpgsql as $$
declare
  v_allowed_actions text[];
  v_scope           uuid[];
  v_agent_name      text;
  v_agent_status    agent_status;
begin
  if new.agent_id is null then
    return new;   -- unassigned job; nothing to check against yet
  end if;

  select allowed_actions, allowed_project_scope, name, status
    into v_allowed_actions, v_scope, v_agent_name, v_agent_status
    from agents
   where id = new.agent_id;

  if not found then
    raise exception 'OMNIOS_UNKNOWN_AGENT: job references agent % which does not exist.', new.agent_id
      using errcode = 'foreign_key_violation';
  end if;

  -- A paused agent is a deliberate off switch for one worker, distinct
  -- from the system-wide emergency pause. 'offline' is not a block: a
  -- laptop is offline most of the time and queued work waits for it.
  if v_agent_status = 'paused' then
    raise exception
      'OMNIOS_AGENT_PAUSED: agent "%" is paused and cannot be assigned new work. Set its status to idle to resume.', v_agent_name
      using errcode = 'insufficient_privilege';
  end if;

  if v_allowed_actions is null or array_length(v_allowed_actions, 1) is null then
    raise exception
      'OMNIOS_AGENT_NOT_GRANTED: agent "%" has an empty allowed_actions list, which means no permissions, not all permissions. Refusing job type "%".',
      v_agent_name, new.job_type
      using errcode = 'insufficient_privilege';
  end if;

  if not (new.job_type = any (v_allowed_actions)) then
    raise exception
      'OMNIOS_AGENT_NOT_GRANTED: agent "%" is not permitted to run job type "%". Add it to that agent''s allowed_actions after review.',
      v_agent_name, new.job_type
      using errcode = 'insufficient_privilege';
  end if;

  -- Empty scope array = every project belonging to this owner.
  if v_scope is not null
     and array_length(v_scope, 1) is not null
     and new.project_id is not null
     and not (new.project_id = any (v_scope)) then
    raise exception
      'OMNIOS_AGENT_OUT_OF_SCOPE: agent "%" is not scoped to project %.',
      v_agent_name, new.project_id
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function os_guard_agent_grant is
  'Enforces agents.allowed_actions, allowed_project_scope and the paused off switch in the database, so a client that skips the TypeScript policy check still cannot queue work its agent record does not permit.';
