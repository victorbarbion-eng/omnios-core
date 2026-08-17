-- =============================================================
-- 0001_enums.sql
-- Controlled vocabularies. Using Postgres enums (instead of free
-- text) means a typo in an agent's status update fails loudly at
-- the database boundary instead of silently creating a state that
-- no dashboard view knows how to display.
-- =============================================================

create extension if not exists "pgcrypto";  -- gen_random_uuid()

create type project_status   as enum ('active', 'on_hold', 'completed', 'archived');
create type priority_level   as enum ('low', 'medium', 'high', 'critical');

create type artifact_type    as enum (
  'document', 'report', 'draft', 'note', 'dataset', 'spreadsheet',
  'drawing', 'bim_model', 'gis_layer', 'image', 'code', 'other'
);

create type location_type    as enum (
  'local_path', 'supabase_storage', 'external_url', 'google_drive', 'inline'
);

create type task_status      as enum (
  'backlog', 'ready', 'in_progress', 'blocked', 'awaiting_approval', 'done', 'cancelled'
);

create type agent_runtime    as enum ('local', 'cloud', 'future_vps');
create type agent_status     as enum ('offline', 'idle', 'running', 'paused', 'error');

create type job_status       as enum (
  'queued', 'claimed', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'
);

create type approval_status  as enum (
  'pending', 'approved', 'denied', 'expired', 'completed', 'cancelled'
);

-- The five risk classes that govern what may happen automatically.
--   read             : read allowed sources, no state change
--   internal_write   : write inside our own system / designated folders
--   external_draft   : prepare something outward-facing but do not send it
--   approval_required: blocked until a human approves the exact action
--   prohibited       : never permitted by this build, at any autonomy level
create type risk_class       as enum (
  'read', 'internal_write', 'external_draft', 'approval_required', 'prohibited'
);

create type actor_type       as enum ('user', 'agent', 'system');

create type verification_status as enum (
  'unverified', 'corroborated', 'primary_source', 'disputed'
);
