# Guard Fix Verification Run — 2026-08-17

- Supabase project: `bvxjthifyekabpkmpcji` (`omnios-core`)
- Migration: `0008_identity_and_audit_integrity`
- Result: **applied successfully** (`{"success":true}`).
- Harness function was dropped at the end: `drop function if exists public.os_selftest();` completed successfully.

## Step 2 — no-actor-context smoke test

All SQL calls were separate. No actor context was set for the insert.

1. Insert:

```sql
insert into projects (owner_id, name, slug, description, is_demo)
values ('00000000-0000-0000-0000-0000000000aa','SMOKE test','smoke-test','temp',true);
```

Result: succeeded (`[]`).

2. Audit lookup:

```text
actor_type | action           | entity_type
-----------+------------------+------------
system     | projects.created | projects
```

3. Delete:

```sql
delete from projects where slug='smoke-test';
```

Result: succeeded (`[]`).

4. Retained-history lookup:

```text
retained_history
----------------
1
```

The audit actor type was non-null (`system`), project deletion succeeded, and the creation audit event survived deletion.

## Step 3/4 — complete final 30-row guard result

Harness execution attempt 2 (after the one harness-only correction described below):

| Test | Passed | Detail (verbatim from `left(detail, 200)`) |
|---|---:|---|
| 01 prohibited action refused at insert | true | OMNIOS_PROHIBITED: action type "exfiltrate_secrets" is prohibited by policy and cannot be queued. |
| 02 queued cannot jump straight to completed | true | OMNIOS_BAD_TRANSITION: job 2ca2926b-c679-4626-b518-8674b2e32539 cannot move from queued to completed. |
| 03 auto_allowed job runs, timestamps auto-filled | true | running=1 with claimed_at and started_at set |
| 04 approval_required job cannot run unapproved | true | OMNIOS_APPROVAL_REQUIRED: job c5dfc79e-72da-4b6a-a3d2-a2d718d92423 (send_message) needs an approved approval record before it can run. Set status to awaiting_approval and create one. |
| 05 approval cannot be granted without a human session | true | OMNIOS_HUMAN_SESSION_REQUIRED: approval db341385-4300-4c79-93fd-cc33d55f7f14 can only be decided by a signed-in user. This connection has no end-user session. |
| 06 agent-attributed traffic cannot approve | true | OMNIOS_SELF_APPROVAL_BLOCKED: an agent cannot approve or deny approval db341385-4300-4c79-93fd-cc33d55f7f14. |
| 07 signed-in user can approve, decision recorded | true | approved rows with full decision trail = 1 |
| 08 approved job may then execute | true | completed=1 |
| 09 pause still permits read-class work | true | read job claimed=1 |
| 10 pause blocks write-capable work | true | OMNIOS_EMERGENCY_PAUSE: system is paused; only risk_level=read jobs may start (job 1f12d103-fcb1-41e9-b04c-6f6d8f164335 is internal_write). |
| 11 audit events cannot be edited | true | OMNIOS_AUDIT_APPEND_ONLY: audit_events cannot be modified or deleted (attempted UPDATE). |
| 12 audit events cannot be deleted | true | OMNIOS_AUDIT_APPEND_ONLY: audit_events cannot be modified or deleted (attempted DELETE). |
| 13 job status changes are audited | true | 4 status-change events for the gated job |
| 14 approval request and decision are audited | true | 2 approval events |
| 15 setup | true | noop |
| 16 promotion without a written reason is refused | true | OMNIOS_PROMOTION_NEEDS_NOTE: set promoted_note explaining why "send_message" is now automatic. |
| 17 an agent cannot widen its own autonomy | true | OMNIOS_SELF_PROMOTION_BLOCKED: an agent cannot widen its own autonomy ("send_message"). |
| 18 stale approvals expire instead of lingering | true | os_expire_stale_approvals() touched 1 row(s) |
| 19 an expired approval cannot be revived | true | OMNIOS_NOT_PENDING: approval cef3b4f1-041b-441c-a019-84d746ba64a2 is expired and can no longer be decided. |
| 20 retry limit is enforced | true | OMNIOS_RETRY_LIMIT: job 018846ba-df60-4840-9883-205dd8c928cd exceeded max_attempts (3). |
| 21 duplicate idempotency key is rejected | true | duplicate key value violates unique constraint "jobs_idempotency_unique" |
| 22 RLS hides another owner's project | true | owner B sees 0 of owner A's projects |
| 23 RLS shows an owner their own project | true | owner A sees 1 |
| 24 dashboard role cannot delete records | true | no DELETE policy exists for authenticated, so the row survives |
| 25 actor type never null when nothing is declared | true | unlabelled connection resolves to user |
| 26 unrecognised actor label is not promoted to user | true | junk label resolves to system |
| 27 API key alone cannot engage the emergency pause | true | refused: OMNIOS_HUMAN_SESSION_REQUIRED: the emergency pause can only be changed by a signed-in user or from a direct database ses |
| 28 emergency pause still off after refused attempt | true | emergency_pause = f |
| 29 project delete succeeds and history survives | true | 16 audit events retained for the deleted project |
| 30 fixtures cleaned up | true | 0 selftest projects remain |

