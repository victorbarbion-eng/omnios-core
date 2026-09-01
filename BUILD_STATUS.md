# BUILD_STATUS

Project: **omnios-core** — secure, visible, hybrid personal operating system
Repo (local): `/home/user/workspace/omnios-core`
Supabase project: `omnios-core` / ref `bvxjthifyekabpkmpcji` / eu-west-3 / free tier, $0/month
Last updated: 2026-09-01

## Current phase

Steps 1–8 complete. Since then the system has moved from "extensively tested, never
used" to "in use": the repo is pushed, an Auth user exists, the demo data is owned by
a real account, the dashboard has rendered live, and the runner has executed end to
end against the live database. Migrations 0011 and 0012 added atomic job leasing,
which also closed the mid-flight half of the emergency pause.

Since then: migrations 0012 and 0013 landed, an MCP server was added, and Hermes now
files work through it from inside a container. See "Verified live" below.

Still not done: no Vercel deployment, the five adapters remain inert by design,
`max_concurrent_jobs` is stored and ignored, agents still hold a key that can destroy
data even though it cannot act wrongly, and approving still requires the Mac.

## Completed

- **Step 1 — plan and scope.** Repo name `omnios-core` approved; new Supabase project created (free tier, no paid infrastructure).
- **Step 2 — repository foundation.** npm workspaces monorepo (`packages/shared`, `local-agent`, `apps/dashboard`), strict `.gitignore`, `.env.example` with placeholders and per-variable comments, TypeScript throughout.
- **Step 3 — data model.** 10 migrations: 11 tables, UUID keys, timestamps, ownership columns, foreign keys, indexes, row-level security on every table, a 28-row `action_policies` table, and a clearly labelled removable demo seed.
- **Step 4 — policy and approval layer.** Five risk classes (`read`, `internal_write`, `external_draft`, `approval_required`, `prohibited`). Approval-required actions create an approval record, block until decided, audit every state change, and support expiry and cancellation. Emergency pause allows only `read`-class jobs to start.
- **Step 5 — local agent runner.** Registers an agent, claims only authorised jobs, writes `queued → running → awaiting_approval → completed | failed`, records structured logs and audit events, saves outputs as artifacts with linked evidence, refuses blocked actions, supports `--dry-run`, uses idempotency keys and bounded retries, and redacts secrets from all output. Demo workflow: research → evidence → draft → approval → project record. It sends nothing.
- **Step 6 — operations console.** Next.js 15 App Router app in `apps/dashboard` with Overview, Projects (list + detail), Agents, Approvals, Audit (filterable, paginated), Jobs (list + detail), and Policy views. Publishable key only; no service-role key exists in the browser app. Approve/deny are thin server actions that surface database errors verbatim rather than second-guessing them.
- **Step 7 — integration adapters.** Google Drive, Outlook, Google Calendar, Finance and GitHub adapters exist as a common interface with `enabled: false`. Every method throws `OMNIOS_ADAPTER_DISABLED`. No live action is possible.
- **Step 8 — docs and quality gates.** `README.md` plus nine documents under `docs/`. All quality gates below pass.

## Test results

- **TypeScript:** `npx tsc -b packages/shared local-agent` — clean. Dashboard `next build` — clean, 11 routes, zero type errors, no `any`, no `@ts-ignore`.
- **Unit tests:** `npx vitest run` — **58/58 passing** (policy engine, workspace boundary, secret redaction, adapter inertness).
- **In-database guard tests:** `npm run db:guards` — **49/49 passing** against the live project (run 4). Covers prohibited actions, illegal state transitions, unapproved execution, human-session requirement for approvals, self-approval block, emergency pause behaviour for read vs write, append-only audit, retry limits, idempotency, RLS isolation between owners, no-delete for the dashboard role, actor-type resolution, stale approval expiry, self-promotion block, per-agent grant enforcement, and — from 0011/0012 — atomic claiming, lease ownership over both the direct-session and PostgREST paths, mid-flight pause cancellation, and lease reaping. The claim race itself is proved separately by `tests/concurrent_claim.sh`, which needs eight real concurrent connections: `os_selftest()` runs in one transaction and structurally cannot test what separate transactions do at the same instant. Earlier run records in `docs/test-runs/`.
- **Final database state:** demo seed intact (1 project, 3 tasks, 3 jobs, 2 approvals, 1 agent, 1 artifact, 2 evidence), 64 audit events, `emergency_pause = false`, no test or probe leftovers.

