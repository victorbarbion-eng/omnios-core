import 'dotenv/config';
import { Client } from 'pg';

/**
 * Direct Postgres connection, used only by the maintenance scripts in
 * this folder (migrate, seed, unseed, pause, claim-ownership).
 *
 * These scripts are the HUMAN channel: you run them in your own
 * terminal, so they identify as omnios.actor_type = 'user'. The agent
 * runner never uses this connection — it goes through PostgREST with
 * the service-role key and an `x-omnios-actor: agent` header, which is
 * what makes the audit trail meaningful and what stops it approving
 * its own requests.
 */
export async function withClient<T>(
  fn: (client: Client) => Promise<T>,
  actor: 'user' | 'system' = 'user',
): Promise<T> {
  const connectionString = process.env['SUPABASE_DB_URL'];
  if (!connectionString) {
    throw new Error(
      'OMNIOS_MISSING_ENV: SUPABASE_DB_URL is not set.\n' +
        '  Supabase dashboard → Project Settings → Database → Connection string (URI).\n' +
        '  Put it in .env, which is gitignored. It contains your database password.',
    );
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query(`select set_config('omnios.actor_type', $1, false)`, [actor]);
    await client.query(`select set_config('omnios.actor_name', $1, false)`, ['cli']);
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Redacts the password before any connection string is printed. */
export function describeTarget(): string {
  const raw = process.env['SUPABASE_DB_URL'] ?? '';
  return raw.replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+(@)/i, '$1[redacted]$2') || '(not set)';
}
