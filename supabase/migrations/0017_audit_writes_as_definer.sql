-- =============================================================
-- 0017_audit_writes_as_definer.sql
--
-- Found by approving something in the dashboard, which is a sentence
-- that should not appear this late in a project whose entire purpose is
-- the approval path.
--
-- THE SYMPTOM. Clicking Approve as a signed-in human returned:
--
--   new row violates row-level security policy for table "audit_events"
--   code: 42501
--
-- THE CAUSE. `approvals_audit` fires `os_write_audit()` AFTER the
-- update, and that function inserts into `audit_events`. It was a plain
-- SECURITY INVOKER function, so the insert ran with the caller's
-- privileges. Migration 0005 gave `audit_events` a SELECT policy for
-- `authenticated` and no INSERT policy — correctly, since a browser
-- client has no business writing audit rows directly. The consequence
-- was that the audit write failed, and because it is part of the same
-- transaction, the approval failed with it.
--
-- So the approval trail worked for everything EXCEPT a real signed-in
-- human, which is the only actor allowed to approve. The one path that
-- mattered was the one path that could not write its own history.
--
-- THE FIX. `os_write_audit()` becomes SECURITY DEFINER. The audit trail
-- is a property of the system, not an action of the actor, and it
-- should not be subject to the actor's permissions — for the same
-- reason it is append-only: what gets recorded must not depend on who
-- is being recorded. An actor who lacked an INSERT grant would
-- otherwise have been able to prevent their own action being audited,
-- which is a worse failure than the one actually observed.
--
-- The alternative — granting `authenticated` an INSERT policy on
-- audit_events — was rejected. It would let any signed-in client write
-- arbitrary audit rows over PostgREST, turning the record of what
-- happened into something a participant can compose. The trigger is the
-- only legitimate writer, so the trigger is what gets the privilege.
--
-- `search_path` is pinned, as it must be on any SECURITY DEFINER
-- function: without it a caller could put a schema of their own in
-- front and have this function call their `os_actor_type()` instead.
--
-- Nothing else changes. The body is identical to 0007's, which fixed
-- the compile-time field resolution bug. Append-only enforcement is
-- unaffected: os_guard_audit_append_only() still refuses UPDATE and
-- DELETE on audit_events regardless of who asks.
-- =============================================================

create or replace function os_write_audit() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity  text  := tg_table_name;
  v_new     jsonb := to_jsonb(new);
  v_old     jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  v_action  text;
  v_project uuid;
  v_before  jsonb;
  v_after   jsonb;
  v_owner   uuid;
begin
  -- Field-agnostic lookups: works for projects (no project_id column)
  -- and for every child table alike.
  if v_entity = 'projects' then
    v_project := nullif(v_new ->> 'id', '')::uuid;
  else
    v_project := nullif(v_new ->> 'project_id', '')::uuid;
  end if;

  v_owner := nullif(v_new ->> 'owner_id', '')::uuid;

  if tg_op = 'INSERT' then
    v_action := v_entity || '.created';
    v_after  := v_new;
  else
    if (v_new -> 'status') is distinct from (v_old -> 'status') then
      v_action := v_entity || '.status_changed';
    else
      v_action := v_entity || '.updated';
    end if;
    v_before := v_old;
    v_after  := v_new;
  end if;

  -- Keep the trail lightweight: references and short summaries only,
  -- never document bodies, payloads, or anything secret-shaped.
  v_before := v_before - 'inline_body' - 'excerpt' - 'action_payload' - 'input_reference' - 'description';
  v_after  := v_after  - 'inline_body' - 'excerpt' - 'action_payload' - 'input_reference' - 'description';

  insert into audit_events (
    owner_id, actor_type, actor_id, actor_name, project_id,
    action, entity_type, entity_id, before_data, after_data, metadata
  ) values (
    v_owner,
    os_actor_type(),
    auth.uid(),
    coalesce(os_actor_name(), os_actor_type()::text),
    v_project,
    v_action,
    v_entity,
    v_new ->> 'id',
    v_before,
    v_after,
    jsonb_build_object('op', tg_op)
  );

  return null;
end;
$$;

comment on function os_write_audit is
  'Writes the append-only audit row for an insert or update. SECURITY DEFINER as of 0017: the trail is a property of the system, not an action of the actor, so it must not depend on the actor holding an INSERT grant on audit_events. Before this, a signed-in human could not approve anything, because the audit write ran as them and row-level security correctly refused it.';
