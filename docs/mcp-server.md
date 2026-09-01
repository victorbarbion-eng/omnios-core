# The MCP server — letting an outside agent file work here

`npm run mcp` starts a small HTTP server that exposes nine operations to
an external agent over the Model Context Protocol. It is how Hermes (or
anything else that speaks MCP) can do work inside omnios-core without
being trusted.

## What it exposes, and what it deliberately does not

| Tool | Kind |
|---|---|
| `omnios_status` | read — is the emergency pause on |
| `omnios_policy_check` | read — what would happen if I attempted X |
| `omnios_list_projects` | read |
| `omnios_list_pending_approvals` | read |
| `omnios_approval_status` | read |
| `omnios_queue_job` | write |
| `omnios_record_evidence` | write |
| `omnios_save_draft` | write |
| `omnios_request_approval` | write — **the only route to anything consequential** |

There is no approve tool. No deny tool. No delete tool. No policy
promotion tool. An agent holding this surface can do work, record what it
did, and ask.

**That absence is a convenience, not the control.** Every call goes out
over PostgREST with the service-role key and `x-omnios-actor: agent`,
which means `auth.uid()` is null. `os_guard_approval_decision()` refuses
a decision from such a connection — guard test 05 — so adding an approve
tool tomorrow would produce a tool that fails every time it is called.
The code shape and the schema agree, and the schema is the half that
holds.

`tests/mcp_surface.test.ts` asserts over the surface itself and fails the
build if a tool whose name suggests granting authority ever appears. The
reason is worth stating: a locked door that is advertised is worse than
no door, because an agent will spend turns rattling it.

## Why it runs on the host, not inside the agent's sandbox

The obvious build is a stdio MCP server inside the Hermes container. It
works, and it puts the service-role key inside the sandbox — where a
compromised agent could read it from its own environment and talk to the
database directly, going around this tool surface entirely.

Running on the host instead means the key never crosses the boundary.
The agent gets nine named operations and a bearer token that opens
exactly one door. Same shape as an egress proxy that injects real
credentials on the way out.

## Setup

**1. Generate a token and start the server.** On the host:

```bash
echo "OMNIOS_MCP_TOKEN=$(openssl rand -hex 32)" >> .env
npm run mcp
```

It reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the same
`.env` as the rest of the repo. It refuses to start without a token of at
least 32 characters, because this endpoint can queue jobs and file
approval requests.

**2. Point the agent at it.** For Hermes running in a container, in
`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  omnios:
    url: "http://host.docker.internal:8787/mcp"
    headers:
      Authorization: "Bearer ${OMNIOS_MCP_TOKEN}"
```

and put `OMNIOS_MCP_TOKEN=...` in the container's environment. Hermes
substitutes `${VAR}` at connect time, so the token stays out of the
config file.

For an agent on the host, use `http://127.0.0.1:8787/mcp`.

## Network exposure, stated plainly

Docker Desktop cannot reach a macOS process bound to `127.0.0.1`, so
serving a containerised agent requires binding a real interface. The
default bind is therefore `0.0.0.0`, with two mitigations:

- a bearer token, compared in constant time;
- callers outside private address ranges are refused
  (`OMNIOS_MCP_ALLOW_PUBLIC_CLIENTS=true` disables this — don't).

Neither is a security boundary. The boundary is the database. Run this on
a trusted network, and set `OMNIOS_MCP_HOST=127.0.0.1` if your agent is
on the host and doesn't need the wider bind.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `OMNIOS_MCP_TOKEN` | *(required, ≥32 chars)* | Bearer token clients must present |
| `OMNIOS_MCP_PORT` | `8787` | Listen port |
| `OMNIOS_MCP_HOST` | `0.0.0.0` | Bind address |
| `OMNIOS_MCP_AGENT_NAME` | `hermes-caged` | Name work is attributed to in the audit trail |
| `OMNIOS_MCP_ALLOW_PUBLIC_CLIENTS` | `false` | Allow non-private callers |

## What this does not do

- It does not sandbox the agent. That is the agent's own container's job,
  and the two are unrelated: this guards database writes, a container
  guards the filesystem. A shell command never meets a guard here.
- It does not stop an agent leaking what it can read. The tools return
  project and approval data; an agent that can reach the internet can
  forward it.
- It does not enforce `max_concurrent_jobs`, which remains stored and
  unread.
