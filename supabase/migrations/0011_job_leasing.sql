-- =============================================================
-- 0011_job_leasing.sql
--
-- Closes the highest-ranked item in docs/known-limitations.md:
--   "There is no job leasing, heartbeat, or atomic queue claim.
--    Two concurrent runners could race to claim the same queued job."
--
-- The race is real and none of the existing guards catch it. The
-- state machine is satisfied (queued -> claimed is legal, twice over),
-- the approval gate is satisfied (one approval covers both copies),
-- and the idempotency key does not help because it is unique per JOB,
-- not per CLAIM. This is not a guard that was wrong; it is a guard
-- that was never written.
--
-- Three pieces, all in the database, so a future VPS worker inherits
-- them without being trusted to implement anything:
--
--   os_claim_next_job()      atomic claim, one winner, no waiting
--   os_heartbeat_job()       renew a lease, and honour the pause
--   os_reap_expired_leases() recover work abandoned mid-flight
--
-- DESIGN NOTE — why an expired lease is reaped rather than re-claimed.
-- The obvious move is to let a second worker pick up a job still
-- sitting in 'running' with a dead lease. That would require a new
-- running -> claimed transition, which weakens the state machine for
-- every other caller in order to serve one case. Instead an abandoned
-- job takes the path that already exists and is already audited:
-- running -> failed -> queued, with attempt_count incremented, so
-- bounded retries (OMNIOS_RETRY_LIMIT) still apply and a job that is
-- abandoned repeatedly stops rather than looping forever.
--
-- COMPATIBILITY — this migration is additive. A job with no lease
-- behaves exactly as before, so the existing local runner, which does
-- not lease, keeps working unchanged. The new guard only fires when a
-- LIVE lease exists and someone other than its holder tries to
-- advance the job.
-- =============================================================

-- ---- Lease columns -------------------------------------------
alter table jobs
  add column if not exists leased_by         uuid references agents (id) on delete set null,
  add column if not exists lease_expires_at  timestamptz,
  add column if not exists lease_count       integer not null default 0;

comment on column jobs.leased_by is
  'Agent currently holding the claim. Distinct from agent_id, which is the agent the job was ASSIGNED to when queued; a job may be assigned to nobody and leased by whoever claims it first.';
comment on column jobs.lease_expires_at is
  'When this claim lapses. A worker must call os_heartbeat_job() before this passes or the job is reaped and requeued.';
comment on column jobs.lease_count is
  'How many times this job has been claimed. A number climbing well past 1 means workers keep dying mid-job.';

-- Partial index matching the claim query exactly.
create index if not exists jobs_claimable_idx
  on jobs (queued_at)
  where status = 'queued';

-- Supports the reaper without scanning completed history.
create index if not exists jobs_live_lease_idx
  on jobs (lease_expires_at)
  where status in ('claimed', 'running') and lease_expires_at is not null;

-- ---- Guard: only the lease holder may advance a leased job ----
-- Deliberately narrow. If lease_expires_at is null the job is not
-- leased and nothing here applies, which is what keeps the existing
-- runner working. If the lease has lapsed, the reaper owns the job,
-- not the stale worker.
create or replace function os_guard_job_lease() returns trigger
language plpgsql as $$
declare
  v_claimant uuid;
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  -- Unleased job: pre-0011 behaviour, unchanged.
  if old.lease_expires_at is null then
    return new;
  end if;

  -- The reaper and the lease holder both legitimately write here.
  -- Anyone else advancing a job whose lease is still live is a second
  -- worker that thinks it owns work it does not own.
  if old.lease_expires_at > now()
     and new.status is distinct from old.status
     and old.leased_by is not null then

    v_claimant := nullif(current_setting('omnios.claimant_agent_id', true), '')::uuid;

    if v_claimant is distinct from old.leased_by then
      raise exception
        'OMNIOS_LEASE_HELD: job % is leased by agent % until %. Set omnios.claimant_agent_id to that agent to advance it, or wait for the lease to lapse.',
        new.id, old.leased_by, old.lease_expires_at
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

comment on function os_guard_job_lease is
  'Refuses a status change on a job whose lease is live and held by a different agent. Only fires for leased jobs, so unleased work behaves exactly as it did before 0011.';

-- Runs before the main job guard so a lease violation is reported
-- ahead of any transition or approval complaint.
drop trigger if exists jobs_lease_guard on jobs;
create trigger jobs_lease_guard
  before update on jobs
  for each row execute function os_guard_job_lease();

-- ---- Atomic claim --------------------------------------------
-- The whole point is on the `for update skip locked` line. Finding a
-- job and claiming it is ONE statement, so there is no instant in
-- which two workers can both see the same row as available. A second
-- worker asking at the same moment skips the locked row and takes the
-- next one instead of blocking behind it.
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
  v_job      jobs;
  v_id       uuid;
  v_seconds  integer;
  v_agent    agents;
begin
  -- Clamp rather than trust. A zero-second lease would make every job
  -- instantly reapable; a week-long one makes the reaper useless.
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

  -- One statement: find, lock, skip anything another worker holds.
  select j.id into v_id
    from jobs j
   where j.status = 'queued'
     and (p_owner_id is null or j.owner_id = p_owner_id)
     -- Only work this agent is actually granted. The same rule the
     -- insert guard applies, applied again at claim time, because the
     -- grant may have been narrowed since the job was queued.
     and j.job_type = any (v_agent.allowed_actions)
     and (
       v_agent.allowed_project_scope is null
       or array_length(v_agent.allowed_project_scope, 1) is null
       or j.project_id = any (v_agent.allowed_project_scope)
     )
     -- While paused, only read-class work may start. Same rule as the
     -- job guard; enforced here too so a paused system hands out
     -- nothing rather than handing out a job that then fails.
     and (not os_emergency_pause() or os_risk_level(j.job_type) = 'read')
   order by j.queued_at
   limit 1
   for update skip locked;

  if v_id is null then
    return null;   -- nothing available for this agent right now
  end if;

  -- Announce who is doing this so os_guard_job_lease lets it through
  -- on subsequent heartbeats and status changes.
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

