
## Run 4 — migration 0010, agent grant enforcement verified

**Project:** `bvxjthifyekabpkmpcji` (`omnios-core`)

### Migration and enum verification

- `0010_fix_agent_grant_enum` applied successfully using the migration SQL verbatim.
- Confirmed `agent_status` enum values, in database sort order: `offline`, `idle`, `running`, `paused`, `error`.

### Step 3 — individual guard probes

1. **(a) ungranted `deploy` assignment — failed as required**

   ```text
   ERROR:  42501: OMNIOS_AGENT_NOT_GRANTED: agent "mac-local-runner" is not permitted to run job type "deploy". Add it to that agent's allowed_actions after review.
   CONTEXT:  PL/pgSQL function os_guard_agent_grant() line 39 at RAISE
   ```

2. **(b) granted `research_topic` assignment — succeeded as required**

   ```text
   []
   ```

3. **(c) paused-agent `research_topic` assignment — failed as required**

   ```text
   ERROR:  42501: OMNIOS_AGENT_PAUSED: agent "mac-local-runner" is paused and cannot be assigned new work. Set its status to idle to resume.
   CONTEXT:  PL/pgSQL function os_guard_agent_grant() line 26 at RAISE
   ```

4. **(d) restored `mac-local-runner` to `idle` — succeeded**

   ```text
   []
   ```

5. **(e) removed `probe-%` jobs — succeeded**

   ```text
   []
   ```

Operator note: one initial malformed textual rendering of probe (c) was rejected by PostgreSQL with `42601` at `then` before any SQL statement executed. The immediately following proper SQL call above is the required probe and produced the verified `OMNIOS_AGENT_PAUSED` result.

### Step 4 — `os_selftest()` results

Harness installed successfully. All **33/33** tests passed; no harness edits or retry attempts were needed.

| Test | Passed | Detail |
|---|---:|---|
| 01 prohibited action refused at insert | true | OMNIOS_PROHIBITED: action type "exfiltrate_secrets" is prohibited by policy and cannot be queued. |
| 02 queued cannot jump straight to completed | true | OMNIOS_BAD_TRANSITION: job c765e745-6337-48bf-8991-a73e27913261 cannot move from queued to completed. |
| 03 auto_allowed job runs, timestamps auto-filled | true | running=1 with claimed_at and started_at set |
| 04 approval_required job cannot run unapproved | true | OMNIOS_APPROVAL_REQUIRED: job fd759db3-c33e-40f7-a13d-b376fdf70a8c (send_message) needs an approved approval record before it can run. Set status to awaiting_approval and create one. |
| 05 approval cannot be granted without a human session | true | OMNIOS_HUMAN_SESSION_REQUIRED: approval d5273cff-444b-463d-add6-b021412f5573 can only be decided by a signed-in user. This connection has no end-user session. |
| 06 agent-attributed traffic cannot approve | true | OMNIOS_SELF_APPROVAL_BLOCKED: an agent cannot approve or deny approval d5273cff-444b-463d-add6-b021412f5573. |
| 07 signed-in user can approve, decision recorded | true | approved rows with full decision trail = 1 |
| 08 approved job may then execute | true | completed=1 |
| 09 pause still permits read-class work | true | read job claimed=1 |
| 10 pause blocks write-capable work | true | OMNIOS_EMERGENCY_PAUSE: system is paused; only risk_level=read jobs may start (job 98c35889-6aa3-438d-bae5-c6cf5614f231 is internal_write). |
| 11 audit events cannot be edited | true | OMNIOS_AUDIT_APPEND_ONLY: audit_events cannot be modified or deleted (attempted UPDATE). |
| 12 audit events cannot be deleted | true | OMNIOS_AUDIT_APPEND_ONLY: audit_events cannot be modified or deleted (attempted DELETE). |
| 13 job status changes are audited | true | 4 status-change events for the gated job |
| 14 approval request and decision are audited | true | 2 approval events |
| 15 setup | true | noop |
| 16 promotion without a written reason is refused | true | OMNIOS_PROMOTION_NEEDS_NOTE: set promoted_note explaining why "send_message" is now automatic. |
| 17 an agent cannot widen its own autonomy | true | OMNIOS_SELF_PROMOTION_BLOCKED: an agent cannot widen its own autonomy ("send_message"). |
| 18 stale approvals expire instead of lingering | true | os_expire_stale_approvals() touched 1 row(s) |
| 19 an expired approval cannot be revived | true | OMNIOS_NOT_PENDING: approval 27a820d5-37e6-440d-af1c-74fef80ade38 is expired and can no longer be decided. |
| 20 retry limit is enforced | true | OMNIOS_RETRY_LIMIT: job f324b341-0e34-4731-b4ca-9babe46ea9db exceeded max_attempts (3). |
| 21 duplicate idempotency key is rejected | true | duplicate key value violates unique constraint "jobs_idempotency_unique" |
| 22 RLS hides another owner's project | true | owner B sees 0 of owner A's projects |
| 23 RLS shows an owner their own project | true | owner A sees 1 |
| 24 dashboard role cannot delete records | true | no DELETE policy exists for authenticated, so the row survives |
| 25 actor type never null when nothing is declared | true | unlabelled connection resolves to user |
| 26 unrecognised actor label is not promoted to user | true | junk label resolves to system |
| 27 API key alone cannot engage the emergency pause | true | refused: OMNIOS_HUMAN_SESSION_REQUIRED: the emergency pause can only be changed by a signed-in user or from a direct database ses |
| 28 emergency pause still off after refused attempt | true | emergency_pause = f |
| 29 project delete succeeds and history survives | true | 17 audit events retained for the deleted project |
| 30 fixtures cleaned up | true | 0 selftest projects remain |
| 31 database refuses a job type the agent was not granted | true | refused: OMNIOS_AGENT_NOT_GRANTED: agent "selftest-runner" is not permitted to run job type "deploy". Add it to that agent's allowed_actions after re |
| 32 database accepts a job type the agent was granted | true | granted job type accepted |
| 33 a paused agent cannot be given new work | true | refused: OMNIOS_AGENT_PAUSED: agent "selftest-runner" is paused and cannot be assigned new work. Set its status to idle to resume. |

### Harness changes and remaining gaps

- Harness edits: **none**.
- Remaining real schema/guard gaps identified: **none**.
- The temporary `public.os_selftest()` function was dropped after verification.

### Step 6 — final state

**Jobs by status**

| status | count |
|---|---:|
| awaiting_approval | 1 |
| completed | 1 |
| failed | 1 |

**Approvals by status**

| status | count |
|---|---:|
| pending | 1 |
| denied | 1 |

**System settings**

| key | value |
|---|---|
| autonomy_level | "low_risk_operations" |
| emergency_pause | false |
| max_concurrent_jobs | 2 |

**Residual checks**

| Check | Result |
|---|---:|
| projects with slug `selftest-%` or `smoke%` | 0 |
| jobs with idempotency key `probe-%` | 0 |
| audit_events | 64 |

**Demo seed counts**

| demo_projects | tasks | jobs | approvals | agents | artifacts | evidence |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 3 | 3 | 2 | 1 | 1 | 2 |

**Agents**

| name | status |
|---|---|
| mac-local-runner | idle |

Final requirements met: no self-test or smoke leftovers, no probe jobs, `emergency_pause = false`, no paused agents, and the requested demo seed records are intact.
