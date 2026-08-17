import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Two transports, deliberately different:
 *
 * - createAgentClient(): service-role key, used by the local agent.
 *   It bypasses row-level security, so it is confined instead by the
 *   database guards (0004/0006). Every request carries an
 *   `x-omnios-actor: agent` header so the audit trail attributes work
 *   correctly, and it has NO auth.uid(), which is exactly why it can
 *   never grant an approval.
 *
 * - createUserClient(): publishable key plus a real login, used by the
 *   dashboard. Row-level security applies, and auth.uid() is present,
 *   so this is the only transport that can decide an approval.
 */

export interface AgentClientOptions {
  url: string;
  serviceRoleKey: string;
  agentName: string;
}

export function createAgentClient(opts: AgentClientOptions): SupabaseClient {
  assertPresent('SUPABASE_URL', opts.url);
  assertPresent('SUPABASE_SERVICE_ROLE_KEY', opts.serviceRoleKey);

  return createClient(opts.url, opts.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        'x-omnios-actor': 'agent',
        'x-omnios-actor-name': opts.agentName,
      },
    },
  });
}

export function createUserClient(url: string, publishableKey: string): SupabaseClient {
  assertPresent('SUPABASE_URL', url);
  assertPresent('SUPABASE_ANON_KEY', publishableKey);
  return createClient(url, publishableKey, {
    global: { headers: { 'x-omnios-actor': 'user' } },
  });
}

function assertPresent(name: string, value: string | undefined): void {
  if (!value || value.trim() === '') {
    throw new Error(
      `OMNIOS_MISSING_ENV: ${name} is not set. Copy .env.example to .env and fill it in. ` +
        `Never commit the filled-in file.`,
    );
  }
}

/** Loud, non-leaky check that a service-role key was not shipped to a browser bundle. */
export function assertNotPublicEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('NEXT_PUBLIC_') && /SERVICE_ROLE|SECRET|PASSWORD|DB_URL/i.test(key)) {
      throw new Error(
        `OMNIOS_SECRET_IN_PUBLIC_ENV: ${key} looks like a secret but is exposed to the browser. Rename it.`,
      );
    }
  }
}
