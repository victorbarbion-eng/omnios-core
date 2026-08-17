import 'dotenv/config';

export interface AgentEnv {
  url: string;
  serviceRoleKey: string;
  agentName: string;
  runtime: 'local' | 'cloud' | 'future_vps';
  workspaceRoot: string;
  dryRun: boolean;
}

export function loadAgentEnv(): AgentEnv {
  const missing: string[] = [];
  const need = (name: string): string => {
    const v = process.env[name];
    if (!v || v.trim() === '') {
      missing.push(name);
      return '';
    }
    return v.trim();
  };

  const url = need('SUPABASE_URL');
  const serviceRoleKey = need('SUPABASE_SERVICE_ROLE_KEY');
  const workspaceRoot = need('OMNIOS_WORKSPACE_ROOT');

  if (missing.length > 0) {
    throw new Error(
      `OMNIOS_MISSING_ENV: ${missing.join(', ')} not set.\n` +
        `  1. cp .env.example .env\n` +
        `  2. fill in the values from Supabase → Project Settings → API\n` +
        `  3. .env is gitignored; keep it that way.`,
    );
  }

  const runtime = (process.env['OMNIOS_AGENT_RUNTIME'] ?? 'local') as AgentEnv['runtime'];
  if (!['local', 'cloud', 'future_vps'].includes(runtime)) {
    throw new Error(`OMNIOS_BAD_ENV: OMNIOS_AGENT_RUNTIME must be local | cloud | future_vps.`);
  }

  return {
    url,
    serviceRoleKey,
    agentName: process.env['OMNIOS_AGENT_NAME'] ?? 'mac-local-runner',
    runtime,
    workspaceRoot,
    dryRun: (process.env['OMNIOS_DRY_RUN'] ?? 'false').toLowerCase() === 'true',
  };
}