## Harness iteration record

### Attempt 1

The function returned all 30 rows. Test 17 was the sole failing row:

| Test | Passed | Detail |
|---|---:|---|
| 17 an agent cannot widen its own autonomy | false | FAIL: agent promoted an action type |

Diagnosis: **harness bug, not a missing database guard.** The test updated `draft_report` from `auto_allowed = true` to `true`; `draft_report` is already auto-allowed in the seed policy. Consequently there was no false-to-true transition, so `os_guard_policy_change()` correctly had no promotion to block. This statement did change `promoted_note`, which was restored along with the original `auto_allowed = true` state before re-running.

### Edit made to `tests/db_guards.sql`

Changed test 17's target action type:

```diff
-     where action_type = 'draft_report';
+     where action_type = 'send_message';
```

A preceding comment was added to explain the selection. `send_message` is known to remain `auto_allowed = false`; therefore the assignment to true reaches the intended false-to-true promotion path. With the test's agent attribution, the database correctly raises `OMNIOS_SELF_PROMOTION_BLOCKED` before the approval-required check constraint could accept the change. No files under `supabase/migrations/` were edited and no guard, trigger, constraint, or RLS policy was weakened, disabled, or bypassed.

### Real database gaps remaining

None identified by the final guard run. All 30 tests returned and passed on attempt 2.

## Step 5 — final state

### Jobs

```text
status             | count
-------------------+------
awaiting_approval  | 1
completed          | 1
failed             | 1
```

### Approvals

```text
status | count
-------+------
pending| 1
denied | 1
```

### System settings

```text
key                 | value
--------------------+---------------------
autonomy_level      | "low_risk_operations"
emergency_pause     | false
max_concurrent_jobs | 2
```

`emergency_pause` was already false; no reset was needed.

### Leftover smoke/self-test projects

```text
count
-----
0
```

### Demo seed counts

```text
demo_projects | tasks | artifacts | evidence | jobs | approvals | agents
--------------+-------+-----------+----------+------+-----------+-------
1             | 3     | 1         | 2        | 3    | 2         | 1
```

### Audit total

```text
audit_total
-----------
45
```

## Run 3 — migration 0009, agent grant enforcement

- Supabase project: `bvxjthifyekabpkmpcji` (`omnios-core`)
- Migration applied verbatim from `supabase/migrations/0009_enforce_agent_grant.sql` with name `0009_enforce_agent_grant`.
- Apply result: `{"success":true}`.
- The temporary harness was dropped at the end with `drop function if exists public.os_selftest();` (succeeded).

### STEP 2 — seeded job/agent consistency

SQL:

```sql
select j.job_type, a.name, (j.job_type = any(a.allowed_actions)) as permitted from jobs j join agents a on a.id = j.agent_id;
```

Result (verbatim):

```json
[{"job_type":"research_topic","name":"mac-local-runner","permitted":true},{"job_type":"read_source","name":"mac-local-runner","permitted":true},{"job_type":"send_message","name":"mac-local-runner","permitted":true}]
```

Every existing assigned job was permitted.

### STEP 3 — seeded demo-agent grant probes

#### (a) Ungranted `deploy` insert

SQL:

```sql
insert into jobs (owner_id, project_id, agent_id, job_type, status, idempotency_key, is_demo) select owner_id, id, (select id from agents where name='mac-local-runner'), 'deploy', 'queued', 'probe-ungranted-1', true from projects where slug='demo-system-shakedown';
```

Outcome: **FAILED, but not as required.** Verbatim error:

