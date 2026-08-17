-- =============================================================
-- 0002_core_tables.sql
-- The eight core tables, plus job_logs.
--
-- owner_id is a plain uuid, deliberately WITHOUT a foreign key to
-- auth.users. Reason: it keeps the schema testable without a live
-- auth session, and lets a future non-human service principal own
-- rows. Row-level security still compares it to auth.uid().
-- =============================================================

-- 1. projects -------------------------------------------------
create table projects (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null default auth.uid(),
  name                text not null,
  slug                text not null,
  description         text,
  status              project_status not null default 'active',
  priority            priority_level not null default 'medium',
  tags                text[] not null default '{}',
  -- Where the real files live. We store the pointer, not a copy.
  canonical_location  text,
  location_kind       location_type not null default 'local_path',
  is_demo             boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz,
  constraint projects_slug_unique_per_owner unique (owner_id, slug),
  constraint projects_name_not_blank check (length(trim(name)) > 0)
);

create index projects_owner_status_idx on projects (owner_id, status);
create index projects_tags_idx on projects using gin (tags);

-- 4. agents (declared before tasks/jobs, which reference it) ---
create table agents (
  id                      uuid primary key default gen_random_uuid(),
  owner_id                uuid not null default auth.uid(),
  name                    text not null,
  role                    text not null,
  runtime_type            agent_runtime not null default 'local',
  status                  agent_status not null default 'offline',
  -- Action types this agent may attempt at all. The policy table
  -- then decides whether each one runs automatically or waits.
  allowed_actions         text[] not null default '{}',
  -- Empty array = all of this owner's projects. Otherwise a
  -- whitelist of project ids.
  allowed_project_scope   uuid[] not null default '{}',
  -- A POINTER to configuration, never a secret value.
  -- e.g. 'local-agent/config/mac-runner.json' or 'env:OMNIOS_AGENT_NAME'
  configuration_reference text,
  last_seen_at            timestamptz,
  is_demo                 boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint agents_name_unique_per_owner unique (owner_id, name),
  -- Cheap tripwire against pasting a credential into this table.
  constraint agents_config_is_not_a_secret check (
    configuration_reference is null
    or configuration_reference !~* '(sb_secret|service_role|eyJ[A-Za-z0-9_-]{10,}|-----BEGIN)'
  )
);

create index agents_owner_status_idx on agents (owner_id, status);

-- 3. tasks -----------------------------------------------------
create table tasks (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null default auth.uid(),
  project_id        uuid not null references projects (id) on delete cascade,
  title             text not null,
  description       text,
  status            task_status not null default 'backlog',
  priority          priority_level not null default 'medium',
  assigned_agent_id uuid references agents (id) on delete set null,
  parent_task_id    uuid references tasks (id) on delete cascade,
  due_at            timestamptz,
  is_demo           boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz,
  constraint tasks_title_not_blank check (length(trim(title)) > 0),
  constraint tasks_no_self_parent check (parent_task_id is distinct from id)
);

create index tasks_project_status_idx on tasks (project_id, status);
create index tasks_agent_idx on tasks (assigned_agent_id) where assigned_agent_id is not null;
create index tasks_due_idx on tasks (due_at) where due_at is not null;

-- 2. artifacts -------------------------------------------------
create table artifacts (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null default auth.uid(),
  project_id     uuid not null references projects (id) on delete cascade,
  task_id        uuid references tasks (id) on delete set null,
  name           text not null,
  artifact_type  artifact_type not null default 'document',
  location_kind  location_type not null default 'local_path',
  -- Exactly one of these should be populated, matching location_kind.
  local_path     text,
  external_url   text,
  storage_path   text,
  inline_body    text,          -- short generated drafts only
  source_url     text,          -- provenance, if derived from a source
  checksum       text,          -- sha256 of content, when computable
  version        integer not null default 1,
  created_by     text not null default 'user',   -- 'user' or agent name
  metadata       jsonb not null default '{}'::jsonb,
  is_demo        boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint artifacts_location_is_consistent check (
    case location_kind
      when 'local_path'       then local_path   is not null
      when 'external_url'     then external_url is not null
      when 'google_drive'     then external_url is not null
      when 'supabase_storage' then storage_path is not null
      when 'inline'           then inline_body  is not null
    end
  )
);

create index artifacts_project_idx on artifacts (project_id, created_at desc);
create index artifacts_task_idx on artifacts (task_id) where task_id is not null;
create index artifacts_type_idx on artifacts (artifact_type);

