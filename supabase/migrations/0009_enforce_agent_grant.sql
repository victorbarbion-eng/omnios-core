-- =============================================================
-- 0009_enforce_agent_grant.sql
--
-- Gap found while documenting the build: agents.allowed_actions and
-- agents.allowed_project_scope were stored in the database but only
-- checked by the TypeScript policy engine in the runner. Any client
-- holding the service-role key could therefore queue a job type its
-- agent record does not permit, simply by not running that check.
--
-- The whole reason enforcement lives in the database is so that a
-- future worker written by someone else — or a careless script — obeys
-- the same rules without being trusted to. A grant that only the
-- client enforces is documentation, not a control. This migration
-- moves it to where it belongs.
--
-- Two rules, applied when a job is created or its agent is changed:
--   1. job_type must appear in the assigned agent's allowed_actions
--   2. project_id must be within allowed_project_scope, where an empty
--      scope array means "all of this owner's projects"
--
-- Jobs with no agent_id are unassigned work and are unaffected.
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

  -- A disabled agent is a deliberate off switch for one worker,
  -- distinct from the system-wide emergency pause.
  if v_agent_status = 'disabled' then
    raise exception
      'OMNIOS_AGENT_DISABLED: agent "%" is disabled and cannot be assigned new work.', v_agent_name
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
  'Enforces agents.allowed_actions and allowed_project_scope in the database, so a client that skips the TypeScript policy check still cannot queue work its agent record does not permit.';

drop trigger if exists jobs_guard_agent_grant on jobs;
create trigger jobs_guard_agent_grant
  before insert or update of agent_id, job_type on jobs
  for each row execute function os_guard_agent_grant();
