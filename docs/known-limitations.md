# Known limitations

This document is intentionally conservative. It separates implemented controls from work that is only represented by schema, placeholders, or comments.

## Current limitations

- The research step in the demo workflow reads a fixed local source set rather than the live web. It records two hard-coded NIST entries so the workflow is deterministic; it is not evidence that live retrieval works.
- The Outlook, Google Drive, Google Calendar, finance, and GitHub integration adapters are placeholders. Their `execute()` method throws `OMNIOS_ADAPTER_DISABLED`, so no live external action is possible.
- Nothing has been deployed to Vercel. The Next.js dashboard exists locally and includes generated local build output, but there is no verified hosted URL or deployment configuration.
- ~~The agent runner's live end-to-end run was not executed by the builder because the service-role key was never supplied to it.~~ **Done.** `npm run agent:demo` has now been run against the live project by the owner: research and draft jobs completed, an artifact and two evidence rows were filed, and `send_message` stopped at `awaiting_approval` with a real approval row. The dashboard's signed-in views have also been rendered with live data for the first time. Both were open items in Part 8 of `docs/tutorial.md`.
- ~~There is no job leasing, heartbeat, or atomic queue claim. Two concurrent runners could race to claim the same queued job.~~ **Resolved by migration `0011_job_leasing.sql`.** `os_claim_next_job()` finds and claims in one statement using `for update skip locked`, so concurrent workers never see the same row as available; `os_heartbeat_job()` renews a lease and `os_reap_expired_leases()` recovers work whose worker vanished, via the existing `running → failed → queued` path so `attempt_count` and the retry limit keep their meaning. Verified two ways: guard tests 34–44 cover the logic, and `tests/concurrent_claim.sh` races eight real connections. Measured on Postgres 16 — with the old two-step claim, 8 of 8 workers claimed the same job; with `os_claim_next_job()`, exactly 1 of 8 did, and in the eight-jobs-eight-workers case all eight were claimed exactly once each.
- ~~The local runner does not yet USE the leasing functions.~~ **Resolved.** The runner now claims through `os_claim_job()` (migration `0012`) rather than writing `claimed` itself, renews its lease every `LEASE_SECONDS / 3`, and treats a refused renewal as an instruction to stop. Migration `0012` also fixed a real defect in `0011`: the lease guard identified the claimant from a transaction-local GUC, which survives in a psql session — hence 44 passing tests — but is always empty over PostgREST, where each request is its own transaction. The guard would have refused the lease holder its own job. It now resolves the worker from the `x-omnios-actor-name` header the runner already sends, following the pattern `os_actor_name()` set in `0006`. Guard tests 45–49 cover the targeted claim and the header path, with 47 simulating PostgREST exactly (no GUCs set).
- The lease-holder check is attribution-grade, not an authority check. `x-omnios-actor-name` is caller-controlled, so a second holder of the service-role key could claim to be the first and advance its job. That is accepted deliberately: this guard exists to stop two *cooperating* workers colliding, which is the failure that actually occurs. It grants nothing — authority still comes from `auth.uid()` alone — and a forged name gains an attacker nothing it did not already have with that key.
- ~~An approval authorised a job IDENTIFIER rather than the content a human read, so a payload could be swapped between the decision and execution.~~ **Resolved by migration `0013_bind_approval_to_payload.sql`.** Two overlapping controls: `jobs.input_reference` freezes once an approval for it is pending or granted, and the approval records a sha256 of the payload at request time which the execution gate recomputes and compares. Guard tests 50–54, with 53 disabling the freeze to show the digest still refuses the swap on its own. Breaking on purpose: approvals granted before `0013` have no digest and are refused with `OMNIOS_APPROVAL_UNBOUND`, because a control whose purpose is to make "approved" specific has to fail closed.
- ~~The agent can still destroy data it cannot act wrongly with.~~ **Largely resolved by migration `0015_agents_cannot_destroy.sql`.** DELETE is refused on every data table for a connection that arrived over the API with a key and no signed-in human, and `owner_id` cannot be reassigned by such a connection either — handing a row away hides it as effectively as deleting it. The predicate is `auth.uid() is null and os_is_api_request()`, the same unspoofable channel test `os_set_emergency_pause()` has used since `0008`; deliberately NOT `os_actor_type()`, which takes a caller-supplied header at face value for attribution and would let an agent claim to be a user. Guard test 62 proves that specifically. You at a terminal, and the dashboard with a signed-in human, are unaffected.
- **It stops deletion, not destruction.** An agent with the service-role key can still blank an artifact's body or rename a project to nonsense: a legitimate update and a vandalising one are the same statement, and no predicate separates them. Closing that needs the narrow-role rebuild — agents reaching tables only through `SECURITY DEFINER` functions, with no direct table grants at all. `0015` is the cheap ninety per cent and should not be mistaken for the whole thing.
- ~~Nothing limits volume.~~ **Partly resolved by migration `0014_volume_limits.sql`.** A `usage_budgets` table caps job creation per owner, per day, per risk class, enforced on insert; `max_concurrent_jobs` is finally read, scoped per agent, so a worker at capacity is handed nothing more. Guard tests 55–58. Two honest caveats: the defaults (500 read / 200 internal_write / 50 external_draft / 20 approval_required per day) are starting numbers rather than researched ones, and a limit that fires during ordinary work trains you to raise it without reading — the approval-fatigue failure in a different hat. And the budget counts JOBS, not money or tokens; a cost ceiling is a separate thing that does not exist.
- Demo and test rows (`is_demo = true`) are exempt from the budget, so the guard suite can run repeatedly without exhausting a real allowance. That exemption is also a hole: anything that can set `is_demo` can create unlimited jobs. Acceptable while the only writers are the runner and the MCP server, neither of which sets it on real work; not acceptable once anything less trusted can write.
- ~~**Approving requires being at the Mac with a dev server running.**~~ **Prepared, not yet done.** The design is explicit that approval fatigue — clicking yes on autopilot — is how these systems fail in practice, and making a decision inconvenient reintroduces that failure through the user experience rather than through the schema. `docs/deploying-the-dashboard.md` is the procedure, and the code it depends on has landed: the sign-in allowlist (`0016`), the open-redirect fix in the `next=` parameter, and `frame-ancestors 'none'`. What remains is the deployment itself, which only the owner can do. Until a URL exists this is still a limitation, not a resolved item.

  Worth recording why the tempting shortcut was refused. A one-click **Approve** link in an email would mean a service holding a credential and turning a click into a decision, which the database would then have to accept as a human. That makes `auth.uid()` — the single line every guard here reduces to — decoration. The sign-in stays; the laptop goes.
