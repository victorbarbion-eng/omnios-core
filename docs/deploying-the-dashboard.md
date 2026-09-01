# Deploying the dashboard

Approving currently requires you to be at the Mac with `npm run dashboard`
running. `docs/known-limitations.md` has named that as a real problem since the
beginning, for a specific reason: the design says approval fatigue — clicking
yes on autopilot — is how these systems fail in practice, and then makes
deciding inconvenient enough that you would batch decisions and skim them. The
schema cannot reach that failure. Only the user experience can.

This puts the console on a public URL so you can decide from a phone.

---

## What does not change, and why that is the point

The obvious version of "approvals off the Mac" is an email with an **Approve**
button in it. That version is wrong, and it is worth understanding why before
you build anything.

Every guard in this project reduces to one line:

```sql
if auth.uid() is null then raise exception 'OMNIOS_HUMAN_SESSION_REQUIRED' ...
```

An agent holds the service-role key. It can read almost anything and write
most things. It is stopped at exactly one place: it has no signed-in human
session, so `auth.uid()` is null, so it cannot approve. Not "is not allowed
to" — cannot. That is the whole thesis.

A one-click approve link would be a service acting on your behalf. Something
would hold a credential and turn a click into a decision, and the database
would have to accept that as a human. The moment that exists, the guard is
decoration.

So the last click still happens inside a real signed-in session. What this
removes is the **laptop** and the **dev server**, not the sign-in. You sign in
once on your phone; the session persists; the button is a bookmark away.

---

## Before you deploy: apply migration 0016

Putting the console on the internet without this would be careless, and the
migration closes a hole that has nothing to do with hosting.

**In the Terminal**, in your `omnios-core` folder:

```bash
npm run db:migrate
npm run db:guards
```

You should see `0016_signin_allowlist.sql ... ok` and then **70/70**.

Tests 65 to 70 are the new ones. If **65** fails, stop: the migration warned
instead of failing, the allowlist table exists, and nothing is enforcing it.
Do not deploy until that is understood.

### What 0016 does

Supabase permits self-signup with the publishable key by default, and the
publishable key is in every browser bundle on purpose. The login page says
"there is no signup here on purpose", which is a sentence, not a control.

More importantly — and this was true before any of this deployment work —
Supabase's Auth admin API (`POST /auth/v1/admin/users`) accepts the
**service-role key**. Anything holding that key could create a confirmed user,
sign in as it, and come back with a real `auth.uid()`.

0016 puts a trigger on `auth.users` that refuses any account whose email is not
in `public.auth_allowlist`. It sits below both routes, because both of them
end up inserting a row in that table.

The allowlist itself is deliberately unreachable over the API: privileges
revoked from `anon`, `authenticated` and `service_role`, row-level security on
with no policies, and a trigger that refuses any write arriving as an API
request. Three overlapping controls on one small table, because it is the
table that decides who counts as a person. If a key could write to it, the key
could let itself through.

Editing it needs a direct database session — you, in a terminal:

```bash
psql "$SUPABASE_DB_URL" -c "insert into auth_allowlist (email) values ('someone@example.com');"
```

### What 0016 does not do — read this part

It stops accounts being **created**. It does not stop an existing account
being **changed**.

The Auth admin API can also reset any user's password with the service-role
key. A database trigger cannot tell that call apart from your own legitimate
password reset: both arrive as `supabase_auth_admin`, with no session and no
API headers. Refusing password changes would lock you out of your own
recovery.

So the honest statement is: **the service-role key can still become you.**

Closing that needs the narrow-role rebuild already sitting at number one in
`docs/known-limitations.md` — agents holding a key that is not `service_role`,
so the Auth admin API refuses them outright. That item used to be justified by
tidiness. It is now justified by this.

---

## Step 1 — Supabase settings

**In the Supabase dashboard** (browser), open your project.

1. **Authentication → Sign In / Providers → General configuration**: turn
   **Allow new users to sign up** off.

   The database trigger already refuses unlisted addresses. This turns the
   attempt away at the front door instead of at the last one, which keeps your
   logs readable and does not depend on the trigger surviving a future
   migration.

