# OmniOS — Operations Dashboard

A dense, utilitarian read-mostly console over the OmniOS Supabase schema: projects, agents, tasks,
artifacts, evidence, jobs, approvals, policy and audit. Next.js 15 (App Router) + TypeScript +
Tailwind CSS.

Two design rules shape the whole app:

1. **No privileged key.** The only credentials here are the public Supabase URL and publishable
   (anon) key. Every query runs through the signed-in user's cookie session, so row-level security
   decides what is visible. There is no service-role key, and nothing in this app should ever read
   one.
2. **The database is the authority.** Approving or denying a request issues one `update approvals
   set status = ..., decision_note = ...`. The dashboard contains no policy logic: the triggers in
   `supabase/migrations/0004`, `0006` and `0008` enforce the rules and their raw Postgres error
   messages (`OMNIOS_HUMAN_SESSION_REQUIRED`, `OMNIOS_NOT_PENDING`, `OMNIOS_EXPIRED`, …) are shown
   to you verbatim.

## Install

```bash
cd apps/dashboard
npm install          # npm workspaces install hoists to the repo root node_modules
```

## Environment

```bash
cp .env.example .env.local
```

`.env.local` needs exactly two variables — both are public by design:

```
NEXT_PUBLIC_SUPABASE_URL=https://bvxjthifyekabpkmpcji.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_fcHQPvWdgl962E2LV3H_8w_U8ePMlkW
```

Never add a service-role/secret key: it would bypass RLS, and the approval guard specifically
refuses key-only API traffic anyway. `.env.local` is excluded by the repo root `.gitignore`
(`.env.*`).

## Create the first user by hand

There is no signup screen, no magic link and no OAuth. Create your account in the Supabase
dashboard:

1. Open **Authentication → Users → Add user**.
2. Enter an email and password, and tick **Auto Confirm User**.
3. Sign in at `/login` with those credentials.

The account owns rows via `owner_id = auth.uid()`, so a brand-new user sees empty tables until rows
exist for it — every view has an explicit "nothing here yet" state.

## Run

```bash
npm run dev        # http://localhost:3100
npm run build      # production build, includes full TypeScript check
npm start          # serve the production build on :3100
npm run typecheck  # tsc --noEmit
```

## Routes

| Route            | What it shows                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/login`         | Email + password sign-in, plus the manual account-creation note. The only public route.                                                                                        |
| `/`              | Overview: project count, tasks by status, active / failed / awaiting-approval job counts, pending approvals, autonomy level and emergency-pause state, 15 most recent audit events. |
| `/projects`      | Table of `v_project_summary`.                                                                                                                                                  |
| `/projects/[id]` | Project header plus its tasks, artifacts, evidence, jobs and recent approval decisions.                                                                                        |
| `/agents`        | Agent register (status, relative `last_seen_at`, runtime, allowed-action count with expandable list, project scope, config pointer) plus each agent's recent jobs and errors.    |
| `/approvals`     | Pending queue as cards: full `action_preview` in a monospace block, `action_payload` as formatted JSON, expiry flagged when past, Approve / Deny with a note required to deny.   |
| `/audit`         | Filterable append-only history (project, actor_type, action substring, entity_type) with 50 rows per page and prev/next paging.                                                 |
| `/jobs`          | `v_job_activity`: status, job_type, risk level, agent, duration, attempts vs max_attempts, output artifact, and a prominent failure panel with `error_summary`.                  |
| `/jobs/[id]`     | Job record, `input_reference`, approvals for that job, and the `job_logs` timeline.                                                                                             |
| `/policy`        | Read-only autonomy matrix from `action_policies`, grouped by `risk_level`, plus the emergency-pause control (two-step confirmation, calls `os_set_emergency_pause`).             |

Unauthenticated requests to anything other than `/login` are redirected to `/login` by
`src/middleware.ts`; the `(console)` layout re-checks the session server-side.

## How approve / deny is wired

`src/app/(console)/approvals/actions.ts` is a server action that:

- validates only the form itself (a denial must carry a note),
- opens a Supabase client bound to the caller's cookie session (publishable key),
- runs `update approvals set status = 'approved' | 'denied', decision_note = … where id = …`,
- never touches `jobs`, never inspects `risk_level` or `expires_at`, never uses a privileged key,
- and on failure redirects back with the Postgres `message`, `details`, `hint` and `code` rendered
  verbatim at the top of `/approvals`.

The emergency pause on `/policy` behaves the same way: a two-step confirmation, then
`supabase.rpc('os_set_emergency_pause', { p_on, p_reason })`, with any error surfaced verbatim.

## Reading the colours

Neutral grey = queued / backlog · blue = running / in_progress · amber = awaiting_approval /
pending · green = completed / done / approved · red = failed / denied · dim = cancelled / expired.
Each panel header names the table or view it came from, so every number on screen is traceable.