- **The service-role key can become you.** Supabase's Auth admin API (`POST /auth/v1/admin/users`) accepts the service-role key, and an agent holds that key. Migration `0016_signin_allowlist.sql` closes the account-*creation* half: a trigger on `auth.users` refuses any email absent from `public.auth_allowlist`, which binds self-signup with the publishable key and the admin API with the service-role key alike, because both end at the same insert. The allowlist is unreachable over the API by three overlapping controls — revoked privileges, RLS with no policies, and a trigger refusing API-channel writes — because a table that decides who counts as a person must not be writable by anything holding a key. Guard tests 65–70, with 70 proving the empty-allowlist bootstrap exemption closes behind the first account instead of staying open.

  The account-*modification* half is not closed and cannot be closed at this layer: the same admin API resets any user's password, and no trigger can distinguish that call from your own password recovery — both reach Postgres as `supabase_auth_admin`, with no session and no request headers. This is now the sharpest argument for the narrow-role rebuild below, which until now was justified on tidiness grounds.
- The dashboard's `next=` redirect parameter accepted anything beginning with `/`, including `//host` and `/\host`, which browsers read as protocol-relative URLs and follow off-site. Fixed in `apps/dashboard/src/lib/safe-next.ts`, with unit tests for each bypass. Harmless while the console only ran on localhost; on a public domain it is a link that carries your real domain, walks a victim through a real successful sign-in, and lands them somewhere else. Recorded because the defect did not change — its context did.
- Approvals expire when `os_expire_stale_approvals()` is called, but nothing automatically re-requests an expired approval.
- The supplied local runner is a fixed demo runner, not a general queue consumer. It does not poll queued jobs, enforce a worker concurrency limit, or implement a general retry loop.
- `agents.allowed_actions`, `allowed_project_scope` and the `paused` off switch are now enforced in the database by `os_guard_agent_grant()` (migrations `0009` and `0010`), not only by the TypeScript `PolicyEngine`. A client holding the service-role key cannot queue a job type its agent record does not permit. Note that `offline` is deliberately not a block: a laptop is offline most of the time and queued work simply waits for it.
- `assertNotPublicEnv()` can detect secret-shaped `NEXT_PUBLIC_*` variables, but no current application entry point calls it. The environment naming rule and code review remain the active prevention mechanisms.
- Re-running `npm run agent:demo` with the same topic after its jobs have completed is not idempotent end to end. The runner reuses the existing job idempotency key, then tries to claim the completed job and gets an illegal-transition error.
- The dashboard can approve or deny requests and operate the pause, but it has no general editing, deletion, retry, task creation, agent administration, or policy-promotion workflow.
- Approval status has an enum and targeted decision guards, but no complete database transition matrix. No current code marks an approval `completed` or `cancelled` after execution.
- The emergency pause does not recall a message or undo an action already performed, and it cannot kill a process outright — nothing in a database can. What it now does, which it could not before `0011`/`0012`: a worker renewing its lease is refused with `OMNIOS_EMERGENCY_PAUSE` mid-flight and stops. Read-class work keeps heartbeating on purpose, because a pause that blinds you is a bad pause.

  **Observed, not inferred.** `npm run agent:leasecheck` was run against the live project: 41 successful renewals, the operator engaged the pause, the 42nd renewal was refused, and the runner put the job in `failed` without attempting anything further.

  Two honest boundaries remain. Cancellation is *cooperative* and takes effect between steps, not mid-step — a long-running step finishes before the runner notices. And it only binds a worker that actually heartbeats: a job in `running` with no lease can still reach `completed` while paused, which is exactly what keeps pre-`0011` clients working.
