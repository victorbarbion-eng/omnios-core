# Architecture

## Layers

```text
Local Mac runner                 Supabase system of record                 Next.js dashboard
----------------                 --------------------------                -----------------
Runner + shared policy ───────>  tables, RLS, triggers, views  <────────  signed-in user session
fixed-source demo                audit_events and job_logs                 reads, approvals, pause RPC
local file boundary              action_policies and settings
```

A future optional worker can use the same database boundary. It is not implemented in this repository; see [future-worker-vps.md](future-worker-vps.md).

### Local Mac agent runner

`local-agent` is a TypeScript CLI. It loads environment variables, creates a Supabase client using the service-role key, loads the policy and pause setting, registers a local agent row, and implements a fixed demonstration workflow. It is deliberately a small database client, not a general queue worker.

The runner uses `packages/shared/src/workspace.ts` to reject paths outside `OMNIOS_WORKSPACE_ROOT`. It uses `packages/shared/src/policy.ts` as a client-side advisory check and redacts selected data before it writes logs or records. These client checks are useful, but the database is the enforcement point.

### Supabase system of record

Supabase holds metadata, links, status, policy, approvals, structured logs, and audit records. PostgreSQL triggers enforce job transition, approval, emergency-pause, audit-immutability, and policy-promotion rules for every connection, including a service-role connection that bypasses row-level security (RLS).

RLS protects dashboard traffic because the dashboard uses a publishable key and a signed-in user session. The service-role key bypasses RLS, so it is restricted operationally to the local runner and constrained by the database guards that still execute on its writes.

### Next.js dashboard

`apps/dashboard` is a Next.js application. It uses `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`, binds each request to the user's Supabase Auth cookie session, and never uses a service-role key. It provides pages for projects, agents, approvals, audit events, jobs, and policy; approvals are decided through the signed-in session and the pause control calls the `os_set_emergency_pause` RPC.

### Future optional worker

The schema already includes `agent_runtime` value `future_vps`. A future always-on worker is an architectural extension, not existing functionality. It must use its own credential, agent record, deployment image, and lease/heartbeat behavior before it can safely run concurrently with the local runner.

## One demo job end to end

1. `npm run agent:demo` starts the runner, which reads the policy table and `system_settings.emergency_pause`.
2. The runner registers or refreshes an `agents` row and ensures a demo project and task exist.
3. It queues a `research_topic` job with a deterministic idempotency key, claims it, moves it to `running`, and writes structured `job_logs`.
4. The workflow reads its fixed, local `gatherSources()` list. It writes two `evidence` rows and completes the research job. This is a plumbing demonstration, not live web research.
5. It queues `draft_report`, saves a redacted inline `artifacts` row with a checksum, logs the action, and completes that job.
6. It queues and claims `send_message`. The policy check returns `needs_approval`; the Outlook placeholder creates an exact preview, then the runner writes a pending `approvals` row and changes the job to `awaiting_approval`.
7. A signed-in dashboard user may approve or deny the request. The database requires `auth.uid()` for this decision. The runner's service-role API request has no end-user `auth.uid()` and cannot approve it.
8. No email is sent even after approval in this repository: `OutlookAdapter.execute()` always throws `OMNIOS_ADAPTER_DISABLED`. The demo deliberately stops at the approval boundary.

For each relevant insert or update, audit triggers write a lightweight `audit_events` row. The trigger strips selected document and payload fields from audit snapshots; the audit table itself rejects updates and deletes.

## Design decisions

### Metadata in Supabase; file bytes where they already live

`projects.canonical_location` and each artifact's `local_path`, `external_url`, `storage_path`, or `inline_body` identify the location of work. Large or existing file bytes are not copied into Supabase merely to make a database record. This avoids a second authoritative copy, prevents accidental duplication, and lets a project remain local, external, or in Supabase Storage. The only inline body intended by the schema is a short generated draft.

### `owner_id` intentionally has no foreign key to `auth.users`

Every principal table stores a plain `owner_id uuid` without a foreign key to `auth.users`. This makes schema tests possible without a live Auth user and leaves room for a future non-human owner. RLS still compares `owner_id` with `auth.uid()` for dashboard access. The trade-off is that an owner identifier can outlive or not correspond to a current Auth row.

### Append-only audit events deliberately do not foreign-key `project_id`

`audit_events.project_id` is an identifier, not a foreign key. Audit history needs to survive project deletion unchanged; an earlier `ON DELETE SET NULL` foreign key made PostgreSQL attempt to update immutable audit rows and prevented deletion. The audit page explicitly displays a retained identifier as a deleted project when there is no live project row.

### Database triggers are the enforcement point

Application code can be changed, skipped, or used with a powerful key. `os_guard_jobs`, `os_guard_approval_decision`, `os_audit_is_append_only`, `os_guard_policy_change`, and `os_set_emergency_pause` are PostgreSQL functions/triggers, so they run for dashboard, agent, script, and direct database writes. This is particularly important because the service-role key bypasses RLS but does not bypass table triggers.

### Actor identity: `auth.uid()` authorizes; `x-omnios-actor` attributes

`auth.uid()` is the authority for a human approval decision and RLS. The `x-omnios-actor` request header and the direct-connection `omnios.actor_type` setting are used for audit attribution only; a caller can supply a header, so it is not trusted for authorization. When no explicit identity exists, `os_actor_type()` infers a user from a real Auth session, an agent from a key-based API request, or a system actor from a direct unlabelled database session.

### Idempotency keys on jobs

`jobs` has a unique `(owner_id, idempotency_key)` constraint. The runner derives a key from the job type and JSON payload so one logical request should not create duplicate work when retried. This prevents duplicate records, not concurrent execution: there is no job lease or atomic worker claim in the current code.

## Job state machine

The `jobs.status` enum is:

```text
queued → claimed → running → completed
                 ↘ awaiting_approval → running or completed
```

The legal transitions enforced by `os_guard_jobs` are:

| From | Legal next statuses |
|---|---|
| `queued` | `claimed`, `cancelled`, `failed` |
| `claimed` | `running`, `awaiting_approval`, `queued`, `failed`, `cancelled` |
| `running` | `awaiting_approval`, `completed`, `failed`, `cancelled` |
| `awaiting_approval` | `running`, `completed`, `failed`, `cancelled` |
| `failed` | `queued`, `cancelled` |
| `completed` | none |
| `cancelled` | none |

When a job becomes `claimed`, `running`, or terminal, the trigger fills `claimed_at`, `started_at`, or `finished_at` when absent. A non-automatic action cannot move to `running` or `completed` unless there is an approved approval record for that same job and action type. While emergency pause is on, only `read`-risk jobs may start.

**Limitations:** a job may technically move from `awaiting_approval` to `completed` if an approved approval exists; the current trigger does not require an intermediate `running` transition. There is also no leasing or heartbeat mechanism, and the provided runner does not implement general queue polling.
