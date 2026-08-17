import { describe, expect, it } from 'vitest';
import { PolicyEngine, type ActionPolicy } from '@omnios/shared';

/**
 * These tests encode the promises made in docs/approval-policy.md.
 * If one of them fails, the system is more permissive than documented,
 * which is the failure mode that actually matters.
 */
const policies: ActionPolicy[] = [
  { action_type: 'read_source', risk_level: 'read', description: '', auto_allowed: true },
  { action_type: 'capture_evidence', risk_level: 'internal_write', description: '', auto_allowed: true },
  { action_type: 'draft_message', risk_level: 'external_draft', description: '', auto_allowed: true },
  { action_type: 'send_message', risk_level: 'approval_required', description: '', auto_allowed: false },
  { action_type: 'deploy', risk_level: 'approval_required', description: '', auto_allowed: false },
  { action_type: 'delete_data', risk_level: 'approval_required', description: '', auto_allowed: false },
  { action_type: 'disable_audit', risk_level: 'prohibited', description: '', auto_allowed: false },
];

const engine = new PolicyEngine(policies);
const allowedToAgent = policies.map((p) => p.action_type);

const decide = (action: string, opts: Partial<{ emergencyPause: boolean; agentAllowedActions: string[] }> = {}) =>
  engine.decide(action, {
    emergencyPause: opts.emergencyPause ?? false,
    agentAllowedActions: opts.agentAllowedActions ?? allowedToAgent,
  });

describe('unknown actions', () => {
  it('refuses anything not in the policy table', () => {
    const d = decide('launch_missiles');
    expect(d.outcome).toBe('refuse');
    expect(d.riskLevel).toBeNull();
  });

  it('does not invent a risk level for an unknown action', () => {
    expect(engine.riskLevel('launch_missiles')).toBeNull();
  });
});

describe('prohibited actions', () => {
  it('refuses regardless of the agent grant', () => {
    expect(decide('disable_audit').outcome).toBe('refuse');
  });

  it('stays refused even when the agent is explicitly granted it', () => {
    expect(decide('disable_audit', { agentAllowedActions: ['disable_audit'] }).outcome).toBe('refuse');
  });
});

describe('consequential actions', () => {
  for (const action of ['send_message', 'deploy', 'delete_data']) {
    it(`never auto-allows ${action}`, () => {
      const d = decide(action);
      expect(d.outcome).toBe('needs_approval');
      expect(d.riskLevel).toBe('approval_required');
    });
  }

  it('cannot be promoted by the agent grant alone', () => {
    expect(decide('send_message', { agentAllowedActions: ['send_message'] }).outcome).toBe('needs_approval');
  });
});

describe('low-risk actions', () => {
  it('allows reads', () => {
    expect(decide('read_source').outcome).toBe('allow');
  });

  it('allows internal writes', () => {
    expect(decide('capture_evidence').outcome).toBe('allow');
  });

  it('allows preparing a draft, which sends nothing', () => {
    expect(decide('draft_message').outcome).toBe('allow');
  });
});

describe('per-agent grant', () => {
  it('refuses an action the agent was not granted, even a harmless one', () => {
    const d = decide('capture_evidence', { agentAllowedActions: ['read_source'] });
    expect(d.outcome).toBe('refuse');
  });

  it('treats an empty grant as no permissions, not all permissions', () => {
    expect(decide('read_source', { agentAllowedActions: [] }).outcome).toBe('refuse');
  });
});

describe('emergency pause', () => {
  it('still permits read-class work', () => {
    expect(decide('read_source', { emergencyPause: true }).outcome).toBe('allow');
  });

  it('blocks internal writes', () => {
    expect(decide('capture_evidence', { emergencyPause: true }).outcome).toBe('refuse');
  });

  it('blocks drafts', () => {
    expect(decide('draft_message', { emergencyPause: true }).outcome).toBe('refuse');
  });

  it('blocks approval-required work outright rather than queueing it', () => {
    expect(decide('send_message', { emergencyPause: true }).outcome).toBe('refuse');
  });
});

describe('reporting', () => {
  it('groups the matrix by risk level', () => {
    const matrix = engine.matrix();
    const risks = matrix.map((m) => m.risk);
    expect(risks).toContain('approval_required');
    expect(matrix.find((m) => m.risk === 'approval_required')?.actions).toContain('send_message');
  });

  it('knows how many policies it holds', () => {
    expect(engine.size).toBe(policies.length);
  });

  it('gives a reason for every decision', () => {
    for (const p of policies) {
      expect(decide(p.action_type).reason.length).toBeGreaterThan(10);
    }
  });
});
