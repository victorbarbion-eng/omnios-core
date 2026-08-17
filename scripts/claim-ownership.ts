import { withClient, describeTarget } from './db.js';

/**
 * The seed data is created before you have an account, so it is owned
 * by a placeholder id. Row-level security will therefore hide it from
 * you when you first sign in to the dashboard.
 *
 * Run this once, after creating your user in the Supabase dashboard,
 * to move the placeholder-owned rows to your real account:
 *
 *   npm run db:claim -- you@example.com
 *
 * It only ever reassigns rows owned by the placeholder id. It will not
 * touch anything already owned by a real account.
 */
const PLACEHOLDER = '00000000-0000-0000-0000-0000000000aa';
const TABLES = ['projects', 'agents', 'tasks', 'artifacts', 'jobs', 'approvals', 'evidence', 'job_logs'];

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('usage: npm run db:claim -- you@example.com');
    process.exitCode = 1;
    return;
  }

  console.log(`▸ claim ownership → ${describeTarget()}`);

  await withClient(async (client) => {
    const user = await client.query<{ id: string }>('select id from auth.users where email = $1', [email]);
    const uid = user.rows[0]?.id;

    if (!uid) {
      const all = await client.query<{ email: string }>('select email from auth.users order by created_at');
      throw new Error(
        `No account found for ${email}.\n` +
          '  Create one first: Supabase dashboard → Authentication → Users → Add user\n' +
          '  (tick "auto confirm user" so you can sign in immediately).\n' +
          `  Existing accounts: ${all.rows.map((r) => r.email).join(', ') || '(none)'}`,
      );
    }

    console.log(`  account: ${email} → ${uid}\n`);

    await client.query('begin');
    try {
      for (const table of TABLES) {
        const r = await client.query(`update ${table} set owner_id = $1 where owner_id = $2`, [uid, PLACEHOLDER]);
        console.log(`  ${table.padEnd(10)} ${r.rowCount ?? 0} row(s) reassigned`);
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw new Error(`Reassignment failed and was rolled back:\n  ${(err as Error).message}`);
    }

    console.log('\n▸ done. Sign in to the dashboard and the demo project will be visible.');
    console.log('  Audit history keeps its original attribution on purpose.');
  }, 'user');
}

main().catch((err: unknown) => {
  console.error(`\n✖ ${(err as Error).message}`);
  process.exitCode = 1;
});
