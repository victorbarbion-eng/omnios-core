import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withClient, describeTarget } from './db.js';

/**
 * Runs tests/db_guards.sql against the target database and prints the
 * results as a table.
 *
 *   npm run db:guards
 *
 * These are the tests that matter most in this project, because they
 * assert what the database REFUSES rather than what the code does. They
 * run against the live project on purpose: a guard that passes on a
 * local copy and not in production is not a guard.
 *
 * Safe to run against live. The suite creates its own fixtures, all
 * owned by the placeholder id 00000000-0000-0000-0000-0000000000aa and
 * slugged 'selftest-*', and deletes them at the end. It briefly engages
 * and then releases the emergency pause, so avoid running it while a
 * real job is mid-flight.
 *
 * It does NOT cover the concurrent-claim race: os_selftest() is one
 * function in one transaction, and FOR UPDATE SKIP LOCKED is about what
 * separate transactions do simultaneously. For that, see
 * tests/concurrent_claim.sh.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = join(HERE, '..', 'tests', 'db_guards.sql');

interface Row {
  test: string;
  passed: boolean;
  detail: string;
}

async function main(): Promise<void> {
  console.log(`▸ guard suite → ${describeTarget()}\n`);

  const sql = await readFile(SUITE, 'utf8');

  await withClient(async (client) => {
    await client.query(sql); // (re)creates public.os_selftest()
    const { rows } = await client.query<Row>('select * from os_selftest()');

    let failed = 0;
    for (const r of rows) {
      if (!r.passed) failed += 1;
      const mark = r.passed ? 'PASS' : 'FAIL';
      console.log(`  ${mark}  ${r.test}`);
      if (!r.passed) console.log(`        ${r.detail}`);
    }

    await client.query('drop function if exists os_selftest()');

    const passed = rows.length - failed;
    console.log(`\n▸ ${passed}/${rows.length} passed`);

    if (failed > 0) {
      throw new Error(
        `${failed} guard test(s) failed. A failing guard means the database is not ` +
          `refusing something it is supposed to refuse. Do not run agents against it until this is understood.`,
      );
    }
  }, 'user');
}

main().catch((err: unknown) => {
  console.error(`\n✖ ${(err as Error).message}`);
  process.exitCode = 1;
});
