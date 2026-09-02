-- =============================================================
-- tests/db_guards.sql
--
-- Proves the database enforces the autonomy policy even against a
-- connection that bypasses row-level security. Creates its own
-- fixtures, asserts, then cleans up after itself.
--
-- Usage:
--   1. run this file (creates function public.os_selftest)
--   2. select * from os_selftest();
--   3. drop function os_selftest();
-- =============================================================

create or replace function public.os_selftest()
returns table (test text, passed boolean, detail text)
language plpgsql
as $fn$
declare
  owner_a  uuid := '00000000-0000-0000-0000-0000000000aa';
  owner_b  uuid := '00000000-0000-0000-0000-0000000000bb';
  p_id     uuid;
  ag_id    uuid;
  j_read   uuid;
  j_write  uuid;
  j_send   uuid;
  ap_id    uuid;
  ap_old   uuid;
  n        integer;
  before_n bigint;
  -- 0011 leasing fixtures
  ag_rival uuid;
  j_lease  uuid;
  j_reap   uuid;
  lease_a  jobs;
  lease_b  jobs;
  exp_1    timestamptz;
  exp_2    timestamptz;
  j_bind   uuid;
  ap_bind  uuid;
  ap_rls   uuid;
begin
  -- ---------- fixtures ----------
  delete from projects where slug in ('selftest-project', 'selftest-other');

  insert into projects (owner_id, name, slug, description, is_demo)
  values (owner_a, 'SELFTEST project', 'selftest-project', 'temporary test fixture', true)
  returning id into p_id;

  insert into projects (owner_id, name, slug, description, is_demo)
  values (owner_b, 'SELFTEST other owner', 'selftest-other', 'temporary test fixture', true);

  insert into agents (owner_id, name, role, allowed_actions, is_demo)
  values (owner_a, 'selftest-runner', 'test runner',
          array['read_source','research_topic','send_message'], true)
  returning id into ag_id;

  -- ============ 1. prohibited action cannot be queued ============
  begin
    insert into jobs (owner_id, project_id, agent_id, job_type, idempotency_key, is_demo)
    values (owner_a, p_id, ag_id, 'exfiltrate_secrets', 'selftest:prohibited', true);
    test := '01 prohibited action refused at insert'; passed := false;
    detail := 'FAIL: a prohibited job was accepted'; return next;
  exception when others then
    test := '01 prohibited action refused at insert';
    passed := sqlerrm like 'OMNIOS_PROHIBITED%';
    detail := sqlerrm; return next;
  end;

  -- ============ fixtures: three jobs ============
  insert into jobs (owner_id, project_id, agent_id, job_type, idempotency_key, is_demo)
  values (owner_a, p_id, ag_id, 'read_source', 'selftest:read', true) returning id into j_read;

  insert into jobs (owner_id, project_id, agent_id, job_type, idempotency_key, is_demo)
  values (owner_a, p_id, ag_id, 'research_topic', 'selftest:write', true) returning id into j_write;

  insert into jobs (owner_id, project_id, agent_id, job_type, idempotency_key, is_demo)
  values (owner_a, p_id, ag_id, 'send_message', 'selftest:send', true) returning id into j_send;

  -- ============ 2. illegal state transition ============
  begin
    update jobs set status = 'completed' where id = j_write;
    test := '02 queued cannot jump straight to completed'; passed := false;
    detail := 'FAIL: transition accepted'; return next;
  exception when others then
    test := '02 queued cannot jump straight to completed';
    passed := sqlerrm like 'OMNIOS_BAD_TRANSITION%';
    detail := sqlerrm; return next;
  end;

  -- ============ 3. legal transitions work ============
  begin
    update jobs set status = 'claimed' where id = j_write;
    update jobs set status = 'running' where id = j_write;
    select count(*) into n from jobs
     where id = j_write and status = 'running' and claimed_at is not null and started_at is not null;
    test := '03 auto_allowed job runs, timestamps auto-filled';
    passed := (n = 1);
    detail := format('running=%s with claimed_at and started_at set', n); return next;
  exception when others then
    test := '03 auto_allowed job runs, timestamps auto-filled';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  -- ============ 4. approval gate blocks execution ============
  update jobs set status = 'claimed' where id = j_send;
  begin
    update jobs set status = 'running' where id = j_send;
    test := '04 approval_required job cannot run unapproved'; passed := false;
    detail := 'FAIL: gated job started without approval'; return next;
  exception when others then
    test := '04 approval_required job cannot run unapproved';
    passed := sqlerrm like 'OMNIOS_APPROVAL_REQUIRED%';
    detail := sqlerrm; return next;
  end;

  -- ============ 5. no human session => cannot approve ============
  update jobs set status = 'awaiting_approval' where id = j_send;

  insert into approvals (owner_id, project_id, requested_by_agent_id, job_id, action_type,
                         action_preview, target_reference, is_demo)
  values (owner_a, p_id, ag_id, j_send, 'send_message',
          'Send a test email to nobody@example.invalid', 'email:nobody@example.invalid', true)
  returning id into ap_id;

  begin
    -- This connection has no end-user session, exactly like the
    -- service-role key the local agent uses.
    update approvals set status = 'approved' where id = ap_id;
    test := '05 approval cannot be granted without a human session'; passed := false;
    detail := 'FAIL: approval granted with auth.uid() null'; return next;
  exception when others then
    test := '05 approval cannot be granted without a human session';
    passed := sqlerrm like 'OMNIOS_HUMAN_SESSION_REQUIRED%';
    detail := sqlerrm; return next;
  end;

  -- ============ 6. self-declared agent cannot approve ============
  begin
    perform set_config('omnios.actor_type', 'agent', true);
    perform set_config('request.jwt.claims', json_build_object('sub', owner_a, 'role', 'authenticated')::text, true);
    update approvals set status = 'approved' where id = ap_id;
    test := '06 agent-attributed traffic cannot approve'; passed := false;
    detail := 'FAIL: agent approved its own request'; return next;
  exception when others then
    test := '06 agent-attributed traffic cannot approve';
    passed := sqlerrm like 'OMNIOS_SELF_APPROVAL_BLOCKED%';
    detail := sqlerrm; return next;
  end;
  perform set_config('omnios.actor_type', 'user', true);

  -- ============ 7. a signed-in user CAN approve, then job runs ====
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', owner_a, 'role', 'authenticated')::text, true);
    update approvals set status = 'approved', decision_note = 'selftest approval' where id = ap_id;

    select count(*) into n from approvals
     where id = ap_id and status = 'approved'
       and decided_at is not null and decided_by = owner_a and decided_by_actor_type = 'user';
    test := '07 signed-in user can approve, decision recorded';
    passed := (n = 1); detail := format('approved rows with full decision trail = %s', n); return next;

    perform set_config('omnios.actor_type', 'agent', true);
    update jobs set status = 'running' where id = j_send;
    update jobs set status = 'completed' where id = j_send;
    select count(*) into n from jobs where id = j_send and status = 'completed' and finished_at is not null;
    test := '08 approved job may then execute';
    passed := (n = 1); detail := format('completed=%s', n); return next;
  exception when others then
    test := '07/08 approve then execute'; passed := false;
    detail := 'FAIL: ' || sqlerrm; return next;
  end;
  perform set_config('omnios.actor_type', 'user', true);

  -- ============ 9. emergency pause ============
  update system_settings set value = 'true'::jsonb where key = 'emergency_pause';

  begin
    update jobs set status = 'claimed' where id = j_read;   -- read class: allowed
    select count(*) into n from jobs where id = j_read and status = 'claimed';
    test := '09 pause still permits read-class work';
    passed := (n = 1); detail := format('read job claimed=%s', n); return next;
  exception when others then
    test := '09 pause still permits read-class work';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  insert into jobs (owner_id, project_id, agent_id, job_type, idempotency_key, is_demo)
  values (owner_a, p_id, ag_id, 'research_topic', 'selftest:paused-write', true);
  begin
    update jobs set status = 'claimed' where idempotency_key = 'selftest:paused-write';
    test := '10 pause blocks write-capable work'; passed := false;
    detail := 'FAIL: write job started while paused'; return next;
  exception when others then
    test := '10 pause blocks write-capable work';
    passed := sqlerrm like 'OMNIOS_EMERGENCY_PAUSE%';
    detail := sqlerrm; return next;
  end;

  update system_settings set value = 'false'::jsonb where key = 'emergency_pause';

  -- ============ 11. audit trail is append-only ============
  begin
    update audit_events set action = 'tampered' where id = (select max(id) from audit_events);
    test := '11 audit events cannot be edited'; passed := false;
    detail := 'FAIL: audit row updated'; return next;
  exception when others then
    test := '11 audit events cannot be edited';
    passed := sqlerrm like 'OMNIOS_AUDIT_APPEND_ONLY%';
    detail := sqlerrm; return next;
  end;

  begin
    delete from audit_events where id = (select max(id) from audit_events);
    test := '12 audit events cannot be deleted'; passed := false;
    detail := 'FAIL: audit row deleted'; return next;
  exception when others then
    test := '12 audit events cannot be deleted';
    passed := sqlerrm like 'OMNIOS_AUDIT_APPEND_ONLY%';
    detail := sqlerrm; return next;
  end;

  -- ============ 13. audit trail actually captured the job path ====
  select count(*) into n from audit_events
   where entity_type = 'jobs' and entity_id = j_send::text and action = 'jobs.status_changed';
  test := '13 job status changes are audited';
  passed := (n >= 3); detail := format('%s status-change events for the gated job', n); return next;

  select count(*) into n from audit_events
   where entity_type = 'approvals' and entity_id = ap_id::text;
  test := '14 approval request and decision are audited';
  passed := (n >= 2); detail := format('%s approval events', n); return next;

  -- ============ 15. policy promotion needs a note ============
  begin
    update action_policies set auto_allowed = true where action_type = 'draft_pull_request';
    -- already auto_allowed, so use a genuinely gated one
    test := '15 setup'; passed := true; detail := 'noop'; return next;
  exception when others then
    test := '15 setup'; passed := true; detail := sqlerrm; return next;
  end;

  begin
    perform set_config('omnios.actor_type', 'user', true);
    update action_policies set auto_allowed = true where action_type = 'send_message';
    test := '16 promotion without a written reason is refused'; passed := false;
    detail := 'FAIL: autonomy widened silently'; return next;
  exception when others then
    test := '16 promotion without a written reason is refused';
    passed := sqlerrm like 'OMNIOS_PROMOTION_NEEDS_NOTE%' or sqlerrm like '%approval_required_is_never_auto%';
    detail := sqlerrm; return next;
  end;

  begin
    perform set_config('omnios.actor_type', 'agent', true);
    -- send_message is known to remain gated. draft_report is already
    -- auto_allowed in the seed policy, so assigning true there did not
    -- exercise the false-to-true promotion guard.
    update action_policies set auto_allowed = true, promoted_note = 'agent trying to widen itself'
     where action_type = 'send_message';
    test := '17 an agent cannot widen its own autonomy'; passed := false;
    detail := 'FAIL: agent promoted an action type'; return next;
  exception when others then
    test := '17 an agent cannot widen its own autonomy';
    passed := sqlerrm like 'OMNIOS_SELF_PROMOTION_BLOCKED%' or sqlerrm like 'OMNIOS_PROMOTION%';
    detail := sqlerrm; return next;
  end;
  perform set_config('omnios.actor_type', 'user', true);

  -- ============ 18. expired approvals ============
  insert into approvals (owner_id, project_id, requested_by_agent_id, action_type,
                         action_preview, target_reference, expires_at, is_demo)
  values (owner_a, p_id, ag_id, 'deploy', 'Deploy something stale', 'vercel:stale',
          now() - interval '1 day', true)
  returning id into ap_old;

  select os_expire_stale_approvals() into n;
  test := '18 stale approvals expire instead of lingering';
  passed := (select status = 'expired' from approvals where id = ap_old);
  detail := format('os_expire_stale_approvals() touched %s row(s)', n); return next;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', owner_a, 'role', 'authenticated')::text, true);
    update approvals set status = 'approved' where id = ap_old;
    test := '19 an expired approval cannot be revived'; passed := false;
    detail := 'FAIL: expired approval granted'; return next;
  exception when others then
    test := '19 an expired approval cannot be revived';
    passed := sqlerrm like 'OMNIOS_NOT_PENDING%' or sqlerrm like 'OMNIOS_EXPIRED%';
    detail := sqlerrm; return next;
  end;

  -- ============ 20. retry limit ============
  begin
    update jobs set attempt_count = 99 where id = j_read;
    test := '20 retry limit is enforced'; passed := false;
    detail := 'FAIL: attempt_count exceeded max_attempts'; return next;
  exception when others then
    test := '20 retry limit is enforced';
    passed := (sqlerrm like 'OMNIOS_RETRY_LIMIT%' or sqlerrm like '%jobs_attempts_sane%');
    detail := sqlerrm; return next;
  end;

  -- ============ 21. idempotency ============
  begin
    insert into jobs (owner_id, project_id, agent_id, job_type, idempotency_key, is_demo)
    values (owner_a, p_id, ag_id, 'read_source', 'selftest:read', true);
    test := '21 duplicate idempotency key is rejected'; passed := false;
    detail := 'FAIL: duplicate job accepted'; return next;
  exception when others then
    test := '21 duplicate idempotency key is rejected';
    passed := sqlerrm like '%jobs_idempotency_unique%' or sqlerrm like '%duplicate key%';
    detail := sqlerrm; return next;
  end;

  -- ============ 22. row-level security isolates owners ============
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', owner_b, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select count(*) into n from projects where slug = 'selftest-project';
    execute 'reset role';
    test := '22 RLS hides another owner''s project';
    passed := (n = 0); detail := format('owner B sees %s of owner A''s projects', n); return next;
  exception when others then
    execute 'reset role';
    test := '22 RLS hides another owner''s project';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', owner_a, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select count(*) into n from projects where slug = 'selftest-project';
    execute 'reset role';
    test := '23 RLS shows an owner their own project';
    passed := (n = 1); detail := format('owner A sees %s', n); return next;
  exception when others then
    execute 'reset role';
    test := '23 RLS shows an owner their own project';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', owner_a, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    delete from projects where slug = 'selftest-project';
    execute 'reset role';
    select count(*) into n from projects where slug = 'selftest-project';
    test := '24 dashboard role cannot delete records';
    passed := (n = 1);
    detail := 'no DELETE policy exists for authenticated, so the row survives'; return next;
  exception when others then
    execute 'reset role';
    test := '24 dashboard role cannot delete records';
    passed := true; detail := 'delete refused: ' || sqlerrm; return next;
  end;

  -- ============ 31. the agent grant is enforced by the database ====
  -- Regression test for 0009: allowed_actions used to be checked only
  -- by the TypeScript runner, so any client with the service-role key
  -- could queue a job type its agent was never granted.
  begin
    insert into jobs (owner_id, project_id, agent_id, job_type, status, idempotency_key, is_demo)
    values (owner_a, p_id, ag_id, 'deploy', 'queued', 'selftest-ungranted-' || gen_random_uuid(), true);
    test := '31 database refuses a job type the agent was not granted';
    passed := false; detail := 'FAIL: ungranted job type was accepted'; return next;
  exception when others then
    test := '31 database refuses a job type the agent was not granted';
    passed := (sqlerrm like '%AGENT_NOT_GRANTED%');
    detail := 'refused: ' || left(sqlerrm, 140); return next;
  end;

  begin
    insert into jobs (owner_id, project_id, agent_id, job_type, status, idempotency_key, is_demo)
    values (owner_a, p_id, ag_id, 'research_topic', 'queued', 'selftest-granted-' || gen_random_uuid(), true);
    test := '32 database accepts a job type the agent was granted';
    passed := true; detail := 'granted job type accepted'; return next;
  exception when others then
    test := '32 database accepts a job type the agent was granted';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  begin
    update agents set status = 'paused' where id = ag_id;
    insert into jobs (owner_id, project_id, agent_id, job_type, status, idempotency_key, is_demo)
    values (owner_a, p_id, ag_id, 'research_topic', 'queued', 'selftest-disabled-' || gen_random_uuid(), true);
    test := '33 a paused agent cannot be given new work';
    passed := false; detail := 'FAIL: paused agent was assigned a job'; return next;
  exception when others then
    test := '33 a paused agent cannot be given new work';
    passed := (sqlerrm like '%AGENT_PAUSED%');
    detail := 'refused: ' || left(sqlerrm, 140); return next;
  end;
  update agents set status = 'idle' where id = ag_id;

  -- ============ 25. actor attribution never yields NULL ============
  -- Regression test for the three-valued-logic bug fixed in 0008:
  -- an unlabelled connection returned NULL and broke every audited
  -- insert on the NOT NULL audit_events.actor_type column.
  begin
    perform set_config('omnios.actor_type', '', true);
    perform set_config('request.headers', '', true);
    test := '25 actor type never null when nothing is declared';
    passed := (os_actor_type() is not null);
    detail := format('unlabelled connection resolves to %s', coalesce(os_actor_type()::text, 'NULL'));
    return next;
  exception when others then
    test := '25 actor type never null when nothing is declared';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  begin
    perform set_config('omnios.actor_type', 'wizard', true);
    test := '26 unrecognised actor label is not promoted to user';
    passed := (os_actor_type() = 'system');
    detail := format('junk label resolves to %s', os_actor_type()::text);
    return next;
  exception when others then
    test := '26 unrecognised actor label is not promoted to user';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  -- ============ 27. key-only API traffic cannot flip the pause ======
  begin
    perform set_config('omnios.actor_type', '', true);
    perform set_config('request.jwt.claims', '', true);
    -- Simulate arriving over PostgREST with no end-user session.
    perform set_config('request.headers', '{"x-omnios-actor":"agent"}', true);
    perform os_set_emergency_pause(true, 'selftest — should be refused');
    test := '27 API key alone cannot engage the emergency pause';
    passed := false; detail := 'FAIL: the pause was changed without a human session'; return next;
  exception when others then
    test := '27 API key alone cannot engage the emergency pause';
    passed := (sqlerrm like '%HUMAN_SESSION_REQUIRED%' or sqlerrm like '%AGENT_BLOCKED%');
    detail := 'refused: ' || left(sqlerrm, 120); return next;
  end;

  -- Confirm the refusal above left the setting untouched.
  begin
    perform set_config('request.headers', '', true);
    perform set_config('omnios.actor_type', 'user', true);
    test := '28 emergency pause still off after refused attempt';
    passed := (os_emergency_pause() = false);
    detail := format('emergency_pause = %s', os_emergency_pause());
    return next;
  exception when others then
    test := '28 emergency pause still off after refused attempt';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  -- =====================================================================
  -- 0011 — job leasing. These test the guard that was never written:
  -- two workers racing for one queued job. The true concurrency proof
  -- needs two real sessions and lives in tests/concurrent_claim.sh;
  -- everything below is the single-session logic around it.
  -- =====================================================================

  perform set_config('omnios.actor_type', 'system', true);
  perform set_config('omnios.claimant_agent_id', '', true);

  -- Empty the queue first. os_claim_next_job takes the OLDEST queued
  -- job, so leftovers from tests 01-33 would be handed out instead of
  -- the fixtures below and every assertion here would be about the
  -- wrong row. queued -> cancelled is a legal transition.
  update jobs set status = 'cancelled'
   where owner_id = owner_a and status = 'queued';

  -- The agent must be back on duty; test 33 left it paused.
  update agents set status = 'idle' where id = ag_id;

  insert into agents (owner_id, name, role, allowed_actions, status, is_demo)
  values (owner_a, 'selftest-rival', 'second worker',
          array['read_source','research_topic'], 'idle', true)
  returning id into ag_rival;

  insert into jobs (owner_id, project_id, job_type, idempotency_key, is_demo)
  values (owner_a, p_id, 'read_source', 'selftest:lease:one', true)
  returning id into j_lease;

  -- ============ 34. an atomic claim takes exactly one job ============
  begin
    lease_a := os_claim_next_job(ag_id, 60, owner_a);
    test := '34 atomic claim returns one job and leases it';
    passed := (lease_a.id = j_lease
               and lease_a.status = 'claimed'
               and lease_a.leased_by = ag_id
               and lease_a.lease_expires_at > now()
               and lease_a.lease_count = 1);
    detail := format('job %s claimed by %s until %s (lease_count=%s)',
                     left(lease_a.id::text, 8), left(lease_a.leased_by::text, 8),
                     lease_a.lease_expires_at, lease_a.lease_count);
    return next;
  exception when others then
    test := '34 atomic claim returns one job and leases it';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  -- ============ 35. the same job is not handed out twice ============
  -- The second worker asking must not receive a job already leased.
  begin
    lease_b := os_claim_next_job(ag_rival, 60, owner_a);
    test := '35 a second claim does not receive the leased job';
    passed := (lease_b.id is null or lease_b.id is distinct from lease_a.id);
    detail := case when lease_b.id is null
                   then 'second worker got nothing, which is correct'
                   when lease_b.id is distinct from lease_a.id
                   then 'second worker got a different job, which is correct'
                   else 'FAIL: second worker got the leased job' end;
    return next;
  exception when others then
    test := '35 a second claim does not receive the leased job';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  -- ============ 36. a rival cannot advance a live-leased job ============
  begin
    perform set_config('omnios.claimant_agent_id', ag_rival::text, true);
    update jobs set status = 'running' where id = j_lease;
    test := '36 a rival worker cannot advance a leased job';
    passed := false; detail := 'FAIL: the rival moved a job it does not hold'; return next;
  exception when others then
    test := '36 a rival worker cannot advance a leased job';
    passed := sqlerrm like 'OMNIOS_LEASE_HELD%';
    detail := left(sqlerrm, 120); return next;
  end;

  -- ============ 37. the lease holder can advance it ============
  begin
    perform set_config('omnios.claimant_agent_id', ag_id::text, true);
    update jobs set status = 'running' where id = j_lease;
    test := '37 the lease holder can advance its own job';
    select count(*) into n from jobs where id = j_lease and status = 'running';
    passed := (n = 1); detail := format('running=%s', n); return next;
  exception when others then
    test := '37 the lease holder can advance its own job';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  -- ============ 38. a non-holder cannot heartbeat ============
  begin
    perform os_heartbeat_job(j_lease, ag_rival, 60);
    test := '38 a non-holder cannot renew the lease';
    passed := false; detail := 'FAIL: the rival renewed a lease it does not hold'; return next;
  exception when others then
    test := '38 a non-holder cannot renew the lease';
    passed := sqlerrm like 'OMNIOS_LEASE_NOT_HELD%';
    detail := left(sqlerrm, 120); return next;
  end;

  -- ============ 39. the holder's heartbeat extends the lease ============
  begin
    select lease_expires_at into exp_1 from jobs where id = j_lease;
    exp_2 := os_heartbeat_job(j_lease, ag_id, 900);
    test := '39 the holder heartbeat extends the lease';
    passed := (exp_2 > exp_1);
    detail := format('%s -> %s', exp_1, exp_2); return next;
  exception when others then
    test := '39 the holder heartbeat extends the lease';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  -- ============ 40. the pause refuses a heartbeat mid-flight ============
  -- This is the half of the emergency pause that did not exist before
  -- 0011: known-limitations.md recorded that a job already running
  -- could not be stopped. A worker that heartbeats can now be told to
  -- abort. read_source is read-class, so use the write-class job.
  begin
    insert into jobs (owner_id, project_id, job_type, idempotency_key, is_demo)
    values (owner_a, p_id, 'research_topic', 'selftest:lease:paused', true)
    returning id into j_reap;

    perform set_config('omnios.claimant_agent_id', '', true);
    lease_b := os_claim_next_job(ag_id, 60, owner_a);

    perform set_config('omnios.actor_type', 'user', true);
    perform os_set_emergency_pause(true, 'selftest — mid-flight cancellation');
    perform set_config('omnios.actor_type', 'system', true);

    perform os_heartbeat_job(lease_b.id, ag_id, 60);
    test := '40 emergency pause refuses the heartbeat of running write work';
    passed := false; detail := 'FAIL: a paused system renewed a write-class lease'; return next;
  exception when others then
    test := '40 emergency pause refuses the heartbeat of running write work';
    passed := sqlerrm like '%EMERGENCY_PAUSE%';
    detail := left(sqlerrm, 130); return next;
  end;

  -- ============ 41. read-class work keeps its lease while paused ============
  -- A pause that blinds you is a bad pause; observation continues.
  begin
    exp_2 := os_heartbeat_job(j_lease, ag_id, 60);
    test := '41 read-class work still heartbeats while paused';
    passed := (exp_2 is not null);
    detail := format('read-class lease renewed to %s during the pause', exp_2); return next;
  exception when others then
    test := '41 read-class work still heartbeats while paused';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  perform set_config('omnios.actor_type', 'user', true);
  perform os_set_emergency_pause(false, 'selftest — releasing');
  perform set_config('omnios.actor_type', 'system', true);

  -- ============ 42. an abandoned job is reaped and requeued ============
  begin
    update jobs set lease_expires_at = now() - interval '1 minute' where id = j_lease;
    select attempt_count into n from jobs where id = j_lease;
    perform os_reap_expired_leases();

    test := '42 an abandoned lease is reaped and the job requeued';
    select count(*) into n from jobs
     where id = j_lease and status = 'queued'
       and leased_by is null and lease_expires_at is null
       and error_summary like 'OMNIOS_LEASE_EXPIRED%';
    passed := (n = 1);
    detail := case when n = 1 then 'job returned to the queue with the lapse recorded'
                   else 'FAIL: job was not recovered' end;
    return next;
  exception when others then
    test := '42 an abandoned lease is reaped and the job requeued';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  -- ============ 43. the reaper respects the retry limit ============
  -- A job abandoned over and over must eventually stop, not loop.
  begin
    update jobs set attempt_count = max_attempts where id = j_lease;
    perform set_config('omnios.claimant_agent_id', '', true);
    lease_b := os_claim_next_job(ag_id, 60, owner_a);
    update jobs set lease_expires_at = now() - interval '1 minute' where id = j_lease;
    perform os_reap_expired_leases();

    test := '43 a repeatedly abandoned job stops instead of looping';
    select count(*) into n from jobs where id = j_lease and status = 'failed';
    passed := (n = 1);
    detail := case when n = 1 then 'exhausted job left failed, not requeued'
                   else 'FAIL: job was requeued past its retry limit' end;
    return next;
  exception when others then
    test := '43 a repeatedly abandoned job stops instead of looping';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  -- ============ 44. claiming respects the agent grant ============
  -- The rival is granted read_source and research_topic but not
  -- send_message, so it must never be handed one.
  begin
    insert into jobs (owner_id, project_id, job_type, idempotency_key, is_demo)
    values (owner_a, p_id, 'send_message', 'selftest:lease:ungranted', true);

    perform set_config('omnios.claimant_agent_id', '', true);
    lease_b := os_claim_next_job(ag_rival, 60, owner_a);

    test := '44 claim never hands an agent work it was not granted';
    passed := (lease_b.id is null or lease_b.job_type <> 'send_message');
    detail := coalesce('received ' || lease_b.job_type, 'received nothing, correct');
    return next;
  exception when others then
    test := '44 claim never hands an agent work it was not granted';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  -- =====================================================================
  -- 0012 — targeted claim, and lease ownership over PostgREST.
  -- Tests 34-44 all ran with the claimant GUC set, which is the direct
  -- database session path. A real worker talks through PostgREST, where
  -- every request is its own transaction and that GUC is always empty.
  -- These cover that path, because it is the one the runner uses.
  -- =====================================================================

  perform set_config('omnios.claimant_agent_id', '', true);

  insert into jobs (owner_id, project_id, job_type, idempotency_key, is_demo)
  values (owner_a, p_id, 'read_source', 'selftest:lease:named', true)
  returning id into j_reap;

  -- ============ 45. a named job can be claimed atomically ============
  begin
    lease_a := os_claim_job(j_reap, ag_id, 60);
    test := '45 os_claim_job claims the job it was asked for';
    passed := (lease_a.id = j_reap
               and lease_a.status = 'claimed'
               and lease_a.leased_by = ag_id
               and lease_a.lease_expires_at > now());
    detail := format('named job %s leased by %s', left(j_reap::text, 8), left(ag_id::text, 8));
    return next;
  exception when others then
    test := '45 os_claim_job claims the job it was asked for';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  -- ============ 46. a rival gets nothing, rather than the job ============
  begin
    lease_b := os_claim_job(j_reap, ag_rival, 60);
    test := '46 os_claim_job refuses a job another agent already holds';
    passed := (lease_b.id is null);
    detail := case when lease_b.id is null
                   then 'rival received null, correct'
                   else 'FAIL: rival was handed a leased job' end;
    return next;
  exception when others then
    test := '46 os_claim_job refuses a job another agent already holds';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  -- ============ 47. the holder is recognised by name, no GUC ============
  -- This is the PostgREST path. Clear the claimant GUC entirely and
  -- identify only by the actor name the runner already sends in
  -- x-omnios-actor-name. Before 0012 this refused the lease holder's own
  -- job, which made leasing unusable from the runner.
  begin
    perform set_config('omnios.claimant_agent_id', '', true);
    perform set_config('omnios.actor_name', '', true);
    -- Exactly what PostgREST presents: no GUCs at all, only the headers
    -- the runner attaches in createAgentClient().
    perform set_config('request.headers',
      '{"x-omnios-actor":"agent","x-omnios-actor-name":"selftest-runner"}', true);
    update jobs set status = 'running' where id = j_reap;
    perform set_config('request.headers', '', true);

    test := '47 lease holder recognised by actor name alone (PostgREST path)';
    select count(*) into n from jobs where id = j_reap and status = 'running';
    passed := (n = 1);
    detail := format('running=%s with no claimant GUC set', n);
    return next;
  exception when others then
    test := '47 lease holder recognised by actor name alone (PostgREST path)';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  -- ============ 48. a different name is still refused ============
  -- The name resolves ownership; it must not wave everyone through.
  begin
    perform set_config('omnios.claimant_agent_id', '', true);
    perform set_config('omnios.actor_name', 'selftest-rival', true);
    update jobs set status = 'completed' where id = j_reap;

    test := '48 a different actor name cannot advance the leased job';
    passed := false; detail := 'FAIL: the rival name was accepted'; return next;
  exception when others then
    test := '48 a different actor name cannot advance the leased job';
    passed := sqlerrm like 'OMNIOS_LEASE_HELD%';
    detail := left(sqlerrm, 120); return next;
  end;

  -- ============ 49. an unnamed caller is refused too ============
  -- No GUC, no name: the guard must default to refusing, not allowing.
  begin
    perform set_config('omnios.claimant_agent_id', '', true);
    perform set_config('omnios.actor_name', '', true);
    update jobs set status = 'completed' where id = j_reap;

    test := '49 an unidentified caller cannot advance a leased job';
    passed := false; detail := 'FAIL: an anonymous caller was accepted'; return next;
  exception when others then
    test := '49 an unidentified caller cannot advance a leased job';
    passed := sqlerrm like 'OMNIOS_LEASE_HELD%';
    detail := left(sqlerrm, 120); return next;
  end;

  perform set_config('omnios.actor_name', 'cli', true);
  perform set_config('omnios.claimant_agent_id', '', true);

  -- =====================================================================
  -- 0013 — an approval authorises CONTENT, not a job id.
  --
  -- Before 0013 the gate asked "is there an approved approval for this
  -- job id?" and never asked whether the job still held what the human
  -- read. Tests 50-53 cover both layers of the fix: the freeze (you may
  -- not edit the question while it is being answered) and the digest
  -- (the answer is attached to specific content).
  -- =====================================================================

  insert into jobs (owner_id, project_id, agent_id, job_type, input_reference, idempotency_key, is_demo)
  values (owner_a, p_id, ag_id, 'send_message',
          '{"to": "consultant@example.com", "body": "the thing you approved"}'::jsonb,
          'selftest:bind', true)
  returning id into j_bind;

  update jobs set status = 'claimed' where id = j_bind;
  update jobs set status = 'awaiting_approval' where id = j_bind;

  insert into approvals (owner_id, project_id, job_id, action_type, action_preview, target_reference, is_demo)
  values (owner_a, p_id, j_bind, 'send_message',
          'Send the brief to consultant@example.com', 'outlook:consultant@example.com', true)
  returning id into ap_bind;

  -- ============ 50. requesting an approval records the payload ======
  begin
    test := '50 approval records a digest of the payload it was asked about';
    select count(*) into n from approvals
     where id = ap_bind
       and approved_payload_digest = os_payload_digest(
             (select input_reference from jobs where id = j_bind));
    passed := (n = 1);
    detail := case when n = 1 then 'digest matches the job payload at request time'
                   else 'FAIL: no digest recorded' end;
    return next;
  exception when others then
    test := '50 approval records a digest of the payload it was asked about';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  -- ============ 51. the payload freezes while a decision is open ====
  begin
    update jobs
       set input_reference = '{"to": "attacker@example.com", "body": "not what you read"}'::jsonb
     where id = j_bind;
    test := '51 payload cannot change while an approval is pending';
    passed := false; detail := 'FAIL: the job payload was edited mid-decision'; return next;
  exception when others then
    test := '51 payload cannot change while an approval is pending';
    passed := sqlerrm like 'OMNIOS_PAYLOAD_FROZEN%';
    detail := left(sqlerrm, 130); return next;
  end;

  -- Grant the approval OUTSIDE any block that expects an exception.
  -- A plpgsql begin/exception block rolls back everything it did, so an
  -- approval granted inside the block below would be silently undone and
  -- tests 53-54 would fail on a missing approval rather than on the
  -- thing they exist to test. (It cost a debugging round to notice.)
  perform set_config('request.jwt.claims',
    json_build_object('sub', owner_a, 'role', 'authenticated')::text, true);
  update approvals set status = 'approved', decision_note = 'selftest — bind' where id = ap_bind;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('omnios.actor_type', 'system', true);

  -- ============ 52. still frozen AFTER approval is granted ==========
  begin
    update jobs
       set input_reference = '{"to": "attacker@example.com"}'::jsonb
     where id = j_bind;
    test := '52 payload cannot change after approval is granted';
    passed := false; detail := 'FAIL: an approved job was edited before running'; return next;
  exception when others then
    test := '52 payload cannot change after approval is granted';
    passed := sqlerrm like 'OMNIOS_PAYLOAD_FROZEN%';
    detail := left(sqlerrm, 130); return next;
  end;

  -- ============ 53. the digest still catches it if the freeze is gone ==
  -- Defence in depth is only worth claiming if the second layer is shown
  -- to work WITHOUT the first. Disable the freeze, make exactly the swap
  -- an attacker would make, and confirm execution is still refused.
  begin
    alter table jobs disable trigger jobs_freeze_payload;
    update jobs
       set input_reference = '{"to": "attacker@example.com", "body": "not what you read"}'::jsonb
     where id = j_bind;
    alter table jobs enable trigger jobs_freeze_payload;

    update jobs set status = 'running' where id = j_bind;

    test := '53 a swapped payload is refused at execution even with the freeze off';
    passed := false; detail := 'FAIL: a job ran with content nobody approved'; return next;
  exception when others then
    begin
      alter table jobs enable trigger jobs_freeze_payload;
    exception when others then null;
    end;
    test := '53 a swapped payload is refused at execution even with the freeze off';
    passed := sqlerrm like 'OMNIOS_PAYLOAD_CHANGED%';
    detail := left(sqlerrm, 140); return next;
  end;

  -- ============ 54. an approval with no digest cannot authorise ======
  -- Approvals granted before 0013 have no binding, so they cannot be
  -- shown to authorise any particular content. Fail closed.
  begin
    update approvals set approved_payload_digest = null where id = ap_bind;
    alter table jobs disable trigger jobs_freeze_payload;
    update jobs set input_reference =
      '{"to": "consultant@example.com", "body": "the thing you approved"}'::jsonb
     where id = j_bind;
    alter table jobs enable trigger jobs_freeze_payload;

    update jobs set status = 'running' where id = j_bind;
    test := '54 a pre-0013 approval with no digest is refused';
    passed := false; detail := 'FAIL: an unbound approval authorised execution'; return next;
  exception when others then
    begin
      alter table jobs enable trigger jobs_freeze_payload;
    exception when others then null;
    end;
    test := '54 a pre-0013 approval with no digest is refused';
    passed := sqlerrm like 'OMNIOS_APPROVAL_UNBOUND%';
    detail := left(sqlerrm, 140); return next;
  end;

  -- =====================================================================
  -- 0014 — limits on QUANTITY.
  --
  -- Everything above asks whether an action is allowed. These ask how
  -- many, which is the failure an approval gate is structurally blind
  -- to: ten thousand individually permitted jobs contain no bad row.
  -- =====================================================================

  perform set_config('omnios.actor_type', 'system', true);

  -- ============ 55. a new owner gets budgets automatically ==========
  -- Without this the guard fails open for anyone who joined after the
  -- migration, and the control silently does nothing while looking
  -- configured — the worst way for a limit to be wrong.
  begin
    test := '55 creating a project gives its owner default budgets';
    select count(*) into n from usage_budgets where owner_id = owner_a;
    passed := (n = 5);
    detail := format('%s budget rows for the test owner (expected 5)', n);
    return next;
  exception when others then
    test := '55 creating a project gives its owner default budgets';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  -- ============ 56. demo rows do not consume budget ================
  -- Every job this suite creates is is_demo. If they counted, running
  -- the tests would exhaust a real allowance and later runs would fail
  -- for reasons unrelated to what they assert.
  begin
    update usage_budgets set max_per_day = 0
     where owner_id = owner_a and risk_level = 'read';

    insert into jobs (owner_id, project_id, agent_id, job_type, idempotency_key, is_demo)
    values (owner_a, p_id, ag_id, 'read_source', 'selftest:budget:demo', true);

    test := '56 demo rows are exempt from the daily budget';
    passed := true;
    detail := 'a demo job was accepted against a zero budget, as intended';
    return next;
  exception when others then
    test := '56 demo rows are exempt from the daily budget';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  -- ============ 57. a real job IS refused over budget ==============
  begin
    insert into jobs (owner_id, project_id, agent_id, job_type, idempotency_key, is_demo)
    values (owner_a, p_id, ag_id, 'read_source', 'selftest:budget:real', false);

    test := '57 a non-demo job is refused once the daily budget is spent';
    passed := false; detail := 'FAIL: budget was ignored'; return next;
  exception when others then
    test := '57 a non-demo job is refused once the daily budget is spent';
    passed := sqlerrm like 'OMNIOS_BUDGET_EXCEEDED%';
    detail := left(sqlerrm, 150); return next;
  end;

  update usage_budgets set max_per_day = 500
   where owner_id = owner_a and risk_level = 'read';

  -- ============ 58. an agent at capacity claims nothing more =======
  -- max_concurrent_jobs has sat in system_settings since 0003 with
  -- nothing reading it. Set it to 1 and confirm a second claim is
  -- refused while the first is still held.
  begin
    update system_settings set value = to_jsonb(1) where key = 'max_concurrent_jobs';
    perform set_config('omnios.claimant_agent_id', '', true);

    -- Speak as the lease holder, or os_guard_job_lease refuses these
    -- exactly as it is supposed to.
    perform set_config('omnios.claimant_agent_id', ag_id::text, true);
    update jobs set status = 'cancelled'
     where owner_id = owner_a and status in ('queued','claimed','running');
    perform set_config('omnios.claimant_agent_id', '', true);

    insert into jobs (owner_id, project_id, job_type, idempotency_key, is_demo)
    values (owner_a, p_id, 'read_source', 'selftest:cap:one', true);
    insert into jobs (owner_id, project_id, job_type, idempotency_key, is_demo)
    values (owner_a, p_id, 'read_source', 'selftest:cap:two', true);

    lease_a := os_claim_next_job(ag_id, 60, owner_a);
    lease_b := os_claim_next_job(ag_id, 60, owner_a);

    test := '58 an agent at max_concurrent_jobs is handed nothing more';
    passed := (lease_a.id is not null and lease_b.id is null);
    detail := case
      when lease_a.id is null then 'FAIL: the first claim returned nothing'
      when lease_b.id is not null then 'FAIL: a second job was handed out at capacity'
      else 'first claim succeeded, second returned null while at capacity' end;
    return next;
  exception when others then
    test := '58 an agent at max_concurrent_jobs is handed nothing more';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  update system_settings set value = to_jsonb(2) where key = 'max_concurrent_jobs';
  perform set_config('omnios.claimant_agent_id', '', true);

  -- =====================================================================
  -- 0015 — an agent cannot destroy.
  --
  -- Until now every guard answered "may this happen?", and deletion was
  -- never something an agent was supposed to want, so no rule covered
  -- it. Absence of intent is not a control.
  -- =====================================================================

  -- Simulate the runner and MCP server exactly: a PostgREST request
  -- carrying a key, with no signed-in human behind it.
  perform set_config('omnios.actor_type', '', true);
  perform set_config('request.jwt.claims', '', true);
  -- Something must EXIST to be deleted. A BEFORE DELETE trigger cannot
  -- fire on zero rows, so an empty table makes a delete "succeed" and
  -- the test pass while proving nothing. The first version of tests 59
  -- and 62 did exactly that.
  insert into artifacts (owner_id, project_id, name, artifact_type, location_kind, inline_body, is_demo)
  values (owner_a, p_id, 'selftest target', 'note', 'inline', 'delete me', true);

  perform set_config('request.headers',
    '{"x-omnios-actor":"agent","x-omnios-actor-name":"selftest-runner"}', true);

  -- ============ 59. a keyed connection cannot delete ================
  begin
    delete from artifacts where owner_id = owner_a and name = 'selftest target';
    test := '59 a key-based connection cannot delete records';
    passed := false; detail := 'FAIL: an agent deleted records'; return next;
  exception when others then
    test := '59 a key-based connection cannot delete records';
    passed := sqlerrm like 'OMNIOS_AGENT_CANNOT_DELETE%';
    detail := left(sqlerrm, 130); return next;
  end;

  -- ============ 60. nor delete a whole project ======================
  begin
    delete from projects where id = p_id;
    test := '60 a key-based connection cannot delete a project';
    passed := false; detail := 'FAIL: an agent deleted a project'; return next;
  exception when others then
    test := '60 a key-based connection cannot delete a project';
    passed := sqlerrm like 'OMNIOS_AGENT_CANNOT_DELETE%';
    detail := left(sqlerrm, 130); return next;
  end;

  -- ============ 61. nor hide a row by reassigning it ================
  -- Handing a row to another owner removes it from view as effectively
  -- as deleting it, and would pass the guard above.
  begin
    update projects set owner_id = owner_b where id = p_id;
    test := '61 a key-based connection cannot reassign ownership';
    passed := false; detail := 'FAIL: an agent gave a project away'; return next;
  exception when others then
    test := '61 a key-based connection cannot reassign ownership';
    passed := sqlerrm like 'OMNIOS_OWNER_IMMUTABLE%';
    detail := left(sqlerrm, 130); return next;
  end;

  -- ============ 62. spoofing the actor header does not help =========
  -- os_actor_type() takes x-omnios-actor at face value by design, for
  -- attribution. If the delete guard were built on it, claiming to be a
  -- user would be enough. It is built on the request CHANNEL instead,
  -- which the caller does not control.
  begin
    perform set_config('request.headers',
      '{"x-omnios-actor":"user","x-omnios-actor-name":"definitely-a-human"}', true);
    delete from artifacts where owner_id = owner_a and name = 'selftest target';
    test := '62 claiming to be a user in a header does not permit deletion';
    passed := false; detail := 'FAIL: a spoofed actor header bypassed the guard'; return next;
  exception when others then
    test := '62 claiming to be a user in a header does not permit deletion';
    passed := sqlerrm like 'OMNIOS_AGENT_CANNOT_DELETE%';
    detail := left(sqlerrm, 130); return next;
  end;

  -- ============ 63. a direct session may still delete ===============
  -- The point is to stop AGENTS, not to make your own data
  -- unmanageable. No request.headers means no API request means you, at
  -- a terminal.
  begin
    perform set_config('request.headers', '', true);
    perform set_config('omnios.actor_type', 'user', true);
    insert into artifacts (owner_id, project_id, name, artifact_type, location_kind, inline_body, is_demo)
    values (owner_a, p_id, 'selftest deletable', 'note', 'inline', 'x', true);
    delete from artifacts where owner_id = owner_a and name = 'selftest deletable';

    test := '63 a direct database session may still delete';
    select count(*) into n from artifacts where owner_id = owner_a and name = 'selftest deletable';
    passed := (n = 0);
    detail := 'a human at a terminal deleted a row, as intended'; return next;
  exception when others then
    test := '63 a direct database session may still delete';
    passed := false; detail := 'FAIL: ' || sqlerrm; return next;
  end;

  -- ============ 64. no budget configured means refused ==============
  -- 0014 failed open here. A limit that depends on a row existing is
  -- not a limit.
  begin
    delete from usage_budgets where owner_id = owner_a and risk_level = 'read';
    insert into jobs (owner_id, project_id, agent_id, job_type, idempotency_key, is_demo)
    values (owner_a, p_id, ag_id, 'read_source', 'selftest:nobudget', false);

    test := '64 a job is refused when no budget is configured at all';
    passed := false; detail := 'FAIL: unlimited work with no budget row'; return next;
  exception when others then
    test := '64 a job is refused when no budget is configured at all';
    passed := sqlerrm like 'OMNIOS_NO_BUDGET%';
    detail := left(sqlerrm, 130); return next;
  end;

  perform set_config('request.headers', '', true);
  perform set_config('omnios.actor_type', 'user', true);

  -- ============ 65-69. who is allowed to become a human ============
  -- Every guard in this system reduces to `auth.uid() is not null`.
  -- Migration 0016 asks the question one level lower: who is allowed to
  -- HAVE an auth.uid() at all. These check that the answer is enforced
  -- rather than assumed.

  -- 65. The trigger is really on auth.users.
  -- 0016 installs it inside an exception handler so a permissions
  -- problem on the auth schema cannot abort the whole migration. That
  -- makes this test the thing that tells the truth: if the trigger is
  -- missing, the allowlist table exists and enforces nothing.
  test := '65 the sign-up allowlist trigger is installed on auth.users';
  select count(*) into n
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'auth' and c.relname = 'users'
     and t.tgname = 'users_signup_allowlist' and not t.tgisinternal;
  passed := (n = 1);
  detail := case when n = 1
                 then 'present; self-signup and the Auth admin API both pass through it'
                 else 'MISSING: migration 0016 warned instead of failing. Nothing restricts account creation.'
            end;
  return next;

  -- An anchor row, so 66 tests the allowlist rather than the bootstrap
  -- exemption. Without it the suite passes on a live project (where the
  -- owner's address was seeded) and fails on an empty one, which would
  -- make the test a statement about the fixture instead of the guard.
  insert into auth_allowlist (email, note)
  values ('selftest-anchor@omnios.invalid', 'guard suite: keeps the bootstrap exemption out of play')
  on conflict (email) do nothing;

  -- 66. An address nobody allowlisted cannot become an account.
  -- This is the path the Auth admin API takes with the service-role
  -- key, and the path self-signup takes with the publishable key.
  begin
    insert into auth.users (id, email)
    values (gen_random_uuid(), 'selftest-intruder@omnios.invalid');

    delete from auth.users where email = 'selftest-intruder@omnios.invalid';
    test := '66 an email that is not allowlisted cannot become an account';
    passed := false;
    detail := 'FAIL: an arbitrary account was created. Anything holding a key can mint itself a human session.';
    return next;
  exception when others then
    test := '66 an email that is not allowlisted cannot become an account';
    passed := sqlerrm like 'OMNIOS_SIGNUP_REFUSED%';
    detail := left(sqlerrm, 130); return next;
  end;

  -- 67. It is an allowlist, not a wall.
  -- The insert is deliberately rolled back: a plpgsql exception block
  -- is a subtransaction, so raising a sentinel after a successful
  -- insert proves the insert was PERMITTED without leaving a real
  -- account behind on the live project.
  begin
    insert into auth_allowlist (email, note)
    values ('selftest-allowed@omnios.invalid', 'guard suite fixture');
    begin
      insert into auth.users (id, email)
      values (gen_random_uuid(), 'selftest-allowed@omnios.invalid');
      raise exception 'SELFTEST_ROLLBACK_OK';
    exception when others then
      test := '67 an allowlisted email is permitted';
      if sqlerrm like 'SELFTEST_ROLLBACK_OK%' then
        passed := true;
        detail := 'accepted, then rolled back so no real account is created';
      else
        passed := false;
        detail := 'FAIL: ' || left(sqlerrm, 130);
      end if;
      return next;
    end;
    delete from auth_allowlist where email = 'selftest-allowed@omnios.invalid';
  exception when others then
    test := '67 an allowlisted email is permitted';
    passed := false; detail := 'FAIL: ' || left(sqlerrm, 130); return next;
  end;

  -- 68. The lock is not reachable by anything holding a key.
  -- Supabase's default privileges grant every new table in public to
  -- these three roles, so this passing means 0016's revoke actually ran
  -- and nothing has re-granted since.
  test := '68 no API role has any privilege on the allowlist';
  select count(*) into n
    from (values ('anon'), ('authenticated'), ('service_role')) r(role_name)
   where has_table_privilege(r.role_name, 'public.auth_allowlist', 'SELECT')
      or has_table_privilege(r.role_name, 'public.auth_allowlist', 'INSERT')
      or has_table_privilege(r.role_name, 'public.auth_allowlist', 'UPDATE')
      or has_table_privilege(r.role_name, 'public.auth_allowlist', 'DELETE');
  passed := (n = 0);
  detail := case when n = 0
                 then 'anon, authenticated and service_role all have nothing'
                 else format('%s of 3 API roles can reach the table that decides who is a person', n)
            end;
  return next;

  -- 69. And even with a grant, the API channel is refused.
  -- Belt and braces: if some future migration re-runs a blanket
  -- `grant all on all tables in schema public`, test 68 goes red and
  -- this trigger is what still holds the line.
  begin
    perform set_config('request.headers', '{"x-omnios-actor":"user"}', true);
    insert into auth_allowlist (email, note)
    values ('selftest-viaapi@omnios.invalid', 'should never land');

    test := '69 the allowlist cannot be written over the API';
    passed := false;
    detail := 'FAIL: a request with API headers added an address. The key can let itself in.';
    return next;
  exception when others then
    test := '69 the allowlist cannot be written over the API';
    passed := sqlerrm like 'OMNIOS_ALLOWLIST_LOCAL_ONLY%';
    detail := left(sqlerrm, 130); return next;
  end;

  perform set_config('request.headers', '', true);
  perform set_config('omnios.actor_type', 'user', true);

  -- 70. The bootstrap exemption exists, and closes behind itself.
  -- An empty allowlist has to admit one account or a fresh project
  -- could never have a first user. The danger is an exemption that
  -- stays open. Everything here happens inside an exception block, so
  -- emptying the table and creating an account are both rolled back —
  -- the live project's real allowlist is untouched.
  begin
    delete from auth_allowlist;
    insert into auth.users (id, email)
    values (gen_random_uuid(), 'selftest-first@omnios.invalid');

    select count(*) into n from auth_allowlist where email = 'selftest-first@omnios.invalid';
    if n <> 1 then
      raise exception 'SELFTEST_BOOTSTRAP_NOT_RECORDED';
    end if;

    -- The door should now be shut for everyone else.
    begin
      insert into auth.users (id, email)
      values (gen_random_uuid(), 'selftest-second@omnios.invalid');
      raise exception 'SELFTEST_BOOTSTRAP_STAYED_OPEN';
    exception when others then
      if sqlerrm like 'OMNIOS_SIGNUP_REFUSED%' then
        raise exception 'SELFTEST_BOOTSTRAP_OK';
      else
        raise exception 'SELFTEST_BOOTSTRAP_BAD:%', sqlerrm;
      end if;
    end;
  exception when others then
    test := '70 an empty allowlist admits one account, then closes';
    passed := sqlerrm like 'SELFTEST_BOOTSTRAP_OK%';
    detail := case
      when sqlerrm like 'SELFTEST_BOOTSTRAP_OK%'
        then 'first account admitted and recorded; the second was refused'
      when sqlerrm like 'SELFTEST_BOOTSTRAP_STAYED_OPEN%'
        then 'FAIL: the exemption did not close. An emptied allowlist is an open door.'
      when sqlerrm like 'SELFTEST_BOOTSTRAP_NOT_RECORDED%'
        then 'FAIL: the first account was admitted but not written to the allowlist, so the exemption never closes.'
      else 'FAIL: ' || left(sqlerrm, 130)
    end;
    return next;
  end;

  delete from auth_allowlist where email like 'selftest-%@omnios.invalid';

  -- ============ 71. approving AS the dashboard actually does =========
  -- Every other test in this file runs as the migration role, which owns
  -- the tables and is therefore exempt from row-level security. That is
  -- right for testing what the guards REFUSE — it proves refusal holds
  -- even against a connection that bypasses RLS.
  --
  -- It is exactly wrong for testing what the guards PERMIT. Test 07 says
  -- "a signed-in user can approve" and has always passed, while the
  -- dashboard could not approve at all: the audit trigger inserts into
  -- audit_events, which has a SELECT policy for `authenticated` and no
  -- INSERT policy, so the write died with 42501 before the approval
  -- could commit. Two layers of the same mistake — checking the rule
  -- and never checking the road.
  --
  -- This one switches to the `authenticated` role first, so it travels
  -- the road the browser travels.
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', owner_a, 'role', 'authenticated')::text, true);
    perform set_config('request.headers', '', true);
    perform set_config('omnios.actor_type', '', true);

    insert into approvals (owner_id, project_id, requested_by_agent_id, job_id, action_type,
                           action_preview, target_reference, is_demo)
    values (owner_a, p_id, ag_id, j_send, 'send_message',
            'selftest: the path the browser takes', 'email:nobody@example.invalid', true)
    returning id into ap_rls;

    set local role authenticated;
    update approvals set status = 'approved', decision_note = 'via the authenticated role'
     where id = ap_rls;
    reset role;

    test := '71 a signed-in user can approve through the authenticated role';
    select count(*) into n from approvals where id = ap_rls and status = 'approved';
    passed := (n = 1);
    detail := case when n = 1
                   then 'the path the dashboard uses, audit row and all'
                   else 'FAIL: the update did not land' end;
    return next;
  exception when others then
    reset role;
    test := '71 a signed-in user can approve through the authenticated role';
    passed := false;
    detail := 'FAIL: ' || left(sqlerrm, 150); return next;
  end;

  -- ============ 72. the kill switch, from the same road =============
  -- The other consequential button in the console, and the one whose
  -- failure would matter most. os_set_emergency_pause() has been
  -- SECURITY DEFINER since 0008, so it was never exposed to the defect
  -- 0017 fixed — but "was never exposed" was an inference until this
  -- test, and the inference is exactly what failed for the approve path.
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', owner_a, 'role', 'authenticated')::text, true);
    perform set_config('request.headers', '', true);
    perform set_config('omnios.actor_type', '', true);

    set local role authenticated;
    perform os_set_emergency_pause(true, 'selftest: pause from the browser path');
    perform os_set_emergency_pause(false, 'selftest: release from the browser path');
    reset role;

    test := '72 a signed-in user can operate the emergency pause';
    select count(*) into n from system_settings
     where key = 'emergency_pause' and (value = 'false'::jsonb or value = to_jsonb(false));
    passed := (n = 1);
    detail := case when n = 1
                   then 'engaged and released through the authenticated role'
                   else 'FAIL: pause did not return to released' end;
    return next;
  exception when others then
    reset role;
    test := '72 a signed-in user can operate the emergency pause';
    passed := false; detail := 'FAIL: ' || left(sqlerrm, 150); return next;
  end;

  perform set_config('request.jwt.claims', '', true);
  perform set_config('omnios.actor_type', 'user', true);

  -- ---------- cleanup ----------
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.headers', '', true);
  perform set_config('omnios.actor_type', 'user', true);
  delete from approvals where project_id = p_id;
  delete from projects where slug in ('selftest-project', 'selftest-other');
  delete from agents where name in ('selftest-runner', 'selftest-rival');

  -- ============ 29. deleting a project does not break history ======
  -- Regression test for the FK that made Postgres try to UPDATE
  -- immutable audit rows on delete.
  test := '29 project delete succeeds and history survives';
  select count(*) into n from audit_events where project_id = p_id;
  passed := (n > 0);
  detail := format('%s audit events retained for the deleted project', n);
  return next;

  test := '30 fixtures cleaned up';
  select count(*) into n from projects where slug like 'selftest-%';
  passed := (n = 0); detail := format('%s selftest projects remain', n); return next;
end;
$fn$;
