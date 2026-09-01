import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { redactObject } from '@omnios/shared';

/**
 * The tool surface omnios-core exposes to an outside agent (Hermes).
 *
 * THE SHAPE OF THIS FILE IS THE POINT. What is absent matters more than
 * what is present: there is no approve tool, no deny tool, no policy
 * promotion tool, no delete tool. An agent holding these tools can do
 * work, record what it did, and ask — and nothing else.
 *
 * That absence is a convenience, not the control. The real control is
 * that every call here goes out over PostgREST with the service-role
 * key and `x-omnios-actor: agent`, which means auth.uid() is null.
 * os_guard_approval_decision() refuses a decision from that connection
 * (guard test 05), so even if someone added an approve tool tomorrow it
 * would fail against the database. Belt in code, braces in the schema —
 * and the braces are the part that holds.
 *
 * Tools are declared as data rather than registered inline so the test
 * suite can assert over the surface itself: tests/mcp_surface.test.ts
 * fails the build if a tool whose name suggests granting authority ever
 * appears here.
 */

export interface ToolContext {
  db: SupabaseClient;
  ownerId: string;
  /** Name this MCP server registers work under. */
  agentName: string;
}

export interface OmniosTool {
  name: string;
  title: string;
  description: string;
  /** Zod raw shape; empty object means the tool takes no arguments. */
  inputSchema: z.ZodRawShape;
  /** True when the tool cannot change any state. */
  readOnly: boolean;
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

const ok = (data: unknown): unknown => data;

function fail(message: string): never {
  // Surfaced to the calling agent verbatim. Database errors are the most
  // useful thing an agent can be told: OMNIOS_APPROVAL_REQUIRED is an
  // instruction, not noise.
  throw new Error(message);
}

async function resolveProject(ctx: ToolContext, slug: string): Promise<string> {
  const { data, error } = await ctx.db
    .from('projects')
    .select('id')
    .eq('owner_id', ctx.ownerId)
    .eq('slug', slug)
    .maybeSingle();
  if (error) fail(error.message);
  if (!data) fail(`OMNIOS_UNKNOWN_PROJECT: no project with slug "${slug}". Call omnios_list_projects first.`);
  return data.id as string;
}

export const TOOLS: OmniosTool[] = [
  // ---------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------
  {
    name: 'omnios_status',
    title: 'System status',
    description:
      'Whether the emergency pause is engaged, and how many action policies exist. Check this first: while paused, only read-class work may start.',
    inputSchema: {},
    readOnly: true,
    async handler(ctx) {
      const [settings, policies] = await Promise.all([
        ctx.db.from('system_settings').select('key, value'),
        ctx.db.from('action_policies').select('action_type', { count: 'exact', head: true }),
      ]);
      if (settings.error) fail(settings.error.message);
      const pause = settings.data?.find((s) => s.key === 'emergency_pause');
      return ok({
        emergency_pause: pause?.value === true || pause?.value === 'true',
        action_policy_count: policies.count ?? null,
        note: 'While emergency_pause is true, only risk_level=read work may start. The database enforces this; do not try to work around it.',
      });
    },
  },

  {
    name: 'omnios_policy_check',
    title: 'Check an action against policy',
    description:
      'Ask what would happen if you attempted an action type, WITHOUT attempting it. Returns its risk class and whether it runs automatically or needs a human approval. Cheap; use it before planning work.',
    inputSchema: { action_type: z.string().describe('e.g. research_topic, draft_report, send_message') },
    readOnly: true,
    async handler(ctx, args) {
      const { data, error } = await ctx.db
        .from('action_policies')
        .select('action_type, risk_level, auto_allowed, description')
        .eq('action_type', String(args['action_type']))
        .maybeSingle();
      if (error) fail(error.message);
      if (!data) {
        fail(
          `OMNIOS_UNKNOWN_ACTION: "${String(args['action_type'])}" is not in the policy table. New action types are added by a human with a written reason; an agent cannot invent one.`,
        );
      }
      return ok({
        ...data,
        outcome: data.risk_level === 'prohibited' ? 'refused' : data.auto_allowed ? 'automatic' : 'needs_approval',
      });
    },
  },

  {
    name: 'omnios_list_projects',
    title: 'List projects',
    description: 'Projects you may file work against. Use the slug when queuing jobs or saving drafts.',
    inputSchema: {},
    readOnly: true,
    async handler(ctx) {
      const { data, error } = await ctx.db
        .from('projects')
        .select('slug, name, status, description')
        .eq('owner_id', ctx.ownerId)
        .order('created_at');
      if (error) fail(error.message);
      return ok(data);
    },
  },

  {
    name: 'omnios_list_pending_approvals',
    title: 'List pending approvals',
    description:
      'Approval requests waiting on a human. READ ONLY — you can see these and you cannot decide them. Deciding requires a signed-in human session, which this connection does not have and cannot obtain.',
    inputSchema: {},
    readOnly: true,
    async handler(ctx) {
      const { data, error } = await ctx.db
        .from('approvals')
        .select('id, action_type, status, reason, requested_at, expires_at, job_id')
        .eq('owner_id', ctx.ownerId)
        .eq('status', 'pending')
        .order('requested_at');
      if (error) fail(error.message);
      return ok({
        pending: data,
        note: 'Decide these in the dashboard. This tool surface has no approve or deny capability, and the database would refuse one from this connection anyway.',
      });
    },
  },

  {
    name: 'omnios_approval_status',
    title: 'Check one approval',
    description:
      'The current state of an approval you requested: pending, approved, denied, or expired. Poll this after requesting one rather than assuming an answer.',
    inputSchema: { approval_id: z.string().uuid() },
    readOnly: true,
    async handler(ctx, args) {
      const { data, error } = await ctx.db
        .from('approvals')
        .select('id, action_type, status, reason, decision_note, requested_at, decided_at, expires_at')
        .eq('owner_id', ctx.ownerId)
        .eq('id', String(args['approval_id']))
        .maybeSingle();
      if (error) fail(error.message);
      if (!data) fail('OMNIOS_UNKNOWN_APPROVAL: no approval with that id belongs to this owner.');
      return ok(data);
    },
  },

  // ---------------------------------------------------------------
  // Write — all of it still subject to the database guards
  // ---------------------------------------------------------------
  {
    name: 'omnios_queue_job',
    title: 'Queue a job',
    description:
      'Record an intention to do something, as a job. The database refuses prohibited action types outright, and refuses any type this agent has not been granted. A job that needs approval must be parked with omnios_request_approval rather than run.',
    inputSchema: {
      project_slug: z.string(),
      job_type: z.string().describe('Must exist in the policy table — check with omnios_policy_check first'),
      payload: z.record(z.unknown()).optional().describe('Small structured input; secrets are redacted before storage'),
    },
    readOnly: false,
    async handler(ctx, args) {
      const projectId = await resolveProject(ctx, String(args['project_slug']));
      const payload = (args['payload'] as Record<string, unknown> | undefined) ?? {};
      const key = `mcp:${String(args['job_type'])}:${Date.now().toString(36)}`;

      const { data, error } = await ctx.db
        .from('jobs')
        .insert({
          owner_id: ctx.ownerId,
          project_id: projectId,
          job_type: String(args['job_type']),
          input_reference: redactObject(payload),
          status: 'queued',
          idempotency_key: key,
          is_demo: false,
        })
        .select('id, status, job_type')
        .single();
      if (error) fail(error.message);
      return ok({ ...data, note: 'Queued only. Nothing has executed.' });
    },
  },

  {
    name: 'omnios_record_evidence',
    title: 'Record evidence',
    description:
      'Attach a source to a project so a claim can be checked later. Evidence is how work becomes reviewable rather than merely asserted — record it as you go, not afterwards.',
    inputSchema: {
      project_slug: z.string(),
      title: z.string(),
      source_url: z.string().url(),
      excerpt: z.string().max(2000),
      relevance: z.string().max(1000).describe('Why this supports the claim you are making'),
    },
    readOnly: false,
    async handler(ctx, args) {
      const projectId = await resolveProject(ctx, String(args['project_slug']));
      const { data, error } = await ctx.db
        .from('evidence')
        .insert({
          owner_id: ctx.ownerId,
          project_id: projectId,
          title: String(args['title']),
          source_url: String(args['source_url']),
          excerpt: String(args['excerpt']),
          relevance: String(args['relevance']),
          verification_status: 'unverified',
          captured_by: ctx.agentName,
        })
        .select('id, title')
        .single();
      if (error) fail(error.message);
      return ok({ ...data, verification_status: 'unverified' });
    },
  },

  {
    name: 'omnios_save_draft',
    title: 'Save a draft',
    description:
      'File a draft against a project as an artifact. Drafting is deliberately unrestricted; SENDING is not. Write freely here — nothing saved by this tool goes anywhere on its own.',
    inputSchema: {
      project_slug: z.string(),
      name: z.string(),
      body: z.string().max(50_000),
      artifact_type: z.enum(['draft', 'report', 'note', 'document']).default('draft'),
    },
    readOnly: false,
    async handler(ctx, args) {
      const projectId = await resolveProject(ctx, String(args['project_slug']));
      const { data, error } = await ctx.db
        .from('artifacts')
        .insert({
          owner_id: ctx.ownerId,
          project_id: projectId,
          name: String(args['name']),
          artifact_type: String(args['artifact_type'] ?? 'draft'),
          location_kind: 'inline',
          inline_body: String(args['body']),
          created_by: ctx.agentName,
          metadata: { review_status: 'draft_for_review', source: 'mcp' },
        })
        .select('id, name, artifact_type')
        .single();
      if (error) fail(error.message);
      return ok({ ...data, review_status: 'draft_for_review' });
    },
  },

  {
    name: 'omnios_request_approval',
    title: 'Ask a human to approve something',
    description:
      'Park a consequential action and ask for a decision. This is the ONLY route to anything approval-class. Write the reason for a human who has not been following your work: what you want to do, to whom or what, and why. A vague reason gets denied, and it should be.',
    inputSchema: {
      job_id: z.string().uuid().describe('The queued job this approval would authorise'),
      action_type: z.string(),
      reason: z.string().min(20).max(2000).describe('Plain language, addressed to the person deciding'),
      expires_in_hours: z.number().int().min(1).max(168).default(24),
    },
    readOnly: false,
    async handler(ctx, args) {
      const hours = Number(args['expires_in_hours'] ?? 24);
      const { data, error } = await ctx.db
        .from('approvals')
        .insert({
          owner_id: ctx.ownerId,
          job_id: String(args['job_id']),
          action_type: String(args['action_type']),
          status: 'pending',
          reason: String(args['reason']),
          requested_by_actor_type: 'agent',
          requested_by_name: ctx.agentName,
          expires_at: new Date(Date.now() + hours * 3_600_000).toISOString(),
        })
        .select('id, status, expires_at')
        .single();
      if (error) fail(error.message);
      return ok({
        ...data,
        note: 'Requested. You cannot decide this, and polling it in a loop will not change that. Do something else and check back with omnios_approval_status.',
      });
    },
  },
];

/** Tool names, for tests and for logging. */
export const TOOL_NAMES: string[] = TOOLS.map((t) => t.name);
