-- =============================================================
-- 0012_lease_claim_by_agent.sql
--
-- Makes 0011's leasing usable by a real worker. Two gaps showed up the
-- moment the runner was wired to it, and both are about the difference
-- between a direct database session and PostgREST.
--
-- GAP 1 — the lease guard was unreachable over the API.
--   os_guard_job_lease() identified the claimant from
--   current_setting('omnios.claimant_agent_id'), which os_claim_next_job()
--   sets with set_config(..., true) — transaction-local. Over a direct
--   psql session that survives to the next statement, which is why the
--   guard tests passed. Over PostgREST every request is its own
--   transaction, so the setting was always empty by the time the runner
--   sent `update jobs set status = 'running'`, and the guard refused the
--   lease holder's own job with OMNIOS_LEASE_HELD.
--
--   The fix follows the pattern os_actor_name() already established in
--   0006: GUC first, then the request header. The runner already sends
--   `x-omnios-actor-name`, so no client change is needed — the guard
--   resolves that name to an agent id and compares it to leased_by.
--
--   Be precise about what this is worth. Like x-omnios-actor, the header
--   is caller-controlled, so a second worker holding the service-role key
--   could claim to be the first. That is acceptable here and it is worth
--   saying why: this guard exists to stop two COOPERATING workers
--   colliding, which is the failure that actually happens. It is not an
--   authority check and never was — nothing here grants permission.
--   Authority still comes from auth.uid() alone, and a forged name gets
--   an attacker exactly nothing it did not already have with that key.
--   Attribution-grade protection for an attribution-grade problem.
--
-- GAP 2 — there was no way to claim ONE named job.
--   os_claim_next_job() takes the oldest queued job for an agent, which
--   is right for a general queue consumer and wrong for the demo runner,
--   which creates a specific job and must then run that one. Without a
--   targeted claim the runner would fall back to a plain update and skip
--   leasing altogether, which defeats the point.
--
--   os_claim_job() is the same atomic pattern applied to a single row:
--   `for update skip locked` on that job, so if another worker holds it
--   this call returns null immediately rather than blocking or stealing.
-- =============================================================

-- ---- Claimant resolution: GUC, then request header -----------
create or replace function os_lease_claimant(p_owner uuid) returns uuid
language plpgsql stable as $$
declare
  v_id   uuid;
  v_name text;
begin
  -- 1. Direct database session: os_claim_next_job / the reaper set this.
  v_id := nullif(current_setting('omnios.claimant_agent_id', true), '')::uuid;
  if v_id is not null then
    return v_id;
  end if;

  -- 2. PostgREST: resolve the worker's declared name to its agent row.
  v_name := os_actor_name();
  if v_name is null then
    return null;
  end if;

  select id into v_id from agents where name = v_name and owner_id = p_owner;
  return v_id;
exception when others then
  return null;   -- unreadable claim is no claim; the guard then refuses
end;
$$;

comment on function os_lease_claimant is
  'Which agent is speaking, for lease ownership only. GUC first (direct session), then the x-omnios-actor-name header resolved against agents.name. Attribution, never authority: a forged name cannot grant anything, it can only let one service-role holder advance another one''s leased job.';

create or replace function os_guard_job_lease() returns trigger
language plpgsql as $$
declare
  v_claimant uuid;
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  if old.lease_expires_at is null then
    return new;   -- unleased job: pre-0011 behaviour, unchanged
  end if;

  if old.lease_expires_at > now()
     and new.status is distinct from old.status
     and old.leased_by is not null then

    v_claimant := os_lease_claimant(old.owner_id);

    if v_claimant is distinct from old.leased_by then
      raise exception
        'OMNIOS_LEASE_HELD: job % is leased by agent % until %. Only that agent may advance it; wait for the lease to lapse or let the reaper requeue it.',
        new.id, old.leased_by, old.lease_expires_at
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

-- ---- Targeted atomic claim -----------------------------------
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

  -- Lock this one row. skip locked means a worker that already holds it
  -- makes us return empty-handed instead of queueing behind it.
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
    return null;   -- already claimed, not queued, not granted, or paused out
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

comment on function os_claim_job is
  'Atomically claims ONE named job for an agent, or returns null if it is not claimable. Same FOR UPDATE SKIP LOCKED guarantee as os_claim_next_job, for workers that already know which job they want.';

revoke all on function os_claim_job(uuid, uuid, integer) from public;
grant execute on function os_claim_job(uuid, uuid, integer) to service_role;
