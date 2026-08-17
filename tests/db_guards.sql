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

  -- ---------- cleanup ----------
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.headers', '', true);
  perform set_config('omnios.actor_type', 'user', true);
  delete from approvals where project_id = p_id;
  delete from projects where slug in ('selftest-project', 'selftest-other');
  delete from agents where name = 'selftest-runner';

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
