import { Runner } from './runner.js';

/**
 * Watch a lease being renewed, and watch the emergency pause stop a job
 * that is already running.
 *
 * WHY THIS EXISTS. `npm run agent:demo` finishes in about two seconds,
 * which is faster than a single heartbeat interval — so the demo proves
 * the CLAIM path and never exercises the RENEW path at all. Guard test
 * 40 proves the database refuses a renewal while paused, and typecheck
 * proves the runner compiles. Neither proves the two halves meet.
 *
 * That gap matters more than most, because "the emergency pause now
 * stops a running job" is exactly the kind of claim you do not want to
 * discover is wrong during an incident. This command turns it into
 * something you can watch happen.
 *
 * WHAT IT DOES. Queues one internal_write job, claims it with a short
 * lease, and renews that lease in the foreground, printing each renewal.
 * You flip the emergency pause in the dashboard. The next renewal is
 * refused, the runner reports the refusal and marks the job failed.
 *
 *   npm run agent:leasecheck
 *
 * It writes only its own demo rows and always leaves the job in a
 * terminal state, including on Ctrl-C, so nothing is left holding a
 * lease that the reaper then has to clean up.
 */

const RENEW_EVERY_MS = 5_000;
const LEASE_SECONDS = 20;
const GIVE_UP_AFTER_MS = 4 * 60_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runLeaseCheck(runner: Runner, ownerId: string): Promise<void> {
  if (runner.isDryRun) {
    console.log('▸ leasecheck needs real writes. Run it without OMNIOS_DRY_RUN.');
    return;
  }

  console.log('▸ lease check\n');

  const projectId = await runner.ensureProject(
    'demo-system-shakedown',
    'Demo — system shakedown',
    ownerId,
  );

  // research_topic is internal_write, so the pause applies to it.
  // A read-class job would keep heartbeating on purpose (test 41).
  const stamp = new Date().toISOString();
  const job = await runner.queueJob({
    ownerId,
    projectId,
    jobType: 'research_topic',
    payload: { purpose: 'lease check', stamp },
  });

  if (job.reused && Runner.isFinished(job.status)) {
    console.log('  a previous lease check with this stamp already finished; nothing to do.');
    return;
  }

  await runner.claim(job.id);
  console.log(`  claimed job ${job.id.slice(0, 8)} with a ${LEASE_SECONDS}s lease`);
  await runner.setJobStatus(job.id, 'running', { attempt_count: 1 });
  console.log('  job is now running\n');

  console.log('  ┌─────────────────────────────────────────────────────────────┐');
  console.log('  │  Now open the dashboard and engage the EMERGENCY PAUSE.      │');
  console.log('  │  Or, in another terminal:  npm run pause                     │');
  console.log('  │                                                              │');
  console.log('  │  Each renewal below is the runner telling the database it    │');
  console.log('  │  is still working. The pause makes the database say no.      │');
  console.log('  └─────────────────────────────────────────────────────────────┘\n');

  const startedAt = Date.now();
  let renewals = 0;
  let refusal: string | null = null;

  const finish = async (status: 'failed' | 'cancelled', summary: string): Promise<void> => {
    try {
      await runner.setJobStatus(job.id, status, { error_summary: summary.slice(0, 500) });
    } catch (err) {
      console.error(`  could not put job ${job.id.slice(0, 8)} down: ${(err as Error).message}`);
    }
  };

  const onSignal = (): void => {
    console.log('\n  interrupted — releasing the job so the reaper has nothing to clean up.');
    void finish('cancelled', 'OMNIOS_LEASECHECK_INTERRUPTED: operator stopped the check.').then(() => {
      runner.shutdown();
      process.exit(130);
    });
  };
  process.once('SIGINT', onSignal);

  while (Date.now() - startedAt < GIVE_UP_AFTER_MS) {
    await sleep(RENEW_EVERY_MS);
    try {
      const until = await runner.renewLease(job.id, LEASE_SECONDS);
      renewals += 1;
      console.log(`  [${renewals}] renewed — lease now good until ${until.toISOString()}`);
    } catch (err) {
      refusal = (err as Error).message;
      break;
    }
  }

  console.log('');

  if (!refusal) {
    console.log(`  no refusal after ${renewals} renewals and ${Math.round(GIVE_UP_AFTER_MS / 1000)}s.`);
    console.log('  That means the renew path works but the pause was never engaged,');
    console.log('  so the cancellation half is still unproven. Try again and pause.');
    await finish('cancelled', 'OMNIOS_LEASECHECK_TIMEOUT: no pause was engaged during the check.');
    runner.shutdown();
    return;
  }

  console.log(`  REFUSED after ${renewals} successful renewal(s):`);
  console.log(`    ${refusal}\n`);

  const expected = refusal.includes('EMERGENCY_PAUSE');
  console.log(
    expected
      ? '  That is the emergency pause reaching a job that was already running —'
      : '  Refused, but not by the pause. Worth reading the message above closely —',
  );
  console.log(
    expected
      ? '  the gap docs/known-limitations.md has recorded since the build.\n'
      : '  something other than the expected guard stopped this job.\n',
  );

  await finish('failed', `OMNIOS_CANCELLED_BY_PAUSE: ${refusal}`);
  const finalStatus = await runner.jobStatus(job.id);
  console.log(`  job ${job.id.slice(0, 8)} is now ${finalStatus}, and nothing further was attempted.`);
  console.log('  Release the pause when you are done:  npm run resume');

  runner.shutdown();
}
