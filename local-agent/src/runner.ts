import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  PolicyEngine,
  createAgentClient,
  redact,
  redactObject,
  resolveInsideWorkspace,
  type ActionPolicy,
  type JobStatus,
  type PolicyDecision,
} from '@omnios/shared';
import { loadAgentEnv, type AgentEnv } from './env.js';

export class PolicyRefusal extends Error {
  constructor(public readonly decision: PolicyDecision) {
    super(decision.reason);
    this.name = 'PolicyRefusal';
  }
}

/**
 * The local agent runner.
 *
 * Small on purpose: it is a disciplined client of the database, not an
 * AI framework. Its job is to claim work it is allowed to claim, record
 * what it did, park anything consequential as an approval request, and
 * refuse rather than improvise.
 */
export class Runner {
  private policy!: PolicyEngine;
  private agentId: string | null = null;
  private allowedActions: string[] = [];
  private paused = false;

  private constructor(
    private readonly db: SupabaseClient,
    private readonly env: AgentEnv,
  ) {}

  static async create(): Promise<Runner> {
    const env = loadAgentEnv();
    const db = createAgentClient({
      url: env.url,
      serviceRoleKey: env.serviceRoleKey,
      agentName: env.agentName,
    });
    const runner = new Runner(db, env);
    await runner.refresh();
    return runner;
  }

  get isDryRun(): boolean {
    return this.env.dryRun;
  }

  get name(): string {
    return this.env.agentName;
  }

  get policyEngine(): PolicyEngine {
    return this.policy;
  }

  get emergencyPause(): boolean {
    return this.paused;
  }

  // ---------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------

  /** Reload policy and settings. Cheap; call it before each work cycle. */
  async refresh(): Promise<void> {
    const [policies, settings] = await Promise.all([
      this.db.from('action_policies').select('*'),
      this.db.from('system_settings').select('key, value'),
    ]);
    if (policies.error) throw new Error(`Cannot load action_policies: ${policies.error.message}`);
    if (settings.error) throw new Error(`Cannot load system_settings: ${settings.error.message}`);

    this.policy = new PolicyEngine(policies.data as ActionPolicy[]);
    const pause = settings.data?.find((s) => s.key === 'emergency_pause');
    this.paused = pause?.value === true || pause?.value === 'true';
  }

  /**
   * Register (or refresh) this machine as an agent. Records a pointer to
   * its configuration file, never a credential.
   */
  async register(ownerId: string, allowedActions: string[]): Promise<string> {
    this.allowedActions = allowedActions;

    if (this.env.dryRun) {
      this.print(`[dry-run] would register agent "${this.env.agentName}" (${this.env.runtime})`);
      this.agentId = '00000000-0000-0000-0000-00000000dead';
      return this.agentId;
    }

    const existing = await this.db
      .from('agents')
      .select('id')
      .eq('owner_id', ownerId)
      .eq('name', this.env.agentName)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);

    const row = {
      owner_id: ownerId,
      name: this.env.agentName,
      role: 'Local research and drafting runner',
      runtime_type: this.env.runtime,
      status: 'idle' as const,
      allowed_actions: allowedActions,
      configuration_reference: 'local-agent/src/runner.ts',
      last_seen_at: new Date().toISOString(),
    };

