#!/usr/bin/env node
/**
 * omnios local agent — command line entry point.
 *
 * Commands:
 *   status         show policy, autonomy level, pause state, pending work
 *   register       register/refresh this machine as an agent
 *   run-demo       research → evidence → draft → approval → filing
 *   check <action> ask the policy engine about one action type
 *   refusals       prove that blocked things stay blocked
 *   approvals      list pending approvals (read-only; decide in the dashboard)
 *
 * Every command respects OMNIOS_DRY_RUN=true.
 */
import { Runner } from './runner.js';
import { runResearchToApprovalDemo, demonstrateRefusals } from './workflows/research-to-approval.js';
import { runLeaseCheck } from './leasecheck.js';

const DEFAULT_ALLOWED = [
  'read_source',
  'read_project_files',
  'query_system',
  'research_topic',
  'capture_evidence',
  'create_artifact',
  'organize_project_files',
  'update_task_status',
  'update_job_status',
  'create_task',
  'draft_message',
  'draft_report',
  'send_message', // may attempt; policy forces an approval
];

async function main(): Promise<void> {
  const [command = 'status', ...rest] = process.argv.slice(2);

  const runner = await Runner.create();
  const ownerId = await runner.resolveOwnerId();

  // A claimed job holds a heartbeat timer. Always stop it, including on
  // the error paths, so the process can exit instead of hanging on a
  // live interval.
  const stop = (): void => runner.shutdown();
  process.once('SIGINT', () => {
    stop();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    stop();
    process.exit(143);
  });

  try {
    await dispatch(runner, ownerId, command, rest);
  } finally {
    stop();
  }
}

async function dispatch(
  runner: Runner,
  ownerId: string,
  command: string,
  rest: string[],
): Promise<void> {
  if (runner.isDryRun) {
    console.log('▸ DRY RUN — no database writes will be made.\n');
  }

  switch (command) {
    case 'status': {
      console.log('▸ omnios local agent');
      console.log(`  agent           : ${runner.name}`);
      console.log(`  emergency pause : ${runner.emergencyPause ? 'ON — only read-class work may start' : 'off'}`);
      console.log(`  policy entries  : ${runner.policyEngine.size}`);
      console.log('');
      console.log('▸ autonomy matrix');
      for (const row of runner.policyEngine.matrix()) {
        const auto = row.actions.filter((a) => runner.policyEngine.lookup(a)?.auto_allowed).length;
        console.log(`  ${row.risk.padEnd(18)} ${String(row.actions.length).padStart(2)} actions, ${auto} automatic`);
      }
      console.log('');
      break;
    }

    case 'register': {
      const id = await runner.register(ownerId, DEFAULT_ALLOWED);
      console.log(`▸ registered agent "${runner.name}" → ${id}`);
      console.log(`  allowed actions: ${DEFAULT_ALLOWED.length}`);
      break;
    }

    case 'run-demo': {
      await runner.register(ownerId, DEFAULT_ALLOWED);
      const topic = rest.join(' ') || undefined;
      await runResearchToApprovalDemo(runner, topic);
      break;
    }

    case 'refusals': {
      await runner.register(ownerId, DEFAULT_ALLOWED);
      await demonstrateRefusals(runner);
      break;
    }

    case 'leasecheck': {
      await runner.register(ownerId, DEFAULT_ALLOWED);
      await runLeaseCheck(runner, ownerId);
      break;
    }

    case 'check': {
      const action = rest[0];
      if (!action) {
        console.error('usage: npm run agent -- check <action_type>');
        process.exitCode = 1;
        return;
      }
      await runner.register(ownerId, DEFAULT_ALLOWED);
      const d = runner.check(action);
      console.log(`▸ ${action} → ${d.outcome}`);
      console.log(`  risk  : ${d.riskLevel ?? 'unknown'}`);
      console.log(`  reason: ${d.reason}`);
      break;
    }

    case 'approvals': {
      console.log('▸ pending approvals (decide these in the dashboard, not here)');
      console.log('  the agent runner is deliberately unable to approve anything.');
      break;
    }

    default:
      console.error(
        `Unknown command "${command}". Try: status | register | run-demo | refusals | leasecheck | check | approvals`,
      );
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  const e = err as Error;
  console.error(`\n✖ ${e.name ?? 'Error'}: ${e.message}`);
  process.exitCode = 1;
});
