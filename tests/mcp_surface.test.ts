import { describe, expect, it } from 'vitest';
import { TOOLS, TOOL_NAMES } from '../mcp-server/src/tools.js';

/**
 * Tests over the SHAPE of the MCP tool surface rather than its behaviour.
 *
 * The database is what actually stops an agent approving its own request
 * (guard tests 05 and 06). These tests defend something different and
 * cheaper: that nobody ever adds a tool which *looks* like it grants
 * authority. A tool named omnios_approve would fail at the database, but
 * it would also tell the agent such a thing exists and is worth trying —
 * and a surface that advertises a door is worse than one that doesn't,
 * even when the door is locked.
 *
 * If one of these fails, do not relax the test. Ask why the tool exists.
 */
describe('MCP tool surface', () => {
  it('exposes no tool that could grant, decide or widen authority', () => {
    const forbidden = /approve|approval_decision|decide|deny|grant|promote|authorize|authorise|escalate/i;
    const offenders = TOOL_NAMES.filter((n) => forbidden.test(n) && n !== 'omnios_request_approval');
    expect(offenders).toEqual([]);
  });

  it('exposes no tool that deletes or rewrites history', () => {
    const forbidden = /delete|drop|purge|truncate|remove|erase|rewrite|audit/i;
    expect(TOOL_NAMES.filter((n) => forbidden.test(n))).toEqual([]);
  });

  it('has exactly one route to a consequential action, and it is a request', () => {
    const approvalTools = TOOL_NAMES.filter((n) => n.includes('approval'));
    expect(approvalTools.sort()).toEqual([
      'omnios_approval_status',
      'omnios_list_pending_approvals',
      'omnios_request_approval',
    ]);
    // The two beyond the request are read-only by construction.
    for (const name of ['omnios_approval_status', 'omnios_list_pending_approvals']) {
      expect(TOOLS.find((t) => t.name === name)?.readOnly).toBe(true);
    }
  });

  it('marks every read tool read-only and every write tool not', () => {
    const expected: Record<string, boolean> = {
      omnios_status: true,
      omnios_policy_check: true,
      omnios_list_projects: true,
      omnios_list_pending_approvals: true,
      omnios_approval_status: true,
      omnios_queue_job: false,
      omnios_record_evidence: false,
      omnios_save_draft: false,
      omnios_request_approval: false,
    };
    for (const tool of TOOLS) {
      expect(tool.readOnly, `${tool.name} readOnly flag`).toBe(expected[tool.name]);
    }
    // Nothing undeclared crept in.
    expect(TOOL_NAMES.slice().sort()).toEqual(Object.keys(expected).sort());
  });

  it('requires a substantial reason on an approval request', () => {
    // A one-word reason means the human deciding has nothing to decide on.
    // Denying a vague request is correct, so make vagueness impossible.
    const tool = TOOLS.find((t) => t.name === 'omnios_request_approval');
    const schema = tool?.inputSchema['reason'];
    expect(schema).toBeDefined();
    expect(() => schema!.parse('ok')).toThrow();
    expect(() => schema!.parse('Send the quarterly brief to the consultant for review.')).not.toThrow();
  });

  it('describes every tool well enough for an agent to choose correctly', () => {
    for (const tool of TOOLS) {
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(60);
      expect(tool.title.length, `${tool.name} title`).toBeGreaterThan(3);
    }
  });
});
