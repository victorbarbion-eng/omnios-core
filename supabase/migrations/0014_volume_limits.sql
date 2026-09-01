-- =============================================================
-- 0014_volume_limits.sql
--
-- Every guard so far answers "is this action allowed?" None answers
-- "how many of them?" — and agentic systems fail by quantity at least
-- as often as by one bad action.
--
-- The failure this prevents is not an agent doing something forbidden.
-- It is an agent doing something PERMITTED ten thousand times: a loop
-- that queues research jobs forever, a retry storm, a misread instruction
-- that turns one task into a fan-out. The approval gate is silent about
-- all of it, correctly — each individual job really is allowed. There is
-- no bad row to catch. The badness is only visible in aggregate, which
-- means it needs a control that can see aggregates.
--
-- TWO LIMITS, deliberately different in kind.
--
-- 1. A DAILY BUDGET per risk class. How much may happen in a day. This
--    is the blunt one and the one that catches runaway loops.
-- 2. A CONCURRENCY limit per agent. How much may happen at once. This
--    is what `max_concurrent_jobs` has always promised in
--    system_settings while nothing read it.
--
-- Demo and test rows (is_demo = true) do not consume budget. Otherwise
-- running the guard suite a few times would exhaust the allowance and
-- the tests would start failing for reasons unrelated to what they test.
--
-- A NOTE ON DEFAULTS. These are starting numbers, not researched ones.
-- They are set where an ordinary day passes unnoticed and a runaway loop
-- hits a wall within minutes. Tune them by watching what you actually
-- use; a limit that fires during normal work trains you to raise it
-- without reading, which is the approval-fatigue failure wearing a
-- different hat.
-- =============================================================

create table if not exists usage_budgets (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null,
  risk_level   risk_class not null,
  max_per_day  integer not null,
  -- Why this number. Future-you will want to know whether a limit was
  -- considered or copied.
  rationale    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint usage_budgets_unique_per_owner unique (owner_id, risk_level),
  constraint usage_budgets_positive check (max_per_day >= 0)
);

comment on table usage_budgets is
  'How many jobs of each risk class may be created per day, per owner. Catches the failure an approval gate cannot see: a permitted action repeated far too many times.';

alter table usage_budgets enable row level security;

-- Idempotent by construction. A migration that only works on a virgin
-- database is a migration you cannot safely re-run while developing it,
-- and the first version of this file aborted halfway through on a second
-- apply — leaving the budget trigger below uncreated while every earlier
-- statement had succeeded. Everything looked configured and the control
-- did nothing.
drop policy if exists usage_budgets_owner_reads on usage_budgets;
create policy usage_budgets_owner_reads on usage_budgets
  for select using (owner_id = auth.uid());

drop trigger if exists usage_budgets_touch_updated_at on usage_budgets;
create trigger usage_budgets_touch_updated_at
  before update on usage_budgets
  for each row execute function os_touch_updated_at();

-- Counting is by (owner, day, risk), so index that shape.
create index if not exists jobs_owner_created_idx
  on jobs (owner_id, created_at)
  where is_demo = false;

-- ---- Defaults, applied to every existing owner ---------------
-- Generous on reading, tight on anything that leaves the building.
insert into usage_budgets (owner_id, risk_level, max_per_day, rationale)
select o.owner_id, v.risk_level, v.max_per_day, v.rationale
  from (select distinct owner_id from projects) o
 cross join (values
   ('read'::risk_class,              500, 'Reading is cheap and reversible; the limit exists only to bound a runaway loop.'),
   ('internal_write'::risk_class,    200, 'Writes inside our own system. Recoverable, but a loop here fills the database with noise.'),
   ('external_draft'::risk_class,     50, 'Drafting sends nothing, but fifty drafts a day is already more than anyone reads.'),
   ('approval_required'::risk_class,  20, 'Each one costs a human decision. Twenty a day is the edge of what can be read properly rather than waved through.'),
   ('prohibited'::risk_class,          0, 'Belt and braces. os_guard_jobs already refuses these outright.')
 ) as v(risk_level, max_per_day, rationale)
on conflict (owner_id, risk_level) do nothing;

