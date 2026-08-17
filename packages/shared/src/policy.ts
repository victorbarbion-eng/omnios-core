import type { ActionPolicy, PolicyDecision, RiskClass } from './types.js';

/**
 * The policy engine answers exactly one question: "given this action
 * type, may I proceed now, must a human approve first, or is this
 * refused outright?"
 *
 * Two design rules:
 *
 * 1. Unknown action types are REFUSED, never allowed. A capability the
 *    policy table has never heard of is not a capability.
 * 2. This engine is advisory-in-depth, not the last line of defence.
 *    The database triggers in 0004_guards_and_audit.sql enforce the
 *    same rules server-side, so an agent that skipped this class still
 *    cannot execute an unapproved action.
 */
export class PolicyEngine {
  private readonly byAction: Map<string, ActionPolicy>;

  constructor(policies: ActionPolicy[]) {
    this.byAction = new Map(policies.map((p) => [p.action_type, p]));
  }

  get size(): number {
    return this.byAction.size;
  }

  lookup(actionType: string): ActionPolicy | undefined {
    return this.byAction.get(actionType);
  }

  riskLevel(actionType: string): RiskClass | null {
    return this.byAction.get(actionType)?.risk_level ?? null;
  }

  /**
   * @param actionType         action type, must exist in action_policies
   * @param opts.emergencyPause whether the kill switch is on
   * @param opts.agentAllowedActions the agent's own allowed_actions list;
   *        an empty list means "no actions", not "all actions"
   */
  decide(
    actionType: string,
    opts: { emergencyPause: boolean; agentAllowedActions?: string[] },
  ): PolicyDecision {
    const policy = this.byAction.get(actionType);

    if (!policy) {
      return {
        outcome: 'refuse',
        actionType,
        riskLevel: null,
        reason: `Unknown action type "${actionType}". Not present in action_policies, so it is refused.`,
      };
    }

    if (policy.risk_level === 'prohibited') {
      return {
        outcome: 'refuse',
        actionType,
        riskLevel: policy.risk_level,
        reason: `Action "${actionType}" is prohibited at every autonomy level in this build.`,
      };
    }

    // The kill switch: while paused, only read-class work may proceed.
    if (opts.emergencyPause && policy.risk_level !== 'read') {
      return {
        outcome: 'refuse',
        actionType,
        riskLevel: policy.risk_level,
        reason: `Emergency pause is active. Only risk_level=read actions may run; "${actionType}" is ${policy.risk_level}.`,
      };
    }

    // Per-agent scope. Checked before autonomy, so a narrow agent
    // cannot borrow a broad permission.
    const allowed = opts.agentAllowedActions;
    if (allowed && !allowed.includes(actionType)) {
      return {
        outcome: 'refuse',
        actionType,
        riskLevel: policy.risk_level,
        reason: `This agent is not registered for "${actionType}". Its allowed_actions list does not include it.`,
      };
    }

    if (policy.auto_allowed) {
      return {
        outcome: 'allow',
        actionType,
        riskLevel: policy.risk_level,
        reason: `"${actionType}" is ${policy.risk_level} and auto_allowed under the current autonomy level.`,
      };
    }

    return {
      outcome: 'needs_approval',
      actionType,
      riskLevel: policy.risk_level,
      reason: `"${actionType}" requires explicit human approval before it can execute.`,
    };
  }

  /** Human-readable autonomy matrix, for docs and the dashboard. */
  matrix(): Array<{ risk: RiskClass; actions: string[] }> {
    const order: RiskClass[] = [
      'read',
      'internal_write',
      'external_draft',
      'approval_required',
      'prohibited',
    ];
    return order.map((risk) => ({
      risk,
      actions: [...this.byAction.values()]
        .filter((p) => p.risk_level === risk)
        .map((p) => p.action_type)
        .sort(),
    }));
  }
}
