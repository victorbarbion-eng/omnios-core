-- =============================================================
-- 0007_fix_audit_trigger.sql
--
-- Bug found by tests/db_guards.sql on first run:
--   ERROR 42703: record "new" has no field "project_id"
--
-- Cause: os_write_audit() is one trigger shared by five tables, and
-- it picked the project id with
--   case when v_entity = 'projects' then new.id else new.project_id end
-- PL/pgSQL resolves record field references when the expression is
-- compiled, not when the branch is taken. On the `projects` trigger,
-- NEW has no project_id column, so the statement failed even though
-- that branch is never reached. This blocked every insert into
-- projects — the seed and the whole test suite included.
--
-- Fix: read fields out of to_jsonb(NEW), which is field-agnostic.
-- The audit trigger stays in place and keeps the same behaviour.
-- =============================================================

create or replace function os_write_audit() returns trigger
language plpgsql as $$
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
  'Shared append-only audit trigger for projects, tasks, artifacts, jobs, approvals. Reads NEW via to_jsonb so one function can serve tables with different columns.';