## Defects found by testing and fixed

Five real bugs, four of them mine, all caught before use:

1. `os_write_audit()` referenced `NEW.project_id` on tables that lack the column — PL/pgSQL resolves record fields at compile time, so every `projects` insert failed. Fixed in `0007` by reading fields from `to_jsonb(NEW)`.
2. `os_actor_type()` returned `NULL` because `v_raw not in (...)` is `NULL` when `v_raw` is `NULL`. Fixed in `0008`, which resolves identity from the request channel instead of a spoofable header.
3. The `audit_events.project_id` foreign key's `ON DELETE SET NULL` fought the append-only trigger, making project deletion impossible. Foreign key dropped in `0008`.
4. Secret redaction over-matched: the `sk-` API-key pattern fired inside the word "risk-management" and mangled an evidence URL. Over-redaction destroys verifiability, so the pattern was anchored and the matcher rewritten to walk structures and mask by key name.
5. Migration `0009` compared `agents.status` to `'disabled'`, which is not in the `agent_status` enum. Every assigned-job insert failed. It failed closed, not open, but was still broken. Fixed in `0010` using `paused`.

## Blockers / open items

- ~~GitHub repo creation is blocked.~~ Pushed. `master` and `feat/job-leasing` are on
  GitHub; the repo is public.
- ~~No service-role key was ever supplied, so the runner has never executed end to
  end.~~ Done — see Verified live below.
- ~~Dashboard authenticated views are unverified.~~ Done — rendered with live data.
- ~~Emergency pause does not stop work already running.~~ Closed by 0011/0012 for any
  worker that heartbeats, and observed with `npm run agent:leasecheck`. Cancellation
  is cooperative and lands between steps, not mid-step.
- `max_concurrent_jobs` is stored but the runner still does not read it. It matters
  once there is more than one worker.
- Nothing is deployed to Vercel.
- The five integration adapters are inert by design.

## Verified live

Run by the owner against the live project, not by the builder:

- `npm run db:guards` — **54/54**, including 34–49 (leasing, lease ownership over the
  PostgREST path, mid-flight pause cancellation, reaping) and 50–54 (approval payload
  binding). Test 53 disables the freeze trigger and shows the digest alone still
  refuses a swapped payload.
- `npx vitest run` — 67/67, including a schema-contract test that reads the migrations
  and checks every column the MCP tools touch.
- **Hermes, in a container, filing work through the MCP server.** It read the pause
  state and project list from the live database; `omnios_policy_check` reported
  send_message as needs_approval; and an attempt to queue `exfiltrate_secrets` was
  refused with OMNIOS_PROHIBITED by the database trigger, three layers below the tool
  it was holding. Hermes read the refusal and stopped rather than retrying.
- `npm run agent:demo` — research and draft jobs completed, artifact and evidence
  filed, `send_message` parked at `awaiting_approval`. Nothing sent.
- `npm run agent:leasecheck` — 41 renewals, pause engaged, 42nd refused with
  `OMNIOS_EMERGENCY_PAUSE`, job moved to `failed`, nothing further attempted.
- Dashboard signed in, all pages rendering live rows.

## Decisions locked

- Hybrid, staged architecture. Mac for development and local agents; Supabase as system of record; Vercel for a dashboard later, only on explicit approval. No always-on worker yet, but `docs/future-worker-vps.md` describes how one attaches without a rewrite.
- Authorisation comes from `auth.uid()`. The `x-omnios-actor` header only attributes; it never grants. The agent's key has no `auth.uid()`, so it can request approvals and never grant them.
- Autonomy level: low-risk operations. Promotion of an action type requires a written reason and cannot be done by an agent.
- Secrets in local `.env` files and encrypted cloud environment variables. Nothing secret in Git; verified by scan before commit.

## Next steps (yours)

1. Create the private GitHub repo and push the existing commit.
2. Create your dashboard user: Supabase → Authentication → Users → Add user, with Auto Confirm enabled.
3. Run `npm run db:claim` so the seeded demo rows belong to your real user id instead of the placeholder.
4. Run the dashboard locally and confirm the seeded approval appears in the queue.
5. Optionally run `npm run agent:demo` with a service-role key in `local-agent/.env`.
