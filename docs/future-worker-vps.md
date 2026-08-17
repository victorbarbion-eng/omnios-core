# Future always-on worker / VPS

A Dockerized always-on worker can be added without replacing the schema, policy table, audit design, dashboard, or local runner. It would be another `agents` row with `runtime_type = 'future_vps'`, not a new authorization model.

## Intended fit

1. Build and run the worker in a container with its own service-role credential, distinct from the local Mac runner's credential.
2. On startup, register or refresh an `agents` record with `runtime_type = 'future_vps'`, a specific `name`, `status`, explicit `allowed_actions`, and an optional explicit `allowed_project_scope`.
3. Poll only queued jobs. Before claiming, filter and verify that the job type is in the worker's declared `allowed_actions`, its project is within scope, and the action policy permits the attempt.
4. Claim the job, follow the existing `queued → claimed → running → terminal/awaiting_approval` transitions, and use the same `jobs`, `job_logs`, `approvals`, `evidence`, `artifacts`, and `audit_events` records as the local runner.
5. For a non-automatic action, write the exact approval preview and park the job. It must never approve its own request because the service-role API request has no `auth.uid()`.
6. Honor the emergency pause. Database guards refuse non-read work from starting while paused, and the worker should refresh settings before each claim as an early client-side check.
7. Disable the worker by setting its agent status to `paused`, `offline`, or another operational status, and engage emergency pause when you need the database to stop non-read starts across all agents.

The point of database enforcement is that the worker uses the same guards as every other client. A service-role credential bypasses RLS but not `os_guard_jobs`, approval identity checks, append-only audit triggers, retry limits, or the emergency-pause guard.

## Not yet implemented

No Dockerfile, worker loop, hosted VPS, container image, worker credential, job claiming query, job lease, heartbeat, or log-shipping system exists in this repository. `future_vps` is an enum value only.

The local runner is not a general job consumer either; its `claim()` method changes one known job by id. A worker must add actual queued-job selection and robust claim logic.

## Required additions before concurrent workers

### Job leasing and heartbeat

This is the most important missing part. The current `jobs` table has a status and timestamps, but no lease owner, lease expiry, atomic `SKIP LOCKED` claim, or heartbeat. Two runners could read the same queued row and race to claim it. Add a lease token/owner/expiry or an atomic claim RPC, refresh it while running, and define recovery for expired leases.

### Container image and runtime configuration

Add a Dockerfile, pinned runtime dependencies, a non-root execution user, read-only filesystem defaults where possible, explicit volume rules for any local files, and a minimal environment contract. The container should receive only its own credential and the settings it needs, never the Mac's entire `.env`.

### Log shipping and observability

`job_logs` is the system-of-record timeline, but container stdout and health events need a retention and shipping plan. Add structured process logs, a health endpoint or heartbeat, alerting for failed/abandoned jobs, and clear retention rules that do not leak secrets.

### Separate revocable credential

Use a separate service-role or equivalent restricted server credential for the worker rather than sharing the Mac runner's key. Document rotation, keep it in an encrypted host secret store, and make disabling the worker an immediate credential-revocation option as well as an agent-status change.

## Important enforcement limitation

`agents.allowed_actions` and `allowed_project_scope` are stored and shown in the dashboard, and the shared `PolicyEngine` checks an action list when the caller provides it. The present database job trigger does not cross-check the job's `agent_id` against those arrays. A future worker must enforce that filter in its own claim logic until a database-level per-agent authorization guard is added.
