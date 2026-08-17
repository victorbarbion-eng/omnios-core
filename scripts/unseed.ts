import { withClient, describeTarget } from './db.js';

/**
 * Removes every row marked is_demo = true, in dependency order.
 *
 * Deliberately narrow: it will not touch anything that is not flagged
 * as demo data, and it refuses to run if you have not confirmed. Audit
 * history is append-only and is intentionally left alone — the record
 * that the demo happened is itself part of the trail.
 */
const CONFIRM = process.argv.includes('--yes');

async function main(): Promise<void> {
  console.log(`▸ unseed → ${describeTarget()}`);

  if (!CONFIRM) {
    console.log(
      '\n  This deletes all rows flagged is_demo = true.\n' +
        '  Audit events are append-only and will be kept.\n' +
        '  Re-run with:  npm run db:unseed -- --yes\n',
    );
    return;
  }

  await withClient(async (client) => {
    await client.query('begin');
    try {
      const order = ['evidence', 'approvals', 'job_logs', 'jobs', 'artifacts', 'tasks', 'agents', 'projects'];
      for (const table of order) {
        if (table === 'job_logs') {
          const r = await client.query(
            'delete from job_logs where job_id in (select id from jobs where is_demo)',
          );
          console.log(`  ${table.padEnd(10)} ${r.rowCount ?? 0} removed`);
          continue;
        }
        const r = await client.query(`delete from ${table} where is_demo`);
        console.log(`  ${table.padEnd(10)} ${r.rowCount ?? 0} removed`);
      }
      await client.query('commit');
      console.log('\n▸ demo data removed. Audit history retained.');
    } catch (err) {
      await client.query('rollback');
      throw new Error(`Unseed failed and was rolled back:\n  ${(err as Error).message}`);
    }
  });
}

main().catch((err: unknown) => {
  console.error(`\n✖ ${(err as Error).message}`);
  process.exitCode = 1;
});
