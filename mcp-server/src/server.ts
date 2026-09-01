import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createAgentClient, redact } from '@omnios/shared';
import { TOOLS, TOOL_NAMES, type ToolContext } from './tools.js';

/**
 * An MCP server that lets an outside agent file work into omnios-core.
 *
 * WHY IT RUNS ON THE HOST, NOT IN THE AGENT'S CONTAINER.
 * The obvious build is a stdio server inside the Hermes container. That
 * works and it puts the service-role key inside the sandbox, where a
 * compromised agent could read it out of its own environment and talk to
 * the database directly, bypassing this tool surface entirely.
 *
 * Running here instead means the key never crosses the boundary. The
 * agent gets nine named operations over HTTP and no credential. Same
 * idea as an egress proxy that swaps in real keys on the way out: the
 * sandbox holds a token that only opens this door.
 *
 * WHAT THIS PROCESS DOES NOT PROTECT AGAINST, stated plainly:
 * it is not the security boundary. The boundary is os_guard_jobs() and
 * os_guard_approval_decision() in migrations 0004/0006/0008. Every call
 * below goes out with `x-omnios-actor: agent` and no auth.uid(), so the
 * database refuses an approval decision from it regardless of what code
 * lives here. If this file were replaced wholesale by something hostile,
 * the guarantees in docs/tutorial.md would still hold.
 *
 * NETWORK EXPOSURE. Docker Desktop cannot reach a macOS process bound to
 * 127.0.0.1, so serving the container requires binding a real interface.
 * Two mitigations, and neither is a boundary either: a required bearer
 * token compared in constant time, and a default refusal of callers from
 * outside private address ranges. Put this on a trusted network.
 */

const PORT = Number(process.env['OMNIOS_MCP_PORT'] ?? 8787);
const HOST = process.env['OMNIOS_MCP_HOST'] ?? '0.0.0.0';
const TOKEN = process.env['OMNIOS_MCP_TOKEN'] ?? '';
const AGENT_NAME = process.env['OMNIOS_MCP_AGENT_NAME'] ?? 'hermes-caged';
const ALLOW_PUBLIC = process.env['OMNIOS_MCP_ALLOW_PUBLIC_CLIENTS'] === 'true';

if (!TOKEN || TOKEN.length < 32) {
  console.error(
    'OMNIOS_MCP_TOKEN is missing or shorter than 32 characters.\n' +
      '  This endpoint can queue jobs and file approval requests, so it is not optional.\n' +
      '  Generate one:  openssl rand -hex 32',
  );
  process.exit(1);
}

const db = createAgentClient({
  url: process.env['SUPABASE_URL'] ?? '',
  serviceRoleKey: process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
  agentName: AGENT_NAME,
});

/** Constant-time compare, so a wrong token leaks nothing through timing. */
function tokenMatches(presented: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Private ranges plus loopback — the Docker bridge lives in 172.16/12. */
function isPrivateAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const ip = addr.replace(/^::ffff:/, '');
  if (ip === '::1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m) {
    const second = Number(m[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

async function resolveOwnerId(): Promise<string> {
  const { data, error } = await db.from('projects').select('owner_id').limit(1).maybeSingle();
  if (error) throw new Error(`Cannot resolve owner: ${error.message}`);
  if (!data?.owner_id) {
    throw new Error(
      'No projects exist yet, so there is no owner to file work against. Run npm run db:seed or create a project first.',
    );
  }
  return data.owner_id as string;
}

function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'omnios-core', version: '0.1.0' },
    {
      instructions:
        'omnios-core: a system of record with a database-enforced approval policy.\n' +
        'You may research, draft, record evidence and queue jobs freely.\n' +
        'Anything consequential stops and waits for a human: request it with ' +
        'omnios_request_approval and carry on with something else.\n' +
        'You cannot approve your own request. This is structural, not a rule — ' +
        'the database refuses a decision from a connection with no signed-in human ' +
        'behind it, and this connection has none. Do not spend turns trying.',
    },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: false },
      },
      async (args: Record<string, unknown>) => {
        const started = Date.now();
        try {
          const result = await tool.handler(ctx, args ?? {});
          console.log(`  ${tool.name} ok (${Date.now() - started}ms)`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const message = redact((err as Error).message);
          // Refusals are reported to the agent as content rather than as a
          // protocol error, because the refusal text is the useful part —
          // OMNIOS_APPROVAL_REQUIRED tells it exactly what to do next.
          console.log(`  ${tool.name} refused: ${message}`);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: message }],
          };
        }
      },
    );
  }

  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error('Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function deny(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

async function main(): Promise<void> {
  const ownerId = await resolveOwnerId();
  const ctx: ToolContext = { db, ownerId, agentName: AGENT_NAME };

  const http = createServer((req, res) => {
    void (async () => {
      const peer = req.socket.remoteAddress;

      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, tools: TOOL_NAMES.length }));
        return;
      }

      if (!ALLOW_PUBLIC && !isPrivateAddress(peer)) {
        console.warn(`refused non-private caller ${peer}`);
        return deny(res, 403, 'Caller is not on a private network.');
      }

      const auth = req.headers['authorization'] ?? '';
      const presented = Array.isArray(auth) ? '' : auth.replace(/^Bearer\s+/i, '');
      if (!presented || !tokenMatches(presented)) {
        console.warn(`refused bad token from ${peer}`);
        return deny(res, 401, 'Missing or invalid bearer token.');
      }

      if (req.url !== '/mcp') return deny(res, 404, 'Not found. The MCP endpoint is /mcp.');

      try {
        // Stateless: a fresh server and transport per request. Nothing is
        // kept between calls, so a crashed or hostile session cannot leak
        // into the next one.
        const body = await readBody(req);
        const server = buildMcpServer(ctx);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        console.error(`request failed: ${redact((err as Error).message)}`);
        if (!res.headersSent) deny(res, 500, 'Internal error.');
      }
    })();
  });

  http.listen(PORT, HOST, () => {
    console.log(`▸ omnios MCP server`);
    console.log(`  listening   http://${HOST}:${PORT}/mcp`);
    console.log(`  owner       ${ownerId}`);
    console.log(`  agent name  ${AGENT_NAME}`);
    console.log(`  tools       ${TOOL_NAMES.join(', ')}`);
    console.log('');
    console.log('  No approve or deny tool exists here, and the database would');
    console.log('  refuse one from this connection regardless. That is the point.');
  });
}

main().catch((err: unknown) => {
  console.error(`\n✖ ${redact((err as Error).message)}`);
  process.exitCode = 1;
});

export { randomUUID };
