import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withClient, describeTarget } from './db.js';

/**
 * Applies every file in supabase/migrations in filename order, once
 * each, inside a transaction, and records what it applied.
 *
 * Re-running is safe: already-applied files are skipped. A failing file
 * rolls back and stops the run, so the database never ends up half-way
 * through a migration.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'supabase', 'migrations');

async function main(): Promise<void> {
  console.log(`▸ migrate → ${describeTarget()}`);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.log('  no migration files found.');
    return;
  }

  await withClient(async (client) => {
    await client.query(`
      create table if not exists schema_migrations (
        name        text primary key,
        applied_at  timestamptz not null default now()
      );
    `);

    const applied = new Set(
      (await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
    );

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  · ${file} (already applied)`);
        continue;
      }
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`  ▸ ${file} ... `);
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        console.log('ok');
        count += 1;
      } catch (err) {
        await client.query('rollback');
        console.log('FAILED');
        throw new Error(`Migration ${file} failed and was rolled back:\n  ${(err as Error).message}`);
      }
    }

    console.log(`\n▸ ${count} migration(s) applied, ${applied.size} already present.`);
  });
}

main().catch((err: unknown) => {
  console.error(`\n✖ ${(err as Error).message}`);
  process.exitCode = 1;
});