```text
ERROR:  22P02: invalid input value for enum agent_status: "disabled"
QUERY:  v_agent_status = 'disabled'
CONTEXT:  PL/pgSQL function os_guard_agent_grant() line 24 at IF
```

Expected `OMNIOS_AGENT_NOT_GRANTED` was not reached.

#### (b) Granted `research_topic` insert

SQL:

```sql
insert into jobs (owner_id, project_id, agent_id, job_type, status, idempotency_key, is_demo) select owner_id, id, (select id from agents where name='mac-local-runner'), 'research_topic', 'queued', 'probe-granted-1', true from projects where slug='demo-system-shakedown';
```

Outcome: **FAILED; required success did not occur.** Verbatim error:

```text
ERROR:  22P02: invalid input value for enum agent_status: "disabled"
QUERY:  v_agent_status = 'disabled'
CONTEXT:  PL/pgSQL function os_guard_agent_grant() line 24 at IF
```

#### (c) Probe cleanup

SQL:

```sql
delete from jobs where idempotency_key in ('probe-ungranted-1','probe-granted-1');
```

Result (verbatim):

```json
[]
```

### STEP 4 — 33-test harness

`tests/db_guards.sql` was installed unchanged. Its creation call succeeded (`[]`). The requested separate execution call was:

```sql
select test, passed, left(detail, 200) as detail from os_selftest() order by test;
```

It returned **zero test rows** because it aborted before the first `return next`. Verbatim error:

```text
ERROR:  22P02: invalid input value for enum agent_status: "disabled"
QUERY:  v_agent_status = 'disabled'
CONTEXT:  PL/pgSQL function os_guard_agent_grant() line 24 at IF
SQL statement "insert into jobs (owner_id, project_id, agent_id, job_type, idempotency_key, is_demo)
  values (owner_a, p_id, ag_id, 'read_source', 'selftest:read', true) returning id"
PL/pgSQL function os_selftest() line 43 at SQL statement
```

#### Complete 33-row test table

No 33-row result table exists: the query failed before any test row could be returned. The following records the complete returned result set without fabricating pass/fail values.

| Returned test rows | Result |
|---:|---|
| 0 of 33 | Function aborted at fixture job insertion; see verbatim error above. |

### STEP 5 — harness iterations and edits

- Harness attempts: 1.
- Harness edits: **none**.
- No guard, trigger, constraint, RLS policy, or migration file was altered, weakened, disabled, or bypassed.

This is not a harness bug. The currently defined enum values are:

```json
[{"agent_status_values":"{offline,idle,running,paused,error}"}]
```

### Real gap — root-cause diagnosis

Migration `0009_enforce_agent_grant` declares `v_agent_status agent_status` and evaluates `v_agent_status = 'disabled'`. In this project, `agent_status` contains only `{offline,idle,running,paused,error}`; it has no `disabled` label. PostgreSQL therefore raises SQLSTATE `22P02` while compiling/evaluating that comparison at runtime, before either allowed-action or project-scope validation can occur. Consequently, the newly installed trigger rejects **all assigned-job inserts** with an enum-cast error: ungranted work does not reach `OMNIOS_AGENT_NOT_GRANTED`, and granted work cannot be created. This is a real guard/schema incompatibility, not something that can be corrected in the harness. Per instruction, no migration under `supabase/migrations/` was edited.

### STEP 6 — final state

Each query was run in a separate call.

#### Jobs

```text
status             | count
-------------------+------
awaiting_approval  | 1
completed          | 1
failed             | 1
```

#### Approvals

```text
status  | count
--------+------
pending | 1
denied  | 1
```

#### System settings

```text
key                 | value
--------------------+-----------------------
autonomy_level      | "low_risk_operations"
emergency_pause     | false
max_concurrent_jobs | 2
```

#### Leftover self-test/smoke projects

```text
count
-----
0
```

#### Demo seed counts

```text
demo_projects | tasks | jobs | approvals | agents
--------------+-------+------+-----------+-------
1             | 3     | 3    | 2         | 1
```

#### Probe jobs

```text
count
-----
0
```

Final-state checks satisfied: leftovers were `0`, probe jobs were `0`, `emergency_pause` was `false`, and the demo seed still contained 1 project, 3 tasks, and 1 agent. These clean-state results do **not** change the failure above: the 0009 agent-grant guard is currently nonfunctional for assigned job creation because of the enum incompatibility.
