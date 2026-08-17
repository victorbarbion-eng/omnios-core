# Operations runbook

## Daily use

1. Start the dashboard:

   ```bash
   npm run dashboard
   ```

2. Sign in at `http://localhost:3100` with a user created in Supabase Authentication.
3. Start at **Overview** for counts of projects, active jobs, failed jobs, pending approvals, task statuses, settings, and recent audit events.
4. Check **Approvals** before treating any consequential action as permitted. Read the exact preview, payload, target, requester, and expiry before approving or denying.
5. Check **Jobs** for failed or waiting work, then open a job detail to read its structured log timeline and related approval records.
6. Check **Audit** when you need a chronological, append-only history. Filter by project, actor type, action text, or entity type.
7. Check **Policy** to see action classes and the emergency-pause state. The matrix is displayed read-only; it is not a dashboard policy editor.

The dashboard is a viewer and narrow decision surface. It has no general task editor, job retry button, artifact editor, or live action execution control.

## Run the demo workflow

Before a real run, confirm root `.env` has `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and an absolute `OMNIOS_WORKSPACE_ROOT`. The runner reads policy and settings through the service-role API.

1. Safe first pass:

   ```bash
   npm run agent:dry
   ```

   This simulates writes but still connects to Supabase to load policy and settings.

2. Actual demo:

   ```bash
   npm run agent:demo
   ```

3. In the dashboard, inspect the project, jobs, evidence, inline draft artifact, and pending `send_message` approval.
4. You may approve or deny the pending request in the dashboard. Approval records the human decision; it does not cause an email to be sent because the adapter is disabled.

The workflow reads a hard-coded source list, saves two evidence rows, creates an inline report draft, and stops at `awaiting_approval` for `send_message`. Do not re-run the same completed topic: the runner reuses the idempotency key, then attempts to claim a completed job and the database correctly rejects the illegal transition. Use a new topic, or remove demo data before rerunning.

## Read the dashboard views

| Page | What it reads | How to use it |
|---|---|---|
| Overview | direct counts from `projects`, `tasks`, `jobs`, `approvals`, `system_settings`, and the latest `audit_events` | Daily pulse. Counts are scoped by RLS to the signed-in owner. |
| Projects | `v_project_summary` | Open a project for its tasks, artifact pointers, evidence links, jobs, and recent decided approvals. Non-archived projects only. |
| Agents | `agents` and recent `jobs` | Confirm runtime type, status, permitted action list, project scope pointer, configuration reference, and recent failures. |
| Approvals | pending `approvals`, plus project and agent names | Review exact action preview/payload. Approve or deny using a signed-in session. A denial requires a note in the UI. |
| Audit | `audit_events` | Investigate who changed a tracked row and when. Audit snapshots intentionally omit selected full-text/payload fields. |
| Jobs | `v_job_activity`; job detail reads `jobs`, `job_logs`, `approvals`, `action_policies` | Filter statuses, read `error_summary`, then open a job for timestamps, input reference, approvals, and the ordered log timeline. |
| Policy | `action_policies`, `system_settings` | Read the matrix and operate the two-step emergency pause control. |

## Emergency pause / kill switch

Engage from a direct database connection:

```bash
npm run pause
```

Release it:

```bash
npm run resume
```

Both commands need `SUPABASE_DB_URL`; they call `os_set_emergency_pause`. You can add a reason on the CLI, for example:

```bash
npm run pause -- --reason="Investigating unexpected job behavior"
```

The dashboard has the equivalent control on **Policy → Emergency pause**. It requires a signed-in user session, two confirmation steps, and a written reason. Key-only API traffic cannot change this setting.

When pause is on, `os_guard_jobs()` prevents a job whose policy risk class is not `read` from moving into `claimed` or `running`. Read-class jobs may still start. The pause **does not force-kill a running process**, does not automatically change statuses, does not remove queued jobs, and cannot undo an external action that already happened. Release the pause only after reviewing the affected work.

## Investigate a failed job

1. Open **Jobs**, select `failed`, and read `error_summary` for the immediate failure message.
2. Open the job detail. Check its `job_type`, risk level, status timestamps, attempts, idempotency key, and `input_reference`.
3. Read `job_logs` in chronological order. The runner writes a level, step, message, and structured data for each logged step; not every failure is guaranteed to have a persisted log because logging deliberately warns rather than fails the work when a log insert fails.
4. Check **Approvals for this job**. A job waiting for approval is not a failed send; it is intentionally parked. A non-automatic job moved to running without an approved record is refused by `OMNIOS_APPROVAL_REQUIRED`.
5. Check **Audit** filtered to the job or its project. Look for `jobs.created`, `jobs.status_changed`, `approvals.created`, and approval status events. Audit history cannot be edited or deleted.
6. Check the policy and pause state. `OMNIOS_EMERGENCY_PAUSE`, `OMNIOS_PROHIBITED`, retry limits, and state-transition errors are policy enforcement, not transport failures.

There is no dashboard retry operation. The database permits a `failed → queued` transition, but this repository provides no audited UI or runner queue loop to perform a general retry. Treat manual direct writes as an administrative procedure and preserve the audit trail.

## Remove demo data

Preview only:

```bash
npm run db:unseed
```

Remove all records marked `is_demo=true`:

```bash
npm run db:unseed -- --yes
```

The script deletes in dependency order and runs in a transaction. It intentionally retains `audit_events`; the audit trail says the demo occurred even after the demo rows are gone.

## Claim seed ownership

If demo rows were seeded before your Supabase Auth account existed, they use placeholder owner id `00000000-0000-0000-0000-0000000000aa` and RLS hides them from your dashboard session. After creating your account, run:

```bash
npm run db:claim -- you@example.com
```

The script finds that email in `auth.users`, then reassigns only rows with the placeholder owner id in `projects`, `agents`, `tasks`, `artifacts`, `jobs`, `approvals`, `evidence`, and `job_logs`. It does not alter audit-event ownership or attribution.

## OMNIOS error codes

| Code | Meaning and first response |
|---|---|
| `OMNIOS_MISSING_ENV` | A required environment variable is empty. Copy the example file, fill only the needed component values, and keep it out of Git. |
| `OMNIOS_BAD_ENV` | `OMNIOS_AGENT_RUNTIME` is not `local`, `cloud`, or `future_vps`. Correct the value. |
| `OMNIOS_BAD_ROOT` | `OMNIOS_WORKSPACE_ROOT` is not absolute. Set an absolute local path. |
| `OMNIOS_OUTSIDE_WORKSPACE` | A file path resolved outside the configured root, including traversal, sibling prefixes, or `~`. Do not bypass the guard. |
| `OMNIOS_SECRET_IN_PUBLIC_ENV` | A helper found a secret-shaped `NEXT_PUBLIC_*` variable. Remove it from public configuration and rotate it if exposed. |
| `OMNIOS_ADAPTER_DISABLED` | A placeholder integration was asked to execute. This build cannot perform the external action. |
| `OMNIOS_ADAPTER_SHOULD_HAVE_REFUSED` | Internal demo assertion: a disabled adapter returned instead of throwing. Treat as a defect. |
| `OMNIOS_UNEXPECTED_AUTONOMY` | The demo found `send_message` automatic and intentionally refuses to send. Review policy immediately. |
| `OMNIOS_PROHIBITED` | A prohibited action type was queued. Remove the request; it is never allowed in this build. |
| `OMNIOS_BAD_TRANSITION` | Requested job state move is not legal. Inspect the current status and follow the state machine. |
| `OMNIOS_EMERGENCY_PAUSE` | Pause is active and the job is not `read` risk. Keep it paused or resume only after review. |
| `OMNIOS_APPROVAL_REQUIRED` | A non-automatic job tried to run/complete without an approved matching approval. Park it, request approval, and wait. |
| `OMNIOS_RETRY_LIMIT` | `attempt_count` exceeded `max_attempts`. Investigate before any manual requeue. |
| `OMNIOS_HUMAN_SESSION_REQUIRED` | An approval or pause action lacked a signed-in human session. Use the dashboard session or an allowed direct maintenance path. |
| `OMNIOS_SELF_APPROVAL_BLOCKED` | Agent-attributed traffic attempted to approve or deny. Agents may request, never decide. |
| `OMNIOS_NOT_PENDING` | Someone tried to decide an approval that is no longer pending. Create a new request if needed. |
| `OMNIOS_EXPIRED` | An approval passed expiry. It must be requested again. |
| `OMNIOS_IMMUTABLE` | An already completed approval was changed. Leave the historical decision intact. |
| `OMNIOS_AUDIT_APPEND_ONLY` | An update or delete of audit history was attempted. Do not alter audit rows. |
| `OMNIOS_PROMOTION_NEEDS_NOTE` | An action was promoted to automatic without a written reason. Supply a specific `promoted_note`. |
| `OMNIOS_SELF_PROMOTION_BLOCKED` | An agent tried to widen policy. A human must make and justify the change. |
| `OMNIOS_AGENT_BLOCKED` | An agent attempted to toggle the emergency pause. Use a signed-in human session or direct owner maintenance path. |
