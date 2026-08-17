# Omnios Core Supabase Migration Application Report

Project ref: `bvxjthifyekabpkmpcji` (`omnios-core`)

## Applied migrations (strict order)

1. `0001_enums`
2. `0002_core_tables`
3. `0003_policy_and_settings`
4. `0004_guards_and_audit`
5. `0005_rls`

All five migration applications returned `success: true`.

## SQL file edits

None. Every migration applied successfully on its first attempt, so the workspace SQL files were not changed.

## Public tables

| Table | RLS enabled | Rows |
|---|---:|---:|
| projects | true | 0 |
| agents | true | 0 |
| tasks | true | 0 |
| artifacts | true | 0 |
| jobs | true | 0 |
| approvals | true | 0 |
| evidence | true | 0 |
| audit_events | true | 0 |
| job_logs | true | 0 |
| action_policies | true | 28 |
| system_settings | true | 3 |

No demo data was seeded.

## Data verification

- `action_policies` row count: **28**
- `system_settings`:
  - `autonomy_level` = `"low_risk_operations"`
  - `emergency_pause` = `false`
  - `max_concurrent_jobs` = `2`

## Row-level security and policy counts

| Table | relrowsecurity | Policies |
|---|---:|---:|
| action_policies | true | 2 |
| agents | true | 3 |
| approvals | true | 3 |
| artifacts | true | 3 |
| audit_events | true | 1 |
| evidence | true | 3 |
| job_logs | true | 1 |
| jobs | true | 3 |
| projects | true | 3 |
| system_settings | true | 2 |
| tasks | true | 3 |
