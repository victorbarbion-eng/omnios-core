# Security and secrets

## Secret inventory and placement

| Value | Where it belongs | Used by | Notes |
|---|---|---|---|
| `SUPABASE_URL` | root `.env`; encrypted environment variable if a server-side deployment is added | local agent runner only | Project REST/Auth URL. It is not a credential. Maintenance scripts use `SUPABASE_DB_URL`, not this value. |
| `SUPABASE_SERVICE_ROLE_KEY` | root `.env` on the Mac only; a separate encrypted secret for any future server/worker | local agent runner only | Bypasses RLS. Never place it in the dashboard, browser, `NEXT_PUBLIC_*`, logs, or Git. |
| `SUPABASE_DB_URL` | root `.env` on the owner machine only | `scripts/migrate.ts`, `seed.ts`, `unseed.ts`, `claim-ownership.ts`, and `pause.ts` only | Direct PostgreSQL URI with database password. The agent runner does not use it. |
| `SUPABASE_ANON_KEY` | root `.env` when a non-dashboard user client needs it | shared `createUserClient()` helper; not used by the current local runner or maintenance scripts | Public/publishable key duplicate for root-level configuration. |
| `NEXT_PUBLIC_SUPABASE_URL` | `apps/dashboard/.env.local` for local work; encrypted Vercel environment variable if deployed | dashboard only | Public project URL compiled into the browser. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `apps/dashboard/.env.local` for local work; encrypted Vercel environment variable if deployed | dashboard only | Public/publishable key. Browser access is constrained by the signed-in session and RLS. |

The root `.env.example` contains both the root values and dashboard variables as a convenience. `apps/dashboard/.env.example` contains only the two public dashboard variables. `.env` and `.env.*` are ignored by the root `.gitignore`, except for `.env.example` templates.

## Non-code credentials

Keep human account passwords, recovery codes, and similar personal credentials in Apple Passwords. Do not put them in `.env`, database records, agent configuration references, or a Git commit. The database explicitly treats `agents.configuration_reference` as a pointer and has a check intended to reject obvious credential-shaped values.

For local development, `.env` is the working location for service credentials. For a future cloud deployment, store the relevant component-specific values as encrypted environment variables in Vercel (dashboard) or Supabase/server infrastructure as appropriate; do not copy a local `.env` into a deployment image. Nothing has been deployed to Vercel in this repository yet.

## Why the service-role key needs special handling

The Supabase service-role key bypasses row-level security. The local runner uses it so it can register an agent and write system records without a human browser session. It is still subject to the database triggers, so it cannot approve an approval (no `auth.uid()`), start a gated job without an approved record, modify or delete audit history, or start non-read work during emergency pause.

That is not permission to distribute the key. Anyone holding it can bypass RLS, so it must never reach a browser bundle, a Next.js client component, a `NEXT_PUBLIC_*` variable, or an external adapter. The dashboard source creates its Supabase client from the publishable key and user cookies only.

## Rotation and revocation

Rotate one credential type at a time, update only the component that uses it, verify that component, then revoke or retire the old credential. Record why a rotation occurred in your password manager or operating log without copying the secret value.

### `SUPABASE_SERVICE_ROLE_KEY`

1. Stop the local runner and any future worker using the key.
2. In the Supabase dashboard, open **Project Settings → API** (or the project API-key management screen) and rotate/revoke the service-role or secret key.
3. Replace `SUPABASE_SERVICE_ROLE_KEY` in the Mac's root `.env` and, if ever created, the future worker's encrypted environment variable. Do not change `apps/dashboard/.env.local`.
4. Run `npm run agent:dry` and `npm run agent -- status` locally to verify the replacement key can read policy and settings.
5. Remove the old key from every secret store and restart only the agent/worker process. If exposure is suspected, treat the old key as compromised and rotate immediately rather than waiting for a planned window.

### `SUPABASE_DB_URL` / database password

1. Stop local maintenance commands and future automation that uses the direct URI.
2. In **Project Settings → Database**, reset or rotate the database password and generate the new URI connection string.
3. Replace only `SUPABASE_DB_URL` in the owner's root `.env` and any protected maintenance-only secret store. The dashboard and local agent do not use this value.
4. Verify with a non-destructive command such as `npm run db:migrate`; already-applied migrations should be reported as already applied.
5. Remove saved copies of the old URI. It contains the password, so redact it from tickets and logs.

### `SUPABASE_ANON_KEY` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`

These represent the same publishable/browser credential in this setup.

1. In the Supabase API-key management screen, rotate or retire the publishable/anon key according to the project key controls.
2. Replace `SUPABASE_ANON_KEY` in root `.env` if local code uses it, and replace `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `apps/dashboard/.env.local`.
3. If the dashboard is later deployed, update the matching encrypted Vercel environment variable, redeploy, and confirm sign-in and an RLS-protected page work.
4. Retire the old key once all dashboard instances use the new value. This key is intentionally public, but a rotation invalidates old browser configuration and should be coordinated.

### `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL`

The project URL is configuration, not a secret, and cannot be meaningfully revoked independently of the project. If moving to another Supabase project:

1. Create and migrate the replacement project.
2. Update `SUPABASE_URL` in the agent/maintenance `.env` and `NEXT_PUBLIC_SUPABASE_URL` in dashboard local/deployment configuration.
3. Update the matching keys for the new project at the same time, test migration, dashboard sign-in, and a dry agent run.
4. Disable or delete the old project only after its required data-retention and backup decisions are complete.

## Redaction is a safety net, not a control

`packages/shared/src/redact.ts` masks several credential-shaped strings (JWTs, Supabase keys, provider key formats, connection-string passwords, PEM private keys, bearer tokens, and secret-shaped object keys). The runner uses it before printing or storing job-log text and when writing selected JSON payloads, artifacts, evidence excerpts, and approval payloads. The audit trigger also deliberately omits full inline bodies, excerpts, action payloads, input references, and descriptions from its snapshots.

It is a safety net because it recognizes patterns after text has already entered the process. It cannot prove that every secret has a recognizable form, stop a secret from being sent to an external system, or compensate for putting a secret in a record in the first place. The primary control is least distribution: keep credentials in environment variables or Apple Passwords, pass them only to the component that needs them, and never write them into application data.

Over-redaction is also a real failure mode. Testing found that an unanchored `sk-` pattern matched inside the ordinary word `risk-management` and damaged a NIST evidence URL. The current provider-key patterns use non-word boundaries so evidence URLs remain verifiable while actual key-shaped values are masked.