comment on function os_claim_next_job is
  'Atomically claims the oldest queued job this agent is granted, using FOR UPDATE SKIP LOCKED so concurrent workers never collide. Returns null when nothing is available.';

revoke all on function os_claim_next_job(uuid, integer, uuid) from public;
grant execute on function os_claim_next_job(uuid, integer, uuid) to service_role;

-- ---- Heartbeat, which is also the kill switch ----------------
-- Renewing a lease is the moment a running worker checks in with the
-- database, which makes it the natural place to tell it to stop. This
-- is what closes the second half of the emergency-pause gap recorded
-- in docs/known-limitations.md: the pause could stop jobs STARTING
-- but not jobs already RUNNING. A worker that heartbeats can now be
-- refused mid-flight and is expected to abort.
create or replace function os_heartbeat_job(
  p_job_id         uuid,
  p_agent_id       uuid,
  p_lease_seconds  integer default 60
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job      jobs;
  v_seconds  integer;
  v_new_exp  timestamptz;
begin
  v_seconds := least(greatest(coalesce(p_lease_seconds, 60), 10), 3600);

  select * into v_job from jobs where id = p_job_id for update;
  if not found then
    raise exception 'OMNIOS_UNKNOWN_JOB: no job with id %.', p_job_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_job.leased_by is distinct from p_agent_id then
    raise exception
      'OMNIOS_LEASE_NOT_HELD: job % is leased by % , not by %. Stop working on it.',
      p_job_id, coalesce(v_job.leased_by::text, 'nobody'), p_agent_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_job.status not in ('claimed', 'running') then
    raise exception
      'OMNIOS_LEASE_NOT_ACTIVE: job % is %, so there is no live lease to renew.', p_job_id, v_job.status
      using errcode = 'check_violation';
  end if;

  -- Cooperative cancellation. Refuse the renewal and the worker knows
  -- to stop. Read-class work continues, because a pause that blinds
  -- you is a bad pause.
  if os_emergency_pause() and os_risk_level(v_job.job_type) <> 'read' then
    raise exception
      'OMNIOS_EMERGENCY_PAUSE: system is paused. Abort job % now and leave it for the reaper.', p_job_id
      using errcode = 'check_violation';
  end if;

  v_new_exp := now() + make_interval(secs => v_seconds);

  perform set_config('omnios.claimant_agent_id', p_agent_id::text, true);
  update jobs set lease_expires_at = v_new_exp where id = p_job_id;

  return v_new_exp;
end;
$$;

comment on function os_heartbeat_job is
  'Renews a lease held by this agent, and refuses while the emergency pause is engaged for non-read work — which is how a running job learns it must stop.';

revoke all on function os_heartbeat_job(uuid, uuid, integer) from public;
grant execute on function os_heartbeat_job(uuid, uuid, integer) to service_role;

-- ---- Reaper ---------------------------------------------------
-- Recovers work whose worker vanished: laptop lid closed, process
-- killed, network gone. Takes the existing audited path rather than
-- inventing a transition, so attempt_count and the retry limit keep
-- their meaning.
create or replace function os_reap_expired_leases()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r        record;
  v_count  integer := 0;
begin
  for r in
    select id, status, attempt_count, max_attempts, leased_by, lease_expires_at
      from jobs
     where status in ('claimed', 'running')
       and lease_expires_at is not null
       and lease_expires_at < now()
     for update skip locked
  loop
    -- The reaper speaks for the dead worker, so the lease guard lets
    -- this through rather than treating it as a rival claimant.
    perform set_config('omnios.claimant_agent_id', coalesce(r.leased_by::text, ''), true);

    update jobs
       set status        = 'failed',
           error_summary = format(
             'OMNIOS_LEASE_EXPIRED: lease held by %s lapsed at %s with the job still %s; no heartbeat was received.',
             coalesce(r.leased_by::text, 'unknown agent'), r.lease_expires_at, r.status),
           -- Clamped to max_attempts, NOT max_attempts + 1: the job
           -- guard raises OMNIOS_RETRY_LIMIT when attempt_count
           -- exceeds max_attempts, and the reaper tripping its own
           -- system's retry guard would abort the recovery it exists
           -- to perform. Termination is handled by the requeue test
           -- below instead.
           attempt_count = least(r.attempt_count + 1, r.max_attempts),
           leased_by     = null,
           lease_expires_at = null
     where id = r.id;

    -- Requeue only while attempts remain. Past that it stays failed,
    -- which is what OMNIOS_RETRY_LIMIT already promises.
    if r.attempt_count + 1 <= r.max_attempts then
      update jobs
         set status      = 'queued',
             claimed_at  = null,
             started_at  = null,
             finished_at = null
       where id = r.id;
    end if;

    v_count := v_count + 1;
  end loop;

  perform set_config('omnios.claimant_agent_id', '', true);
  return v_count;
end;
$$;

comment on function os_reap_expired_leases is
  'Fails and (while attempts remain) requeues jobs whose lease lapsed without a heartbeat. Uses the existing running -> failed -> queued path so attempt_count and the retry limit keep their meaning.';

revoke all on function os_reap_expired_leases() from public;
grant execute on function os_reap_expired_leases() to service_role;