- The Basic backup posture has no independent off-platform data export, no guaranteed point-in-time recovery unless the Supabase plan includes it, and no tested restore drill. It also does not back up external/local file bytes merely referenced by database metadata.
- The redaction helper is a safety net, not a proof that no secret can enter a log or record. Pattern-based masking can miss unknown formats and may alter text that happens to resemble a credential.

## Real defects testing found and code fixed

The passing guard suite is meaningful because it found defects in the enforcement and evidence paths before final verification.

1. **Shared audit trigger compilation failure.** `os_write_audit()` referenced `NEW.project_id` inside a `CASE` branch. PL/pgSQL resolves record fields at compile time, so inserts into `projects` failed because that record has no `project_id`, even when the other branch would not run. Migration `0007_fix_audit_trigger.sql` now reads fields from `to_jsonb(NEW)`, allowing one trigger function to serve tables with different columns.
2. **`os_actor_type()` returned `NULL` under SQL three-valued logic.** The old `if v_raw not in (...)` did not enter its branch when `v_raw` was `NULL`, so an unlabelled connection returned `NULL` and audited inserts failed against `audit_events.actor_type not null`. Migration `0008_identity_and_audit_integrity.sql` now falls back to the request channel: real Auth session is user, key-based API request is agent, and direct unlabelled database work is system. The caller cannot fake the channel distinction.
3. **Audit foreign key prevented project deletion.** `audit_events.project_id` used `ON DELETE SET NULL`, which made PostgreSQL try to update immutable audit rows during project deletion. The append-only trigger correctly refused that update. Migration `0008` drops the foreign key; audit history now retains the original project identifier unchanged after deletion.
4. **Over-redaction damaged evidence URLs.** The old `sk-` API-key pattern matched inside the ordinary word `risk-management`, mangling a NIST evidence URL. `packages/shared/src/redact.ts` now anchors provider-key patterns on non-word boundaries. This matters because over-redaction destroys the verifiability of the evidence trail.
5. **A guard that invented an enum value.** Migration `0009` compared `agents.status` to `'disabled'`, which is not a member of the `agent_status` enum (`offline`, `idle`, `running`, `paused`, `error`). Every insert of an agent-assigned job failed with `22P02` — the guard failed closed rather than open, so nothing was ever wrongly permitted, but it was still broken. Migration `0010` uses `paused`. Caught by the test suite before any real use.

## A defect testing did not find

Worth its own heading, because the other five were caught by the suite and
this one was caught by the owner trying to use the thing.

**The Approve button had never worked.** Clicking it returned
`Unrecognised decision ""`. The two buttons carried
`name="decision" value="approved|denied"`, which is correct HTML — the
submitter's name and value are part of the submitted data — but React 19's
`<form action={fn}>` path builds the FormData without the submitter, so
`decision` never arrived. Measured against a probe page rather than reasoned
about: on a mouse click, on keyboard activation, with a note and without,
`id` and `note` arrived every time and `decision` never did.

Fixed by making the decision a bound argument
(`action.bind(null, 'approved')` on each button's `formAction`) so it does not
depend on browser and framework agreeing about submitters, and so a caller
that omits it fails to compile.

The uncomfortable part is not the bug, it is where it was. Guard test 07 — *a
signed-in user can approve, decision recorded* — passes, and always did. It
exercises SQL. Seventy database tests and seventy-four unit tests covered
everything the database refuses and nothing about whether a human could
actually say yes. The single human action the whole system exists to make safe
was the one path nothing checked.

The gap is still open: there is no browser-level test of the console, so the
same class of defect could recur in the pause control or the policy form. The
pause was inspected by hand and is safe — it carries its value in a hidden
input, which is included — but "inspected by hand" is what this section is
about.

## Three highest-value next improvements

Volume limits (`0014`) and "agents cannot destroy" (`0015`) are done, and
getting approvals off the Mac is prepared and waiting on a deployment
(`docs/deploying-the-dashboard.md`). What is left, in order:

1. **Give agents a narrow database role.** This was already number one.
   It is now number one for a much sharper reason than tidiness: an
   agent holds `service_role`, and `service_role` is the credential
   Supabase's Auth admin API accepts. That API can reset any user's
   password, so today the agent's key can make itself into you, and
   `auth.uid()` — the line every guard in this project rests on — stops
   being a boundary the key cannot cross. `0016` closes account
   creation; only moving agents off `service_role` closes the rest.
   Give them their own role with `SECURITY DEFINER` entry points and no
   direct table grants, and "cannot approve", "cannot destroy" and
   "cannot become the owner" all become structural at once.
2. **Deploy the console and decide something real on a phone.**
   Everything is ready; the remaining step needs an owner, not a
   builder. Until it happens, approval fatigue is still being designed
   in through the user experience.
3. **Put a ceiling on cost, not just on count.** `usage_budgets` limits
   how many jobs are created per day per risk class. It says nothing
   about tokens, money, or time. A runaway loop that stays inside its
   job budget can still be expensive, and nothing currently notices.

Still true and still deliberate: the five integration adapters are
inert, the demo research step reads a fixed source set, and nothing is
deployed to Vercel.
