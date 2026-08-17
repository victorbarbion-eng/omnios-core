import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withClient, describeTarget } from './db.js';

/**
 * Loads supabase/seed.sql: one clearly labelled demo project and a
 * small set of related rows. Every row it creates has is_demo = true,
 * so `npm run db:unseed` can remove all of it without touching real
 * work.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  console.log(`▸ seed → ${describeTarget()}`);
  const sql = await readFile(join(HERE, '..', 'supabase', 'seed.sql'), 'utf8');

  await withClient(async (client) => {
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw new Error(`Seed failed and was rolled back:\n  ${(err as Error).message}`);
    }

    const { rows } = await client.query<{ table_name: string; n: string }>(`
      select 'projects'  as table_name, count(*)::text as n from projects  where is_demo
      union all select 'tasks',     count(*)::text from tasks     where is_demo
      union all select 'agents',    count(*)::text from agents    where is_demo
      union all select 'artifacts', count(*)::text from artifacts where is_demo
      union all select 'jobs',      count(*)::text from jobs      where is_demo
      union all select 'approvals', count(*)::text from approvals where is_demo
      union all select 'evidence',  count(*)::text from evidence  where is_demo
      order by table_name;
    `);
    console.log('\n▸ demo rows now present');
    for (const r of rows) console.log(`  ${r.table_name.padEnd(10)} ${r.n}`);
    console.log('\n  remove it all later with: npm run db:unseed');
  });
}

main().catch((err: unknown) => {
  console.error(`\n✖ ${(err as Error).message}`);
  process.exitCode = 1;
});