-- ---- Every owner gets budgets, including future ones ---------
-- The seed above only reaches owners who exist today. Without this, the
-- next person to create a project gets no budget rows, the guard fails
-- open for them, and the whole control quietly does nothing — the worst
-- kind of failure, because the table exists and looks configured.
create or replace function os_ensure_owner_budgets() returns trigger
language plpgsql as $$
begin
  insert into usage_budgets (owner_id, risk_level, max_per_day, rationale)
  select new.owner_id, v.risk_level, v.max_per_day, v.rationale
    from (values
      ('read'::risk_class,              500, 'Reading is cheap and reversible; the limit exists only to bound a runaway loop.'),
      ('internal_write'::risk_class,    200, 'Writes inside our own system. Recoverable, but a loop here fills the database with noise.'),
      ('external_draft'::risk_class,     50, 'Drafting sends nothing, but fifty drafts a day is already more than anyone reads.'),
      ('approval_required'::risk_class,  20, 'Each one costs a human decision. Twenty a day is the edge of what can be read properly rather than waved through.'),
      ('prohibited'::risk_class,          0, 'Belt and braces. os_guard_jobs already refuses these outright.')
    ) as v(risk_level, max_per_day, rationale)
  on conflict (owner_id, risk_level) do nothing;
  return new;
end;
$$;

comment on function os_ensure_owner_budgets is
  'Gives a new owner default budgets the first time they create a project, so the limit is never silently absent for someone who joined after the migration ran.';

drop trigger if exists projects_ensure_budgets on projects;
create trigger projects_ensure_budgets
  after insert on projects
  for each row execute function os_ensure_owner_budgets();

-- ---- Daily budget guard --------------------------------------
create or replace function os_guard_job_budget() returns trigger
language plpgsql as $$
declare
  v_risk  risk_class;
  v_max   integer;
  v_used  integer;
begin
  -- Test and demo rows are exempt. Without this, running the guard
  -- suite would consume a real allowance and tests would fail for
  -- reasons that have nothing to do with what they assert.
  if new.is_demo then
    return new;
  end if;

  v_risk := os_risk_level(new.job_type);

  select max_per_day into v_max
    from usage_budgets
   where owner_id = new.owner_id and risk_level = v_risk;

  -- No budget row means no limit configured for this owner. Fail OPEN
  -- here, deliberately: this control exists to stop runaway volume, not
  -- to become a new way for ordinary work to mysteriously stop. A
  -- missing row is a configuration gap, and turning it into a refusal
  -- would make adding a new owner silently break everything they do.
  if v_max is null then
    return new;
  end if;

  select count(*) into v_used
    from jobs
   where owner_id = new.owner_id
     and is_demo = false
     and created_at >= date_trunc('day', now())
     and os_risk_level(job_type) = v_risk;

  if v_used >= v_max then
    raise exception
      'OMNIOS_BUDGET_EXCEEDED: % jobs of risk class % already created today, and the daily budget is %. Nothing is wrong with this job in particular; there have simply been too many. Raise the budget in usage_budgets if this is legitimate, and look at what is queueing them if it is not.',
      v_used, v_risk, v_max
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function os_guard_job_budget is
  'Refuses job creation once the owner''s daily allowance for that risk class is spent. Catches quantity, which every other guard is blind to.';

drop trigger if exists jobs_guard_budget on jobs;
create trigger jobs_guard_budget
  before insert on jobs
  for each row execute function os_guard_job_budget();

-- ---- Concurrency, finally enforced ---------------------------
-- max_concurrent_jobs has sat in system_settings since 0003 with nothing
-- reading it. Scoped per AGENT rather than per owner: "how many things
-- may this worker have in flight" is the question that matters, and a
-- per-owner cap would make two workers interfere with each other for no
-- reason.
create or replace function os_agent_at_capacity(p_agent_id uuid) returns boolean
language plpgsql stable as $$
declare
  v_max  integer;
  v_open integer;
begin
  select coalesce((value::text)::integer, 2) into v_max
    from system_settings where key = 'max_concurrent_jobs';
  if v_max is null then
    v_max := 2;
  end if;

  select count(*) into v_open
    from jobs
   where leased_by = p_agent_id
     and status in ('claimed', 'running');

  return v_open >= v_max;
end;
$$;

comment on function os_agent_at_capacity is
  'True when this agent already holds max_concurrent_jobs leased jobs in claimed or running. Counts leases only, so pre-0011 clients that never lease are unaffected.';

