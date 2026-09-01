-- =============================================================
-- 0016_signin_allowlist.sql
--
-- Written because the dashboard is about to be deployed to a public
-- URL, but the hole it closes has been open since the project started
-- and has nothing to do with hosting.
--
-- THE PROBLEM, in one sentence: being a human is the only privilege
-- that matters here, and until now anything could become one.
--
-- Every guard in this system rests on a single line — `auth.uid() is
-- not null`. An agent holds the service-role key, which grants it
-- almost everything, and is stopped at exactly one place: it has no
-- signed-in human session, so it cannot approve. That is the thesis.
--
-- But Supabase's Auth admin API (`POST /auth/v1/admin/users`) accepts
-- the service-role key. Anything holding that key could create a
-- confirmed user, sign in as it, and arrive back with a real
-- auth.uid(). Row-level security means the new identity would own
-- nothing and so could approve nothing — which is why this is a hole
-- and not yet a breach — but "cannot approve" would have stopped being
-- structural and started being a side effect of RLS scoping.
--
-- Deploying the dashboard publicly adds a second, duller version of
-- the same problem: Supabase permits self-signup with the publishable
-- key by default, and the publishable key is in every browser bundle
-- by design. The login page says "there is no signup here on purpose",
-- which is a sentence, not a control.
--
-- WHAT THIS DOES. A BEFORE INSERT trigger on auth.users refuses any
-- account whose email is not listed in public.auth_allowlist. It sits
-- below both routes, because both of them ultimately insert a row
-- there: the Auth admin API does, and self-signup does.
--
-- WHY THE ALLOWLIST ITSELF IS UNREACHABLE OVER THE API. This table is
-- the lock on the door marked "human". If a key could write to it, the
-- key could let itself through, and the migration would be theatre.
-- So: privileges are revoked from anon, authenticated and service_role
-- (Supabase's default privileges grant new public tables to all three,
-- so revoking is not optional), RLS is on with no policies, and a
-- trigger refuses any write that arrives as an API request. Three
-- overlapping controls for one table, because it is the table that
-- decides who counts as a person.
--
-- Editing it requires a direct database session — you, with
-- SUPABASE_DB_URL, in a terminal.
--
-- THE BOOTSTRAP EXEMPTION, and why it is not the mistake 0015 fixed.
-- An empty allowlist permits one insert, and records that email. 0014
-- failed open on a missing budget row and 0015 rightly closed it: a
-- limit that evaporates when a row is absent is not a limit. This is a
-- different shape. With zero users there is no account to protect and
-- no other way in — refusing would mean a fresh project could never
-- have a first user. The exemption closes permanently the moment it is
-- used: the first account through the door locks it behind itself.
--
-- WHAT THIS DOES NOT DO — read this part.
-- It stops accounts being CREATED. It does not stop an existing
-- account being CHANGED. The Auth admin API can also reset any user's
-- password with the service-role key, and a database trigger cannot
-- tell that call apart from your own legitimate password reset: both
-- reach Postgres as `supabase_auth_admin`, with no session and no API
-- headers. Refusing password changes would lock you out of your own
-- recovery.
--
-- So the honest statement is: after this migration, the service-role
-- key can still become you. Closing that needs the narrow-role rebuild
-- in docs/known-limitations.md — agents holding a key that is not
-- service_role, so the Auth admin API refuses them. That was already
-- the number one improvement on the list. It is now the number one
-- improvement for a sharper reason than "tidier privileges".
-- =============================================================

create table if not exists public.auth_allowlist (
  email       text primary key,
  note        text,
  added_at    timestamptz not null default now()
);

comment on table public.auth_allowlist is
  'Emails permitted to hold an account. Enforced by a trigger on auth.users, so it binds self-signup and the Auth admin API alike. Deliberately unreachable over the API: editing it requires a direct database session.';

create unique index if not exists auth_allowlist_email_lower on public.auth_allowlist (lower(email));

