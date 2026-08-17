# Approval policy

The authoritative policy is the `action_policies` table created and seeded in migration `0003_policy_and_settings.sql`. The shared TypeScript policy engine mirrors it for early refusal and clear messages, but PostgreSQL guards are the final enforcement point.

## Risk classes

| Risk class | Meaning | Automatic in the initial policy? |
|---|---|---|
| `read` | Read an allowed source or existing system/project record without a state change. | Yes for the seeded read actions. |
| `internal_write` | Write inside OmniOS or the designated local project folder. | Yes for the seeded actions. |
| `external_draft` | Prepare outward-facing material without sending, publishing, or committing it. | Yes for the seeded draft actions. |
| `approval_required` | Consequential action that must wait for a human decision on the exact preview. | No. A database check forbids it from becoming automatic. |
| `prohibited` | Never allowed in this build. | No; it cannot be automatic. |

## Initial action matrix

| Action type | Risk class | Automatic? |
|---|---|---:|
| `read_source` | `read` | yes |
| `read_project_files` | `read` | yes |
| `query_system` | `read` | yes |
| `research_topic` | `internal_write` | yes |
| `capture_evidence` | `internal_write` | yes |
| `create_artifact` | `internal_write` | yes |
| `organize_project_files` | `internal_write` | yes |
| `update_task_status` | `internal_write` | yes |
| `update_job_status` | `internal_write` | yes |
| `create_task` | `internal_write` | yes |
| `draft_message` | `external_draft` | yes |
| `draft_calendar_event` | `external_draft` | yes |
| `draft_pull_request` | `external_draft` | yes |
| `draft_report` | `external_draft` | yes |
| `send_message` | `approval_required` | no |
| `publish_content` | `approval_required` | no |
| `deploy` | `approval_required` | no |
| `financial_action` | `approval_required` | no |
| `delete_data` | `approval_required` | no |
| `change_credentials` | `approval_required` | no |
| `alter_schema` | `approval_required` | no |
| `modify_external_system` | `approval_required` | no |
| `merge_pull_request` | `approval_required` | no |
| `run_command_outside_root` | `approval_required` | no |
| `change_action_policy` | `approval_required` | no |
| `exfiltrate_secrets` | `prohibited` | no |
| `disable_audit` | `prohibited` | no |
| `impersonate_user` | `prohibited` | no |

Unknown action types are refused by the TypeScript policy engine. At the database layer, job and approval action types must reference a known `action_policies.action_type`; prohibited action types are also rejected when a job is inserted.

## Approval lifecycle

The enum permits these approval statuses:

```text
pending → approved or denied
pending → expired
approved → completed
pending/approved → cancelled
```

The lifecycle intent is:

- `pending`: an agent or user has recorded the exact preview, payload, target, expiry, and requested action.
- `approved`: a signed-in person accepted the pending action before expiry.
- `denied`: a signed-in person declined the pending action.
- `expired`: an unanswered pending request passed `expires_at`; `os_expire_stale_approvals()` changes such rows when called.
- `completed`: an approved action has been carried out and the decision guard freezes further status changes.
- `cancelled`: the request is withdrawn rather than decided or carried out.

A decision to `approved` or `denied` requires a real signed-in human session because the database guard checks `auth.uid()`. The agent runner's service-role request has no end-user `auth.uid()`, so it can request an approval but cannot grant or deny one. A request may be decided only while it is still `pending` and unexpired; the guard records the decision time, actor type `user`, and the authenticated user identifier.

The dashboard's Approvals page shows the literal preview and payload, then updates only `status` and `decision_note` through the signed-in user's session. It does not use a privileged key.

**Not yet true:** the database has targeted guards for decisions and completion immutability, not a complete approval-status transition table. Nothing in the current runner marks an approval `completed`, cancels it, or automatically re-requests an expired request.

## Promote one action type to automatic

Only consider this for a non-consequential action whose code and observed behavior are understood. The schema permanently rejects `approval_required` and `prohibited` policies where `auto_allowed=true`; therefore no promotion procedure can make actions such as `send_message`, `deploy`, or `delete_data` automatic without first changing the policy class and schema policy, which is not a routine operation.

For an eligible existing action type currently `auto_allowed=false`:

1. Review multiple successful, complete runs in `job_logs`, `audit_events`, and the dashboard. Confirm inputs, outputs, expected refusals, and error handling.
2. Run the TypeScript unit suite and the database guard suite against a safe project. At minimum, rerun `npx vitest run` and the documented `tests/db_guards.sql` harness after the policy change in a non-production test environment.
3. Have a signed-in human perform the change through a controlled database path. Include a concise, specific `promoted_note` explaining the evidence and scope. The SQL shape is:

   ```sql
   update action_policies
      set auto_allowed = true,
          promoted_note = 'Reason based on reviewed successful runs; include date and scope.'
    where action_type = '<eligible-action-type>';
   ```

4. Verify `promoted_at` was set by the trigger and inspect the resulting policy in the dashboard. Keep the note; it is the record of widened autonomy.
5. Run one narrowly scoped real operation while watching the job, logs, and audit trail. Revert to `auto_allowed=false` if behavior is not exactly as expected.

`os_guard_policy_change()` blocks a false-to-true promotion without `promoted_note`, records `promoted_at`, and blocks an actor attributed as `agent` from widening autonomy. The `action_policies` check constraint separately rejects automatic `approval_required` or `prohibited` classes.
