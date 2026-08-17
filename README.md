# OmniOS Core

OmniOS Core is a small, local-first operations system for recording projects, tasks, artifacts, evidence, jobs, approvals, agents, and an append-only audit trail. A Mac-local TypeScript runner uses Supabase as the system of record; a separate Next.js dashboard lets a signed-in user review records and decide approvals. The supplied demo proves the record-keeping and approval path with fixed local sources and disabled integration adapters; it does not perform live web research or external actions.

```text
Mac local agent ── service-role API ──> Supabase <── signed-in browser ── Next.js dashboard
       │                                  │
       └── files remain on the Mac        └── policy, guards, RLS, audit, views
```

## Prerequisites

- Node.js 20 or newer (`node --version`)
- An npm account is not required.
- A Supabase project that you control.
- `psql` is **not** required. The maintenance scripts use the Node `pg` package and `SUPABASE_DB_URL`.
- A local folder for agent-managed files. Its path must be absolute.

## Local setup: clone to demo

These steps use the repository's migration and seed scripts. They create a demo project and require a direct database connection string only for the maintenance commands.

1. Clone and install dependencies.

   ```bash
   git clone <your-repository-url> omnios-core
   cd omnios-core
   npm install
   ```

2. Create a Supabase project, or choose an empty project you control. In the Supabase dashboard, open **Project Settings → API** and copy:
   - **Project URL** into `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL`.
   - The **publishable/anon key** into `SUPABASE_ANON_KEY` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
   - The **service-role key** into `SUPABASE_SERVICE_ROLE_KEY`. This is for the local agent only.

3. In **Project Settings → Database**, copy the database connection string in URI form. Put it in `SUPABASE_DB_URL`. It contains the database password and is used only by the migration, seed, ownership, pause, and unseed scripts.

4. Create your local environment file and fill in the values from steps 2–3. Set `OMNIOS_WORKSPACE_ROOT` to an absolute folder you allow the runner to touch, for example `/Users/you/omnios-workspace`.

   ```bash
   cp .env.example .env
   ```

   Keep `.env` private. It is ignored by Git. Do not put the service-role key in any `NEXT_PUBLIC_*` variable.

5. Apply the schema and create the labelled demo records.

   ```bash
   npm run db:migrate
   npm run db:seed
   ```

6. Create a human dashboard account in **Supabase Dashboard → Authentication → Users → Add user**. Use email and password, enable **Auto Confirm User**, then claim any placeholder-owned seed rows.

   ```bash
   npm run db:claim -- you@example.com
   ```

   If the seed ran after an account already existed, it may already be owned by the first account and the claim command will report zero changed rows.

7. Start the dashboard and sign in with that Supabase user at `http://localhost:3100`.

   ```bash
   npm run dashboard
   ```

   The dashboard uses only the two `NEXT_PUBLIC_SUPABASE_*` values and the signed-in session. The seeded project should appear on **Projects**; the pending sample action appears on **Approvals**.

8. Optional: exercise the runner safely first. This still needs `SUPABASE_SERVICE_ROLE_KEY` because it reads policy and settings, but it makes no database writes.

   ```bash
   npm run agent:dry
   ```

9. To run the actual local demonstration, use:

   ```bash
   npm run agent:demo
   ```

   It creates or reuses demo work records, records two fixed NIST source entries, saves an inline draft, and parks `send_message` for approval. It does not send email: the Outlook adapter deliberately throws if asked to execute. Do not re-run the same demo topic after it has completed; the idempotency lookup reuses completed jobs and the next attempted state transition is rejected. Use a different topic or remove demo data first.

## Script reference

| Command | What it does | Required environment |
|---|---|---|
| `npm run typecheck` | Type-checks `packages/shared` and `local-agent`. It does not type-check the dashboard. | none |
| `npm test` | Runs the Vitest unit suite. | none |
| `npm run test:watch` | Runs Vitest in watch mode. | none |
| `npm run db:migrate` | Applies unrecorded SQL migrations in filename order, one transaction per migration. | `SUPABASE_DB_URL` |
| `npm run db:seed` | Inserts the clearly labelled demo rows. Safe to repeat while demo rows exist. | `SUPABASE_DB_URL` |
| `npm run db:unseed` | Previews removal of rows marked `is_demo=true`; use `npm run db:unseed -- --yes` to remove them. Audit history remains. | `SUPABASE_DB_URL` |
| `npm run db:claim -- you@example.com` | Reassigns placeholder-owned seed rows to the matching Supabase Auth user. | `SUPABASE_DB_URL` |
| `npm run agent` | Starts the local-agent CLI; no subcommand means `status`. | agent variables, including service-role key |
| `npm run agent -- register` | Registers or refreshes the configured local agent row. | agent variables, including service-role key |
| `npm run agent:demo` | Runs the fixed-source research-to-approval demo. | agent variables, including service-role key |
| `npm run agent:dry` | Runs the demo with database writes simulated. | agent variables, including service-role key |
| `npm run agent:refusals` | Prints policy and workspace-refusal checks. | agent variables, including service-role key |
| `npm run agent -- check <action_type>` | Shows the runner's advisory policy decision for one action type. | agent variables, including service-role key |
| `npm run agent -- approvals` | Prints a reminder that approvals are decided in the dashboard; it does not query or decide them. | agent variables, including service-role key |
| `npm run pause` | Engages the emergency pause through a direct database connection. | `SUPABASE_DB_URL` |
| `npm run resume` | Releases the emergency pause. | `SUPABASE_DB_URL` |
| `npm run dashboard` | Starts the Next.js dashboard development server on port 3100. | dashboard public variables |

## Verification status

**Verified:** `npx vitest run` reports 58/58 TypeScript unit tests passing across policy, workspace-boundary, redaction, and adapter tests. The final database guard run reports 30/30 passing against the migrated Supabase project; it covers prohibited actions, job transitions, approval identity, pause behavior, append-only audit history, policy promotion, expiry, retries, idempotency, RLS, actor attribution, and project-deletion history retention.

**Not yet verified:** the builder did not execute the local runner end to end with a service-role key, because that key was not supplied to the builder. The runner paths are therefore supported by type-checking, unit tests, and the database guard suite, not by a recorded live runner execution. The dashboard has local implementation and build output in the workspace, but no Vercel deployment has been made.

## Read next

- [Architecture](docs/architecture.md)
- [Security and secrets](docs/security-and-secrets.md)
- [Approval policy](docs/approval-policy.md)
- [Operations runbook](docs/operations-runbook.md)
- [Data model](docs/data-model.md)
- [Known limitations](docs/known-limitations.md)