    if (existing.data) {
      const upd = await this.db.from('agents').update(row).eq('id', existing.data.id).select('id').single();
      if (upd.error) throw new Error(upd.error.message);
      this.agentId = upd.data.id;
    } else {
      const ins = await this.db.from('agents').insert(row).select('id').single();
      if (ins.error) throw new Error(ins.error.message);
      this.agentId = ins.data.id;
    }
    return this.agentId!;
  }

  // ---------------------------------------------------------------
  // Policy
  // ---------------------------------------------------------------

  /**
   * The single choke point. Every capability asks here first.
   * Returns the decision; callers must honour 'needs_approval' by
   * parking the job rather than proceeding.
   */
  check(actionType: string): PolicyDecision {
    return this.policy.decide(actionType, {
      emergencyPause: this.paused,
      agentAllowedActions: this.allowedActions.length > 0 ? this.allowedActions : undefined,
    });
  }

  /** Throws PolicyRefusal on 'refuse'. Never silently downgrades. */
  requireAllowed(actionType: string): PolicyDecision {
    const decision = this.check(actionType);
    if (decision.outcome === 'refuse') throw new PolicyRefusal(decision);
    return decision;
  }

  /** Path guard for any file the agent touches. */
  safePath(candidate: string): string {
    return resolveInsideWorkspace(this.env.workspaceRoot, candidate);
  }

  // ---------------------------------------------------------------
  // Work records
  // ---------------------------------------------------------------

  async ensureProject(slug: string, name: string, ownerId: string): Promise<string> {
    if (this.env.dryRun) {
      this.print(`[dry-run] would ensure project "${slug}"`);
      return '00000000-0000-0000-0000-0000000000p1';
    }
    const found = await this.db
      .from('projects')
      .select('id')
      .eq('owner_id', ownerId)
      .eq('slug', slug)
      .maybeSingle();
    if (found.error) throw new Error(found.error.message);
    if (found.data) return found.data.id;

    const ins = await this.db
      .from('projects')
      .insert({ owner_id: ownerId, name, slug, is_demo: true })
      .select('id')
      .single();
    if (ins.error) throw new Error(ins.error.message);
    return ins.data.id;
  }

  async createTask(input: {
    ownerId: string;
    projectId: string;
    title: string;
    description?: string;
    status?: string;
  }): Promise<string> {
    this.requireAllowed('create_task');
    if (this.env.dryRun) {
      this.print(`[dry-run] would create task "${input.title}"`);
      return '00000000-0000-0000-0000-0000000000t1';
    }
    const ins = await this.db
      .from('tasks')
      .insert({
        owner_id: input.ownerId,
        project_id: input.projectId,
        title: input.title,
        description: input.description ?? null,
        status: input.status ?? 'ready',
        assigned_agent_id: this.agentId,
        is_demo: true,
      })
      .select('id')
      .single();
    if (ins.error) throw new Error(ins.error.message);
    return ins.data.id;
  }

  /**
   * Queue a job. The idempotency key is derived from the logical
   * request, so re-running the same workflow reuses the existing job
   * instead of duplicating work.
   */
  async queueJob(input: {
    ownerId: string;
    projectId: string;
    taskId?: string | null;
    jobType: string;
    payload: Record<string, unknown>;
  }): Promise<{ id: string; reused: boolean; status: JobStatus }> {
    const key = Runner.idempotencyKey(input.jobType, input.payload);

    if (this.env.dryRun) {
      this.print(`[dry-run] would queue ${input.jobType} (key ${key})`);
      return { id: '00000000-0000-0000-0000-0000000000j1', reused: false, status: 'queued' };
    }

    const existing = await this.db
      .from('jobs')
      .select('id, status')
      .eq('owner_id', input.ownerId)
      .eq('idempotency_key', key)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    // Idempotency means "do not do this twice", which also means the
    // caller must be told the work is already done. Returning only the
    // id let the demo march on and attempt an illegal transition out of
    // 'completed' on a second run.
    if (existing.data) {
      return { id: existing.data.id, reused: true, status: existing.data.status as JobStatus };
    }

    const ins = await this.db
      .from('jobs')
      .insert({
        owner_id: input.ownerId,
        project_id: input.projectId,
        task_id: input.taskId ?? null,
        agent_id: this.agentId,
        job_type: input.jobType,
        input_reference: redactObject(input.payload),
        status: 'queued',
        idempotency_key: key,
        is_demo: true,
      })
      .select('id')
      .single();
    if (ins.error) throw new Error(ins.error.message);
    return { id: ins.data.id, reused: false, status: 'queued' };
  }

  /** True when a reused job has already reached a terminal state. */
  static isFinished(status: JobStatus): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
  }

  static idempotencyKey(jobType: string, payload: Record<string, unknown>): string {
    const digest = createHash('sha256')
      .update(JSON.stringify({ jobType, payload }))
      .digest('hex')
      .slice(0, 16);
    return `${jobType}:${digest}`;
  }

  /** Move a job forward. The database rejects illegal transitions. */
  async setJobStatus(
    jobId: string,
    status: JobStatus,
    patch: Record<string, unknown> = {},
  ): Promise<void> {
    if (this.env.dryRun) {
      this.print(`[dry-run] would set job ${jobId} → ${status}`);
      return;
    }
    const { error } = await this.db.from('jobs').update({ status, ...patch }).eq('id', jobId);
    if (error) throw new Error(`Job ${jobId} → ${status} refused: ${error.message}`);
  }

  async claim(jobId: string): Promise<void> {
    await this.setJobStatus(jobId, 'claimed');
  }

  async log(
    jobId: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    step: string,
    message: string,
    data: Record<string, unknown> = {},
    ownerId?: string,
  ): Promise<void> {
    const safeMessage = redact(message);
    this.print(`  [${level}] ${step}: ${safeMessage}`);
    if (this.env.dryRun) return;
    const { error } = await this.db.from('job_logs').insert({
      owner_id: ownerId,
      job_id: jobId,
      level,
      step,
      message: safeMessage,
      data: redactObject(data),
    });
    if (error) this.print(`  [warn] could not persist log line: ${error.message}`);
  }

  async saveArtifact(input: {
    ownerId: string;
    projectId: string;
    taskId?: string | null;
    name: string;
    artifactType: string;
    body: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    this.requireAllowed('create_artifact');
    if (this.env.dryRun) {
      this.print(`[dry-run] would save artifact "${input.name}" (${input.body.length} chars)`);
      return '00000000-0000-0000-0000-0000000000a1';
    }
    const checksum = createHash('sha256').update(input.body).digest('hex');
    const ins = await this.db
      .from('artifacts')
      .insert({
        owner_id: input.ownerId,
        project_id: input.projectId,
        task_id: input.taskId ?? null,
        name: input.name,
        artifact_type: input.artifactType,
        location_kind: 'inline',
        inline_body: redact(input.body),
        created_by: this.env.agentName,
        checksum,
        metadata: { review_status: 'draft_for_review', ...(input.metadata ?? {}) },
        is_demo: true,
      })
      .select('id')
      .single();
    if (ins.error) throw new Error(ins.error.message);
    return ins.data.id;
  }

  async saveEvidence(input: {
    ownerId: string;
    projectId: string;
    taskId?: string | null;
    jobId?: string | null;
    artifactId?: string | null;
    title: string;
    sourceUrl: string;
    publisher?: string;
    excerpt: string;
    relevanceNote: string;
    verification?: string;
    confidence?: number;
  }): Promise<string> {
    this.requireAllowed('capture_evidence');
    if (this.env.dryRun) {
      this.print(`[dry-run] would record evidence "${input.title}"`);
      return '00000000-0000-0000-0000-0000000000e1';
    }
    const ins = await this.db
      .from('evidence')
      .insert({
        owner_id: input.ownerId,
        project_id: input.projectId,
        task_id: input.taskId ?? null,
        job_id: input.jobId ?? null,
        artifact_id: input.artifactId ?? null,
        title: input.title,
        source_url: input.sourceUrl,
        publisher: input.publisher ?? null,
        excerpt: redact(input.excerpt),
        relevance_note: input.relevanceNote,
        verification: input.verification ?? 'unverified',
        confidence: input.confidence ?? null,
        is_demo: true,
      })
      .select('id')
      .single();
    if (ins.error) throw new Error(ins.error.message);
    return ins.data.id;
  }

  /**
   * Park a consequential action. The agent writes the exact preview and
   * stops. It cannot approve this row: its connection has no
   * auth.uid(), and the database refuses the decision.
   */
  async requestApproval(input: {
    ownerId: string;
    projectId: string;
    jobId: string;
    actionType: string;
    preview: string;
    payload: Record<string, unknown>;
    target: string;
    expiresInHours?: number;
  }): Promise<string> {
    if (this.env.dryRun) {
      this.print(`[dry-run] would request approval for ${input.actionType} → ${input.target}`);
      return '00000000-0000-0000-0000-0000000000c1';
    }
    const expires = new Date(Date.now() + (input.expiresInHours ?? 168) * 3600_000).toISOString();
    const ins = await this.db
      .from('approvals')
      .insert({
        owner_id: input.ownerId,
        project_id: input.projectId,
        requested_by_agent_id: this.agentId,
        job_id: input.jobId,
        action_type: input.actionType,
        action_preview: input.preview,
        action_payload: redactObject(input.payload),
        target_reference: input.target,
        risk_level: this.policy.riskLevel(input.actionType) ?? 'approval_required',
        status: 'pending',
        expires_at: expires,
        is_demo: true,
      })
      .select('id')
      .single();
    if (ins.error) throw new Error(ins.error.message);
    await this.setJobStatus(input.jobId, 'awaiting_approval');
    return ins.data.id;
  }

  /** Convenience: the owner id to attribute work to. */
  async resolveOwnerId(): Promise<string> {
    const { data } = await this.db.from('projects').select('owner_id').limit(1).maybeSingle();
    if (data?.owner_id) return data.owner_id as string;
    return '00000000-0000-0000-0000-0000000000aa';
  }

  private print(line: string): void {
    // eslint-disable-next-line no-console
    console.log(redact(line));
  }
}