create or replace function os_claim_job(
  p_job_id         uuid,
  p_agent_id       uuid,
  p_lease_seconds  integer default 60
)
returns jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job     jobs;
  v_id      uuid;
  v_seconds integer;
  v_agent   agents;
begin
  v_seconds := least(greatest(coalesce(p_lease_seconds, 60), 10), 3600);

  select * into v_agent from agents where id = p_agent_id;
  if not found then
    raise exception 'OMNIOS_UNKNOWN_AGENT: no agent with id %.', p_agent_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_agent.status = 'paused' then
    raise exception 'OMNIOS_AGENT_PAUSED: agent "%" is paused and may not claim work.', v_agent.name
      using errcode = 'insufficient_privilege';
  end if;

  if os_agent_at_capacity(p_agent_id) then
    raise exception
      'OMNIOS_AT_CAPACITY: agent "%" already holds max_concurrent_jobs jobs in claimed or running. Finish one before claiming another.', v_agent.name
      using errcode = 'check_violation';
  end if;

  select j.id into v_id
    from jobs j
   where j.id = p_job_id
     and j.status = 'queued'
     and j.job_type = any (v_agent.allowed_actions)
     and (
       v_agent.allowed_project_scope is null
       or array_length(v_agent.allowed_project_scope, 1) is null
       or j.project_id = any (v_agent.allowed_project_scope)
     )
     and (not os_emergency_pause() or os_risk_level(j.job_type) = 'read')
   for update skip locked;

  if v_id is null then
    return null;
  end if;

  perform set_config('omnios.claimant_agent_id', p_agent_id::text, true);

  update jobs
     set status           = 'claimed',
         leased_by        = p_agent_id,
         lease_expires_at = now() + make_interval(secs => v_seconds),
         lease_count      = lease_count + 1,
         claimed_at       = coalesce(claimed_at, now())
   where id = v_id
   returning * into v_job;

  return v_job;
end;
$$;

create or replace function os_claim_next_job(
  p_agent_id       uuid,
  p_lease_seconds  integer default 60,
  p_owner_id       uuid    default null
)
returns jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job     jobs;
  v_id      uuid;
  v_seconds integer;
  v_agent   agents;
begin
  v_seconds := least(greatest(coalesce(p_lease_seconds, 60), 10), 3600);

  select * into v_agent from agents where id = p_agent_id;
  if not found then
    raise exception 'OMNIOS_UNKNOWN_AGENT: no agent with id %.', p_agent_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_agent.status = 'paused' then
    raise exception 'OMNIOS_AGENT_PAUSED: agent "%" is paused and may not claim work.', v_agent.name
      using errcode = 'insufficient_privilege';
  end if;

  -- Returns null rather than raising: a queue consumer asking "anything
  -- for me?" while already full should be told "nothing right now", not
  -- handed an exception to interpret.
  if os_agent_at_capacity(p_agent_id) then
    return null;
  end if;

  select j.id into v_id
    from jobs j
   where j.status = 'queued'
     and (p_owner_id is null or j.owner_id = p_owner_id)
     and j.job_type = any (v_agent.allowed_actions)
     and (
       v_agent.allowed_project_scope is null
       or array_length(v_agent.allowed_project_scope, 1) is null
       or j.project_id = any (v_agent.allowed_project_scope)
     )
     and (not os_emergency_pause() or os_risk_level(j.job_type) = 'read')
   order by j.queued_at
   limit 1
   for update skip locked;

  if v_id is null then
    return null;
  end if;

  perform set_config('omnios.claimant_agent_id', p_agent_id::text, true);

  update jobs
     set status           = 'claimed',
         leased_by        = p_agent_id,
         lease_expires_at = now() + make_interval(secs => v_seconds),
         lease_count      = lease_count + 1,
         claimed_at       = coalesce(claimed_at, now())
   where id = v_id
   returning * into v_job;

  return v_job;
end;
$$;

revoke all on function os_claim_job(uuid, uuid, integer) from public;
grant execute on function os_claim_job(uuid, uuid, integer) to service_role;
revoke all on function os_claim_next_job(uuid, integer, uuid) from public;
grant execute on function os_claim_next_job(uuid, integer, uuid) to service_role;
