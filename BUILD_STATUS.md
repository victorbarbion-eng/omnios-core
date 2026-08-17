# BUILD_STATUS

Project: **omnios-core** — secure, visible, hybrid personal operating system
Repo (local): `/home/user/workspace/omnios-core`
Supabase project: `omnios-core` / ref `bvxjthifyekabpkmpcji` / eu-west-3 / free tier, $0/month
Last updated: 2026-08-17

## Current phase

Steps 1–8 of the build are complete and verified locally. Nothing has been deployed,
sent, published, or pushed to a remote. Remaining work is in your hands: create the
private GitHub repo and push, create a Supabase Auth user for the dashboard, and
optionally run the agent demo against the live database with a service-role key.

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
- **In-database guard tests:** `tests/db_guards.sql` — **33/33 passing** against the live project (run 4). Covers prohibited actions, illegal state transitions, unapproved execution, human-session requirement for approvals, self-approval block, emergency pause behaviour for read vs write, append-only audit, retry limits, idempotency, RLS isolation between owners, no-delete for the dashboard role, actor-type resolution, stale approval expiry, self-promotion block, and per-agent grant enforcement. Full run records in `docs/test-runs/`.
- **Final database state:** demo seed intact (1 project, 3 tasks, 3 jobs, 2 approvals, 1 agent, 1 artifact, 2 evidence), 64 audit events, `emergency_pause = false`, no test or probe leftovers.

## Defects found by testing and fixed

Five real bugs, four of them mine, all caught before use:

1. `os_write_audit()` referenced `NEW.project_id` on tables that lack the column — PL/pgSQL resolves record fields at compile time, so every `projects` insert failed. Fixed in `0007` by reading fields from `to_jsonb(NEW)`.
2. `os_actor_type()` returned `NULL` because `v_raw not in (...)` is `NULL` when `v_raw` is `NULL`. Fixed in `0008`, which resolves identity from the request channel instead of a spoofable header.
3. The `audit_events.project_id` foreign key's `ON DELETE SET NULL` fought the append-only trigger, making project deletion impossible. Foreign key dropped in `0008`.
4. Secret redaction over-matched: the `sk-` API-key pattern fired inside the word "risk-management" and mangled an evidence URL. Over-redaction destroys verifiability, so the pattern was anchored and the matcher rewritten to walk structures and mask by key name.
5. Migration `0009` compared `agents.status` to `'disabled'`, which is not in the `agent_status` enum. Every assigned-job insert failed. It failed closed, not open, but was still broken. Fixed in `0010` using `paused`.

## Blockers / open items

- **GitHub repo creation is blocked.** The GitHub connector returns `403 user_blocked` on write and user endpoints, so I could not create the private repo. A first local commit exists; you push manually (commands in the README and in the final report).
- **No service-role key was ever supplied**, so the agent runner has never executed end-to-end against the live database from here. It is verified by typecheck, 58 unit tests and the 33 in-database guard tests, not by a live run. Run `npm run agent:demo` on your Mac to close that gap.
- **Dashboard authenticated views are unverified.** No Supabase Auth user exists yet. Every page's query was replayed against live PostgREST (all 200; a bogus column returned `42703`, proving the column names are real), but rendering with data has not been seen.
- `max_concurrent_jobs` is stored but the runner does not read it.
- Emergency pause prevents new write-capable jobs from starting; it does not kill work already running.

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
