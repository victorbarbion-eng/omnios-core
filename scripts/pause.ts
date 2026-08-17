import { withClient, describeTarget } from './db.js';

/**
 * The kill switch, from your own terminal.
 *
 *   npm run pause      → engage
 *   npm run resume     → release
 *
 * Engaging it stops any job that is not read-class from starting. Work
 * already running is not force-killed; it finishes or fails on its own,
 * and nothing new begins. The dashboard has the same control.
 *
 * This runs over a direct database connection, which is a human
 * channel: an API key on its own cannot flip this (see migration 0008).
 */
const ON = !process.argv.includes('--off');
const REASON = process.argv.find((a) => a.startsWith('--reason='))?.slice('--reason='.length);

async function main(): Promise<void> {
  console.log(`▸ emergency pause → ${ON ? 'ENGAGE' : 'RELEASE'}  (${describeTarget()})`);

  await withClient(async (client) => {
    const { rows } = await client.query<{ os_set_emergency_pause: boolean }>(
      'select os_set_emergency_pause($1, $2)',
      [ON, REASON ?? (ON ? 'engaged from the CLI' : 'released from the CLI')],
    );
    const state = rows[0]?.os_set_emergency_pause;
    console.log(`\n  emergency_pause = ${state}`);

    if (state) {
      const blocked = await client.query<{ n: string }>(
        `select count(*)::text as n from jobs where status in ('queued', 'claimed')`,
      );
      console.log(`  ${blocked.rows[0]?.n ?? '0'} queued/claimed job(s) will not be allowed to start.`);
      console.log('  release with: npm run resume');
    } else {
      console.log('  normal operation resumed.');
    }
  }, 'user');
}

main().catch((err: unknown) => {
  console.error(`\n✖ ${(err as Error).message}`);
  process.exitCode = 1;
});
