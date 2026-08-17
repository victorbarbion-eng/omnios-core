# omnios-core guard test run — 2026-08-17 12:30 HST

Project: `bvxjthifyekabpkmpcji` (`omnios-core`)

## Step 1 — hardening migration

- Migration `0006_actor_identity_hardening` applied successfully using the SQL in `supabase/migrations/0006_actor_identity_hardening.sql` verbatim.

## Step 2 — seed

- The requested verbatim `supabase/seed.sql` execution failed and rolled back.
- Database error:

```text
ERROR: 42703: record "new" has no field "project_id"
CONTEXT: PL/pgSQL assignment "v_project := case when v_entity = 'projects' then new.id else new.project_id end"
PL/pgSQL function os_write_audit() line 11 at assignment
SQL statement "insert into projects ..."
```

- Seed verification result:

| demo_projects | tasks | artifacts | evidence | jobs | approvals | agents | audit_events |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Step 3 — guard harness

- `tests/db_guards.sql` installed successfully and created `public.os_selftest`.
- The requested test query did **not** return a result table. It aborted before producing its first row when its setup fixture inserted a `projects` row.
- Complete result: **no result rows (statement error)**.
- Error:

```text
ERROR: 42703: record "new" has no field "project_id"
CONTEXT: PL/pgSQL assignment "v_project := case when v_entity = 'projects' then new.id else new.project_id end"
PL/pgSQL function os_write_audit() line 11 at assignment
SQL statement "insert into projects (owner_id, name, slug, description, is_demo)
 values (owner_a, 'SELFTEST project', 'selftest-project', 'temporary test fixture', true)
 returning id"
PL/pgSQL function os_selftest() line 18 at SQL statement
```

## Step 4 — harness edits and security finding

- Harness edits: none.
- Reruns: none, because no `passed = false` test row was emitted and the blocker is not a harness-only defect.
- Real gap/blocker: `public.os_write_audit()` cannot execute for INSERT/UPDATE triggers on `projects`. The deployed definition statically references `new.project_id` within a `CASE` expression. In PL/pgSQL, `NEW` is typed to the trigger table, so compilation/execution rejects the field on a `projects` row even though the other branch is logically inapplicable.
- Impact: inserting/updating `projects` fails wherever this audit trigger is attached. This prevents the seed and self-test setup from running; it can also block ordinary project writes. The failure prevents audit-event creation rather than silently omitting it.
- Suggested fix (not applied): replace the static `CASE ... new.project_id` assignment with separate table-safe branches (for example, `if v_entity = 'projects' then v_project := new.id; else v_project := new.project_id; end if;`) or derive `project_id` from `to_jsonb(new)` safely. Deliver it as a reviewed migration, preserving the audit trigger and its event data.

## Step 5 — final state checks

### Jobs by status

No rows (`[]`).

### Approvals by status

No rows (`[]`).

### System settings

| key | value |
|---|---|
| autonomy_level | `"low_risk_operations"` |
| emergency_pause | `false` |
| max_concurrent_jobs | `2` |

### Self-test project count

| count |
|---:|
| 0 |

`emergency_pause` is false and no `selftest-%` projects remain.

## Step 6 — cleanup

- Executed `drop function if exists public.os_selftest();` successfully.
