/**
 * Shared vocabulary. These mirror the Postgres enums in
 * supabase/migrations/0001_enums.sql. If you change one, change both.
 */

export type RiskClass =
  | 'read'
  | 'internal_write'
  | 'external_draft'
  | 'approval_required'
  | 'prohibited';

export type JobStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'completed'
  | 'cancelled';

export type TaskStatus =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'awaiting_approval'
  | 'done'
  | 'cancelled';

export type AgentRuntime = 'local' | 'cloud' | 'future_vps';
export type AgentStatus = 'offline' | 'idle' | 'running' | 'paused' | 'error';
export type ActorType = 'user' | 'agent' | 'system';
export type LocationKind =
  | 'local_path'
  | 'supabase_storage'
  | 'external_url'
  | 'google_drive'
  | 'inline';

export interface ActionPolicy {
  action_type: string;
  risk_level: RiskClass;
  description: string;
  auto_allowed: boolean;
  promoted_at: string | null;
  promoted_note: string | null;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  status: string;
  priority: string;
  canonical_location: string | null;
  is_demo: boolean;
}

export interface Job {
  id: string;
  project_id: string;
  task_id: string | null;
  agent_id: string | null;
  job_type: string;
  input_reference: Record<string, unknown>;
  status: JobStatus;
  attempt_count: number;
  max_attempts: number;
  idempotency_key: string;
  output_artifact_id: string | null;
  error_summary: string | null;
}

export interface Approval {
  id: string;
  project_id: string;
  job_id: string | null;
  action_type: string;
  action_preview: string;
  target_reference: string;
  risk_level: RiskClass;
  status: ApprovalStatus;
  expires_at: string;
  decision_note: string | null;
}

/** The result of asking policy "may I do this?" */
export type PolicyDecision =
  | { outcome: 'allow'; actionType: string; riskLevel: RiskClass; reason: string }
  | { outcome: 'needs_approval'; actionType: string; riskLevel: RiskClass; reason: string }
  | { outcome: 'refuse'; actionType: string; riskLevel: RiskClass | null; reason: string };