-- Normalise on the way in so 'You@Example.com' and 'you@example.com'
-- cannot be two different answers to the same question.
create or replace function os_normalise_allowlist_email() returns trigger
language plpgsql as $$
begin
  new.email := lower(trim(new.email));
  if new.email = '' or new.email not like '%@%' then
    raise exception 'OMNIOS_ALLOWLIST_BAD_EMAIL: % does not look like an email address.', new.email
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists auth_allowlist_normalise on public.auth_allowlist;
create trigger auth_allowlist_normalise
  before insert or update on public.auth_allowlist
  for each row execute function os_normalise_allowlist_email();

-- ---- The allowlist is not writable over the API ----------------
create or replace function os_guard_allowlist_not_via_api() returns trigger
language plpgsql as $$
begin
  if os_is_api_request() then
    raise exception
      'OMNIOS_ALLOWLIST_LOCAL_ONLY: auth_allowlist may only be changed from a direct database session. This table decides who counts as a signed-in human, so a connection holding a key must not be able to add itself to it.'
      using errcode = 'insufficient_privilege';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists auth_allowlist_local_only on public.auth_allowlist;
create trigger auth_allowlist_local_only
  before insert or update or delete on public.auth_allowlist
  for each row execute function os_guard_allowlist_not_via_api();

alter table public.auth_allowlist enable row level security;
-- No policies on purpose. With RLS on and nothing defined, anon and
-- authenticated see nothing. service_role bypasses RLS, which is why
-- the revoke below is the control that actually matters for it:
-- bypassing row-level security is not the same as having a grant.
revoke all on public.auth_allowlist from anon, authenticated, service_role;

-- ---- Seed from whoever already exists ---------------------------
-- Run before the trigger is installed, so an existing project keeps
-- working and you do not lock yourself out of your own account.
insert into public.auth_allowlist (email, note)
select lower(u.email), 'seeded by migration 0016 from an existing account'
  from auth.users u
 where u.email is not null
on conflict (email) do nothing;

-- ---- The trigger on auth.users ----------------------------------
create or replace function os_guard_signup_allowlist() returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text := lower(trim(coalesce(new.email, '')));
  v_count integer;
begin
  select count(*) into v_count from public.auth_allowlist;

  -- Bootstrap: an empty allowlist admits one account and closes behind it.
  if v_count = 0 then
    if v_email <> '' then
      insert into public.auth_allowlist (email, note)
      values (v_email, 'first account on an empty allowlist; the door locked behind it')
      on conflict (email) do nothing;
    end if;
    return new;
  end if;

  if v_email = '' then
    raise exception
      'OMNIOS_SIGNUP_REFUSED: an account with no email address cannot be checked against the allowlist, so it is refused.'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.auth_allowlist a where a.email = v_email) then
    raise exception
      'OMNIOS_SIGNUP_REFUSED: % is not on the sign-in allowlist. Accounts are not created by signing up, and not by an API key either. Add the address from a direct database session first: insert into auth_allowlist (email) values (...);',
      v_email
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function os_guard_signup_allowlist is
  'Refuses an auth.users insert whose email is not allowlisted. Binds both self-signup with the publishable key and the Auth admin API with the service-role key, because both create the row here. Does not bind password changes to an existing account: see the header of 0016.';

-- Installing this touches the auth schema, which this role may not own
-- on every Supabase plan or in every future version. A failure must not
-- abort the migration and leave the rest of the schema unapplied — but
-- it must not pass quietly either. Guard test 65 asserts the trigger is
-- really present, so a warning here becomes a visible failure there.
do $$
begin
  execute 'drop trigger if exists users_signup_allowlist on auth.users';
  execute 'create trigger users_signup_allowlist before insert on auth.users '
       || 'for each row execute function os_guard_signup_allowlist()';
exception when others then
  raise warning
    'OMNIOS_ALLOWLIST_NOT_INSTALLED: could not create the trigger on auth.users (%). The allowlist table exists but nothing enforces it. Guard test 65 will fail until this is resolved; do not treat sign-up as closed.',
    sqlerrm;
end;
$$;