-- 5. jobs ------------------------------------------------------
create table jobs (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null default auth.uid(),
  project_id         uuid not null references projects (id) on delete cascade,
  task_id            uuid references tasks (id) on delete set null,
  agent_id           uuid references agents (id) on delete set null,
  -- Must match a row in action_policies.action_type (see 0003).
  job_type           text not null,
  input_reference    jsonb not null default '{}'::jsonb,
  status             job_status not null default 'queued',
  attempt_count      integer not null default 0,
  max_attempts       integer not null default 3,
  queued_at          timestamptz not null default now(),
  claimed_at         timestamptz,
  started_at         timestamptz,
  finished_at        timestamptz,
  output_artifact_id uuid references artifacts (id) on delete set null,
  error_summary      text,
  -- Re-running the same logical request must not duplicate work.
  idempotency_key    text not null,
  is_demo            boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint jobs_idempotency_unique unique (owner_id, idempotency_key),
  constraint jobs_attempts_sane check (attempt_count >= 0 and attempt_count <= max_attempts + 1)
);

create index jobs_status_queue_idx on jobs (status, queued_at) where status = 'queued';
create index jobs_project_idx on jobs (project_id, created_at desc);
create index jobs_agent_idx on jobs (agent_id, created_at desc);

-- 6. approvals -------------------------------------------------
create table approvals (
  id                     uuid primary key default gen_random_uuid(),
  owner_id               uuid not null default auth.uid(),
  project_id             uuid not null references projects (id) on delete cascade,
  requested_by_agent_id  uuid references agents (id) on delete set null,
  job_id                 uuid references jobs (id) on delete cascade,
  action_type            text not null,
  -- The exact thing that would happen, in plain language, plus the
  -- literal payload. This is what you read before deciding.
  action_preview         text not null,
  action_payload         jsonb not null default '{}'::jsonb,
  target_reference       text not null,
  risk_level             risk_class not null default 'approval_required',
  status                 approval_status not null default 'pending',
  requested_at           timestamptz not null default now(),
  decided_at             timestamptz,
  decided_by_actor_type  actor_type,
  decided_by             uuid,
  decision_note          text,
  expires_at             timestamptz not null default (now() + interval '7 days'),
  executed_at            timestamptz,
  is_demo                boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint approvals_preview_not_blank check (length(trim(action_preview)) > 0)
);

create index approvals_pending_idx on approvals (owner_id, requested_at desc) where status = 'pending';
create index approvals_job_idx on approvals (job_id);
create index approvals_project_idx on approvals (project_id, requested_at desc);

-- 7. evidence --------------------------------------------------
create table evidence (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null default auth.uid(),
  project_id          uuid not null references projects (id) on delete cascade,
  task_id             uuid references tasks (id) on delete set null,
  job_id              uuid references jobs (id) on delete set null,
  artifact_id         uuid references artifacts (id) on delete set null,
  title               text not null,
  source_url          text,
  publisher           text,
  excerpt             text,
  captured_at         timestamptz not null default now(),
  source_published_at date,
  relevance_note      text,
  verification        verification_status not null default 'unverified',
  -- 0.00–1.00 subjective confidence recorded by whoever captured it.
  confidence          numeric(3,2),
  is_demo             boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint evidence_has_a_source check (source_url is not null or artifact_id is not null),
  constraint evidence_confidence_range check (confidence is null or (confidence >= 0 and confidence <= 1))
);

create index evidence_project_idx on evidence (project_id, captured_at desc);
create index evidence_job_idx on evidence (job_id) where job_id is not null;

-- 8. audit_events ---------------------------------------------
-- Append-only history. Deliberately holds references and short
-- summaries, never secrets or full document bodies.
create table audit_events (
  id          bigserial primary key,
  owner_id    uuid not null default auth.uid(),
  actor_type  actor_type not null,
  actor_id    uuid,
  actor_name  text,
  project_id  uuid references projects (id) on delete set null,
  action      text not null,
  entity_type text not null,
  entity_id   text,
  before_data jsonb,
  after_data  jsonb,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index audit_events_owner_time_idx on audit_events (owner_id, created_at desc);
create index audit_events_project_time_idx on audit_events (project_id, created_at desc);
create index audit_events_entity_idx on audit_events (entity_type, entity_id);
create index audit_events_action_idx on audit_events (action);

-- 9. job_logs --------------------------------------------------
-- Structured per-step log lines so the dashboard can explain what
-- an agent actually did, without parsing terminal output.
create table job_logs (
  id         bigserial primary key,
  owner_id   uuid not null default auth.uid(),
  job_id     uuid not null references jobs (id) on delete cascade,
  level      text not null default 'info' check (level in ('debug', 'info', 'warn', 'error')),
  step       text,
  message    text not null,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index job_logs_job_idx on job_logs (job_id, created_at);
