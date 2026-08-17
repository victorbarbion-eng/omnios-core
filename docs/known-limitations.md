# Known limitations

This document is intentionally conservative. It separates implemented controls from work that is only represented by schema, placeholders, or comments.

## Current limitations

- The research step in the demo workflow reads a fixed local source set rather than the live web. It records two hard-coded NIST entries so the workflow is deterministic; it is not evidence that live retrieval works.
- The Outlook, Google Drive, Google Calendar, finance, and GitHub integration adapters are placeholders. Their `execute()` method throws `OMNIOS_ADAPTER_DISABLED`, so no live external action is possible.
- Nothing has been deployed to Vercel. The Next.js dashboard exists locally and includes generated local build output, but there is no verified hosted URL or deployment configuration.
- The agent runner's live end-to-end run was not executed by the builder because the service-role key was never supplied to it. Runner code paths are verified only by type-checking, unit tests, and the database guard suite, not by an actual recorded run with that credential.
- There is no job leasing, heartbeat, or atomic queue claim. Two concurrent runners could race to claim the same queued job.
- Approvals expire when `os_expire_stale_approvals()` is called, but nothing automatically re-requests an expired approval.
- The supplied local runner is a fixed demo runner, not a general queue consumer. It does not poll queued jobs, enforce a worker concurrency limit, or implement a general retry loop.
- `max_concurrent_jobs` exists in `system_settings` with value `2`, but the current runner does not read or enforce it.
- `agents.allowed_actions` and `allowed_project_scope` are stored and displayed. The shared `PolicyEngine` can check `allowed_actions`, but the database job guard does not validate `jobs.agent_id` against either array. A future worker must enforce this in claim logic or add a database guard.
- `assertNotPublicEnv()` can detect secret-shaped `NEXT_PUBLIC_*` variables, but no current application entry point calls it. The environment naming rule and code review remain the active prevention mechanisms.
- Re-running `npm run agent:demo` with the same topic after its jobs have completed is not idempotent end to end. The runner reuses the existing job idempotency key, then tries to claim the completed job and gets an illegal-transition error.
- The dashboard can approve or deny requests and operate the pause, but it has no general editing, deletion, retry, task creation, agent administration, or policy-promotion workflow.
- Approval status has an enum and targeted decision guards, but no complete database transition matrix. No current code marks an approval `completed` or `cancelled` after execution.
- The emergency pause prevents non-read jobs from starting; it does not stop a process already running, recall a message, or undo an action already performed. The dashboard control's wording that a running job cannot advance past the guard is stronger than the database implementation: the pause check applies when the new status is `claimed` or `running`, so a job already in `running` can still move to `completed`.
- The Basic backup posture has no independent off-platform data export, no guaranteed point-in-time recovery unless the Supabase plan includes it, and no tested restore drill. It also does not back up external/local file bytes merely referenced by database metadata.
- The redaction helper is a safety net, not a proof that no secret can enter a log or record. Pattern-based masking can miss unknown formats and may alter text that happens to resemble a credential.

## Real defects testing found and code fixed

The passing guard suite is meaningful because it found defects in the enforcement and evidence paths before final verification.

1. **Shared audit trigger compilation failure.** `os_write_audit()` referenced `NEW.project_id` inside a `CASE` branch. PL/pgSQL resolves record fields at compile time, so inserts into `projects` failed because that record has no `project_id`, even when the other branch would not run. Migration `0007_fix_audit_trigger.sql` now reads fields from `to_jsonb(NEW)`, allowing one trigger function to serve tables with different columns.
2. **`os_actor_type()` returned `NULL` under SQL three-valued logic.** The old `if v_raw not in (...)` did not enter its branch when `v_raw` was `NULL`, so an unlabelled connection returned `NULL` and audited inserts failed against `audit_events.actor_type not null`. Migration `0008_identity_and_audit_integrity.sql` now falls back to the request channel: real Auth session is user, key-based API request is agent, and direct unlabelled database work is system. The caller cannot fake the channel distinction.
3. **Audit foreign key prevented project deletion.** `audit_events.project_id` used `ON DELETE SET NULL`, which made PostgreSQL try to update immutable audit rows during project deletion. The append-only trigger correctly refused that update. Migration `0008` drops the foreign key; audit history now retains the original project identifier unchanged after deletion.
4. **Over-redaction damaged evidence URLs.** The old `sk-` API-key pattern matched inside the ordinary word `risk-management`, mangling a NIST evidence URL. `packages/shared/src/redact.ts` now anchors provider-key patterns on non-word boundaries. This matters because over-redaction destroys the verifiability of the evidence trail.

## Three highest-value next improvements

1. **Implement atomic job leasing and a real worker claim loop.** This removes the highest operational correctness risk: two local or future workers currently can race for the same queued job, and no heartbeat can recover abandoned work safely.
2. **Add a narrowly scoped live research integration with recorded provenance and tests.** The existing demo proves records and approvals, not retrieval; replacing only the fixed source collector with a reviewed live reader would make the core workflow useful without enabling external writes.
3. **Perform a service-role-backed end-to-end run and a restore drill.** These two exercises validate the critical operational paths that static checks and database guards cannot: real runner credentials, dashboard-to-database behavior, backup restoration, and safe recovery.