2. **Authentication → Attack Protection**: turn on leaked-password protection
   if it is available on your plan.

3. Make sure your own account password is long and unique, and stored in Apple
   Passwords. Once the console is public, that password plus your email is the
   whole distance between the internet and a button marked Approve. It was
   always the whole distance; it was just behind `localhost` before.

4. **Authentication → URL Configuration**: once you have the Vercel URL from
   step 2, put it in **Site URL**. Password-based sign-in does not need it, but
   password-reset emails do, and you want that link pointing at the console
   rather than at localhost on a machine you may not be sitting at.

---

## Step 2 — Vercel

**In a browser**, at vercel.com. Nothing here happens in the Terminal.

1. Sign in with GitHub.
2. **Add New… → Project**, and import `victorbarbion-eng/omnios-core`.
3. Before deploying, click **Edit** next to **Root Directory** and choose
   `apps/dashboard`.

   This matters for a reason you have already been bitten by: Tailwind's
   PostCSS plugin resolves `tailwind.config.ts` relative to the working
   directory. Build from the repo root and it finds no config, silently falls
   back to an empty one, and ships a stylesheet about a third of the right
   size — the app works and looks unstyled. Setting the root directory is what
   makes Vercel build from inside `apps/dashboard`, which is the same thing as
   the `cd apps/dashboard && npx next build` line in the README.

4. Add two **Environment Variables**:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://bvxjthifyekabpkmpcji.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | your publishable key |

   Those two, and nothing else. **Do not add `SUPABASE_SERVICE_ROLE_KEY` or
   `SUPABASE_DB_URL`.** The dashboard has never used them — `createClient()`
   builds a client from the publishable key and your cookie session, so every
   query it makes runs under row-level security as you. Adding a service-role
   key to this app would not "make it work better"; it would remove the reason
   the app is safe to expose at all.

5. **Deploy.** The build takes a couple of minutes.

If the install step fails complaining about workspaces, look in **Settings →
Build and Deployment → Root Directory** for the option about including files
outside the root directory, and make sure it is on: this is an npm workspace,
so the lockfile lives at the repo root.

---

## Step 3 — Sign in from your phone

Open the Vercel URL on your phone, sign in with the same email and password you
use locally, and add it to your home screen. On iOS: Share → Add to Home
Screen. It then opens like an app, and the session persists, so it is two taps
from locked phone to the approvals list.

Check the emergency pause is there too. Being able to stop everything from a
phone is arguably worth more than being able to approve from one.

---

## Step 4 — Verify, rather than assume

**In the Terminal:**

```bash
# Security headers are actually being sent.
curl -sI https://YOUR-URL.vercel.app/login | grep -i "frame-ancestors\|x-frame-options\|strict-transport"

# The console redirects a signed-out visitor instead of serving anything.
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://YOUR-URL.vercel.app/approvals
```

Expect the three headers, and a `307` to `/login`.

**In the browser**, signed out, try `https://YOUR-URL.vercel.app/approvals`
directly. You should land on the login page and nothing about your data should
be visible in the page source.

Then sign in and decide something real. A control you have not exercised is a
belief.

---

## What deploying actually changed, honestly

**Closed:** self-signup, which was open on the Supabase project all along.
Arbitrary account creation via the Auth admin API. An open-redirect in the
`next=` parameter that survived a successful sign-in — harmless on localhost,
a credible phishing primitive on a public domain. Clickjacking of the approve
button, via `frame-ancestors`, which matters because a framed click is a
*genuine* decision by a *genuine* session and no database guard can see
anything wrong with it.

**Opened:** your login page is now reachable by anyone on the internet. The
password is doing real work now.

**Unchanged:** everything the agent can and cannot do. It still cannot approve,
cannot delete, cannot reassign ownership, cannot exceed its budget, cannot
execute an action whose payload differs from the one that was approved. None
of that is affected by where the dashboard is hosted, which is the useful
consequence of putting the rules in the database instead of in the app.

**Still open:** the service-role key can reset your password through the Auth
admin API and sign in as you. See the narrow-role rebuild in
`docs/known-limitations.md`.
