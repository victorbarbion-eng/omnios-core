-- =============================================================
-- 0003_policy_and_settings.sql
-- The autonomy policy lives in the database, not in agent code.
-- An agent cannot widen its own permissions by editing a source
-- file; it would have to change a row, which is itself an
-- approval_required action.
-- =============================================================

create table action_policies (
  action_type    text primary key,
  risk_level     risk_class not null,
  description    text not null,
  -- true  = may proceed without a human in the loop
  -- false = a human must approve the exact action first
  auto_allowed   boolean not null,
  -- Written when an action type is promoted to auto_allowed, so the
  -- reason for widening autonomy is recorded next to the change.
  promoted_at    timestamptz,
  promoted_note  text,
  updated_at     timestamptz not null default now(),
  constraint approval_required_is_never_auto check (
    not (risk_level in ('approval_required', 'prohibited') and auto_allowed)
  )
);

comment on table action_policies is
  'Autonomy matrix. Level 1 = low-risk operations. Promote an action type only after reviewing successful runs.';

-- ---- Initial policy: "low-risk operations" -------------------
insert into action_policies (action_type, risk_level, description, auto_allowed) values
  -- read
  ('read_source',              'read',              'Read an allowed public or permitted source',                     true),
  ('read_project_files',       'read',              'Read files inside the designated project folder',                true),
  ('query_system',             'read',              'Read this system''s own records',                                true),

  -- internal_write
  ('research_topic',           'internal_write',    'Run research and record findings inside the system',             true),
  ('capture_evidence',         'internal_write',    'Store a source, excerpt, and relevance note',                    true),
  ('create_artifact',          'internal_write',    'Save a generated output as a project-linked artifact',           true),
  ('organize_project_files',   'internal_write',    'Move or rename files ONLY inside the designated project folder', true),
  ('update_task_status',       'internal_write',    'Change task status or notes',                                    true),
  ('update_job_status',        'internal_write',    'Change its own job status',                                      true),
  ('create_task',              'internal_write',    'Create a task or subtask',                                       true),

  -- external_draft (prepared, never sent)
  ('draft_message',            'external_draft',    'Write an unsent email or message draft',                         true),
  ('draft_calendar_event',     'external_draft',    'Prepare an uncommitted calendar entry',                           true),
  ('draft_pull_request',       'external_draft',    'Prepare a branch and a DRAFT pull request for review',            true),
  ('draft_report',             'external_draft',    'Write an outward-facing report for review',                       true),

  -- approval_required
  ('send_message',             'approval_required', 'Send an email or message',                                      false),
  ('publish_content',          'approval_required', 'Publish anything publicly',                                     false),
  ('deploy',                   'approval_required', 'Deploy code or infrastructure',                                 false),
  ('financial_action',         'approval_required', 'Spend money, trade, or purchase',                                false),
  ('delete_data',              'approval_required', 'Delete records or files',                                       false),
  ('change_credentials',       'approval_required', 'Create, rotate, or change credentials or permissions',           false),
  ('alter_schema',             'approval_required', 'Change the database schema',                                     false),
  ('modify_external_system',   'approval_required', 'Write to any external system of record',                         false),
  ('merge_pull_request',       'approval_required', 'Merge a pull request',                                           false),
  ('run_command_outside_root', 'approval_required', 'Run a command outside the approved local workspace root',        false),
  ('change_action_policy',     'approval_required', 'Widen this system''s own autonomy',                              false),

  -- prohibited at every autonomy level in this build
  ('exfiltrate_secrets',       'prohibited',        'Read, print, or transmit credential values',                     false),
  ('disable_audit',            'prohibited',        'Disable or rewrite the audit trail',                             false),
  ('impersonate_user',         'prohibited',        'Act as the user in an approval decision',                        false);

-- ---- system_settings: the kill switch ------------------------
create table system_settings (
  key         text primary key,
  value       jsonb not null,
  description text not null,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

insert into system_settings (key, value, description) values
  ('emergency_pause', 'false'::jsonb,
   'When true, no job may start unless its action type is risk_level=read. The kill switch.'),
  ('autonomy_level', '"low_risk_operations"'::jsonb,
   'Current autonomy tier. Recorded for auditability; enforcement comes from action_policies.'),
  ('max_concurrent_jobs', '2'::jsonb,
   'Advisory limit honoured by the local agent runner.');

-- ---- Helper functions ---------------------------------------

-- Who is acting right now. The local agent runner sets
--   set local omnios.actor_type = 'agent';
-- on every connection so the database can tell agent traffic from
-- a human sitting in the dashboard.
create or replace function os_actor_type() returns actor_type
language sql stable as $$
  select coalesce(
    nullif(current_setting('omnios.actor_type', true), '')::actor_type,
    'user'::actor_type
  );
$$;

create or replace function os_actor_name() returns text
language sql stable as $$
  select nullif(current_setting('omnios.actor_name', true), '');
$$;

create or replace function os_emergency_pause() returns boolean
language sql stable as $$
  select coalesce((select value::text::boolean from system_settings where key = 'emergency_pause'), false);
$$;

create or replace function os_risk_level(p_action_type text) returns risk_class
language sql stable as $$
  select risk_level from action_policies where action_type = p_action_type;
$$;

create or replace function os_is_auto_allowed(p_action_type text) returns boolean
language sql stable as $$
  select coalesce((select auto_allowed from action_policies where action_type = p_action_type), false);
$$;

-- Marks decayed approvals. Safe to call repeatedly; call it from
-- the runner or a scheduled trigger.
create or replace function os_expire_stale_approvals() returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  update approvals
     set status = 'expired', updated_at = now()
   where status = 'pending' and expires_at < now();
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function os_expire_stale_approvals is
  'Expires pending approvals past expires_at. An unanswered request must never silently execute later.';
