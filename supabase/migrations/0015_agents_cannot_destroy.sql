-- =============================================================
-- 0015_agents_cannot_destroy.sql
--
-- The gap this closes has been in docs/known-limitations.md since the
-- MCP server landed: an agent holds the service-role key, which bypasses
-- row-level security. The guards stop it acting WRONGLY — it cannot
-- approve, promote itself, run prohibited work, or execute an unapproved
-- action. Nothing stopped it DESTROYING. It could delete every project
-- and artifact you own. Audit history would survive; the work would not.
--
-- That asymmetry existed because every guard so far was written against
-- the question "may this happen?" and deletion was never something an
-- agent was supposed to want, so nobody wrote a rule about it. Absence
-- of intent is not a control.
--
-- WHAT COUNTS AS "AN AGENT" HERE, and why it cannot be faked.
--
-- os_actor_type() would be the obvious predicate and is the wrong one:
-- it takes an explicit `x-omnios-actor` header at face value, by design,
-- because it exists for ATTRIBUTION. An agent could send
-- `x-omnios-actor: user` and walk through a guard built on it. That has
-- always been fine — attribution grants nothing — but it makes it
-- useless for authorisation.
--
-- The predicate used here is the same one os_set_emergency_pause() has
-- relied on since 0008: `auth.uid() is null and os_is_api_request()`.
-- In words: this request arrived through PostgREST with a key, and there
-- is no signed-in human behind it. The caller controls neither half.
-- PostgREST populates request.headers itself, and a JWT with a real
-- `sub` cannot be minted without the human logging in.
--
-- So this reaches exactly the connections that should never destroy
-- anything — the runner and the MCP server — while leaving alone:
--   * you at a terminal (scripts/, db:unseed, migrations): not an API
--     request, so untouched. Deleting your own data stays easy.
--   * the dashboard: a signed-in human has auth.uid(), and separately
--     has no DELETE policy under RLS anyway.
--
-- WHAT THIS DOES NOT DO. It stops deletion, not destruction. An agent
-- with that key can still blank an artifact's body or rename a project
-- to nonsense — a legitimate update and a vandalising one are the same
-- statement. Closing that needs the narrow-role rebuild the limitations
-- file describes, where agents reach tables only through SECURITY
-- DEFINER functions. This is the cheap 90%, and it is worth being clear
-- that it is not the whole thing.
-- =============================================================

create or replace function os_is_keyed_agent_connection() returns boolean
language plpgsql stable as $$
begin
  -- Both halves are outside the caller's control: PostgREST sets the
  -- request headers, and auth.uid() requires a real signed-in session.
  return auth.uid() is null and os_is_api_request();
end;
$$;

comment on function os_is_keyed_agent_connection is
  'True for a request that arrived over the API with a key and no human behind it. Unlike os_actor_type(), which trusts a caller-supplied header for attribution, neither half of this can be faked — so it is safe to authorise against.';

create or replace function os_guard_no_agent_delete() returns trigger
language plpgsql as $$
begin
  if os_is_keyed_agent_connection() then
    raise exception
      'OMNIOS_AGENT_CANNOT_DELETE: a key-based connection with no signed-in human may not delete from %. Records are removed by a person, from the dashboard or a direct database session. If an agent believes something should go, it can say so; it cannot do it.',
      tg_table_name
      using errcode = 'insufficient_privilege';
  end if;
  return old;
end;
$$;

comment on function os_guard_no_agent_delete is
  'Refuses DELETE from an API connection with no human session. Closes the gap where an agent could not act wrongly but could still destroy everything.';

do $$
declare t text;
begin
  foreach t in array array['projects','tasks','artifacts','evidence','jobs','approvals','agents','action_policies','usage_budgets']
  loop
    execute format('drop trigger if exists %I_no_agent_delete on %I', t, t);
    execute format(
      'create trigger %I_no_agent_delete before delete on %I for each row execute function os_guard_no_agent_delete()',
      t, t);
  end loop;
end;
$$;

-- ---- Ownership cannot be reassigned by a key ------------------
-- Deleting is not the only way to make a row disappear. Moving it to
-- another owner takes it out of your view just as effectively, and would
-- pass every guard above.
create or replace function os_guard_owner_immutable() returns trigger
language plpgsql as $$
begin
  if new.owner_id is distinct from old.owner_id and os_is_keyed_agent_connection() then
    raise exception
      'OMNIOS_OWNER_IMMUTABLE: a key-based connection may not change owner_id on %. Reassigning ownership hides a row as effectively as deleting it.',
      tg_table_name
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

comment on function os_guard_owner_immutable is
  'Refuses an owner_id change from a keyed connection. Handing a row to another owner removes it from view as thoroughly as deleting it, so the same rule applies.';

do $$
declare t text;
begin
  foreach t in array array['projects','tasks','artifacts','evidence','jobs','approvals','agents']
  loop
    execute format('drop trigger if exists %I_owner_immutable on %I', t, t);
    execute format(
      'create trigger %I_owner_immutable before update on %I for each row execute function os_guard_owner_immutable()',
      t, t);
  end loop;
end;
$$;

-- ---- Budget now fails closed ---------------------------------
-- 0014 failed open when an owner had no budget row, hedging against a
-- new owner silently losing the ability to work. On a single-owner
-- system that scenario does not exist, and failing open costs the
-- guarantee while buying nothing. A limit that depends on a row being
-- present is not a limit.
create or replace function os_guard_job_budget() returns trigger
language plpgsql as $$
declare
  v_risk  risk_class;
  v_max   integer;
  v_used  integer;
begin
  if new.is_demo then
    return new;
  end if;

  v_risk := os_risk_level(new.job_type);

  select max_per_day into v_max
    from usage_budgets
   where owner_id = new.owner_id and risk_level = v_risk;

  if v_max is null then
    raise exception
      'OMNIOS_NO_BUDGET: no daily budget is configured for owner % at risk class %, so there is no limit to enforce and this job is refused. Insert a row in usage_budgets. (A trigger on projects seeds defaults for every new owner; if you are seeing this, that seeding did not happen and is worth understanding before you paper over it.)',
      new.owner_id, v_risk
      using errcode = 'check_violation';
  end if;

  select count(*) into v_used
    from jobs
   where owner_id = new.owner_id
     and is_demo = false
     and created_at >= date_trunc('day', now())
     and os_risk_level(job_type) = v_risk;

  if v_used >= v_max then
    raise exception
      'OMNIOS_BUDGET_EXCEEDED: % jobs of risk class % already created today, and the daily budget is %. Nothing is wrong with this job in particular; there have simply been too many. Raise the budget in usage_budgets if this is legitimate, and look at what is queueing them if it is not.',
      v_used, v_risk, v_max
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function os_guard_job_budget is
  'Refuses job creation once the owner''s daily allowance for that risk class is spent, and refuses outright when no allowance is configured. Fails closed as of 0015.';
