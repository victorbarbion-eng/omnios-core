import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Does every column the MCP tools read or write actually exist?
 *
 * WHY THIS FILE EXISTS. The first version of mcp-server/src/tools.ts had
 * four of nine tools broken: it wrote `reason` to approvals (the column
 * is `action_preview`), `relevance` to evidence (it is `relevance_note`),
 * `verification_status` (it is `verification`), and omitted three NOT
 * NULL columns entirely. Every test passed. tests/mcp_surface.test.ts
 * checked the SHAPE of the tool list, and the protocol probe ran against
 * a stub backend that accepted any JSON. Two green suites, four tools
 * that would fail on first contact with the real database.
 *
 * The lesson generalises past this repo: a test that never touches the
 * real thing tells you your code is self-consistent, which is not the
 * property anyone cares about. This file closes that specific gap by
 * reading the migrations as the source of truth and checking the tool
 * source against them.
 *
 * It is a lint, not a proof. It parses SQL and TypeScript with regular
 * expressions, so it catches misspelled and invented column names — the
 * mistake that actually happened — and will not catch a wrong VALUE in a
 * right column. Do not let its passing stand in for running the tools
 * against a real database.
 */

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const TOOLS_SRC = join(__dirname, '..', 'mcp-server', 'src', 'tools.ts');

/** table -> set of column names, accumulated across all migrations. */
function readSchema(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();

  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');

    // create table <name> ( ... );
    const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(\w+)\s*\(([\s\S]*?)\n\);/gi;
    for (let m = createRe.exec(sql); m; m = createRe.exec(sql)) {
      const [, table, body] = m;
      const cols = tables.get(table) ?? new Set<string>();
      for (const rawLine of body.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('--')) continue;
        // Skip table-level constraint clauses.
        if (/^(constraint|primary\s+key|unique|check|foreign\s+key)\b/i.test(line)) continue;
        const col = /^([a-z_][a-z0-9_]*)\s+/i.exec(line);
        if (col) cols.add(col[1]);
      }
      tables.set(table, cols);
    }

    // alter table <name> add column [if not exists] <col>
    const alterRe = /alter\s+table\s+(\w+)([\s\S]*?);/gi;
    for (let m = alterRe.exec(sql); m; m = alterRe.exec(sql)) {
      const [, table, body] = m;
      const cols = tables.get(table) ?? new Set<string>();
      const addRe = /add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi;
      for (let a = addRe.exec(body); a; a = addRe.exec(body)) cols.add(a[1]);
      tables.set(table, cols);
    }
  }

  return tables;
}

/**
 * The object literal passed to `.insert({...})`, matched by counting
 * braces rather than with a lazy regex.
 *
 * The lazy version stopped at the first `}`, which in practice is the
 * `{}` inside `redactObject(x ?? {})` — so it silently dropped every key
 * after it and reported columns as missing that were plainly there. A
 * checking tool that cries wolf gets switched off, so it has to be right.
 */
function extractInsertObject(src: string): string | null {
  const start = src.indexOf('.insert({');
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** Keys at nesting depth 0 of an object-literal body. */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (depth === 0) {
      const m = /^([a-z_][a-z0-9_]*)\s*:/i.exec(trimmed);
      if (m) keys.push(m[1]);
    }
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
    }
  }
  return keys;
}

/**
 * Pull out `.from('table')` and the `.insert({...})` / `.select('a, b')`
 * that follow it, so each column reference can be attributed to a table.
 */
function readToolUsage(src: string): { table: string; column: string; kind: string }[] {
  const found: { table: string; column: string; kind: string }[] = [];
  const fromRe = /\.from\('(\w+)'\)/g;

  // Bound each statement by the NEXT .from(), not by the next semicolon.
  // A semicolon bound looks right and silently truncates any query long
  // enough to matter — which is how the first version of this file passed
  // while the evidence insert it was meant to check went unread.
  const starts: { table: string; index: number }[] = [];
  for (let m = fromRe.exec(src); m; m = fromRe.exec(src)) {
    starts.push({ table: m[1], index: m.index });
  }

  for (let i = 0; i < starts.length; i += 1) {
    const { table, index } = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].index : src.length;
    const rest = src.slice(index, end);

    const sel = /\.select\(\s*(?:'([^']*)'|"([^"]*)")/.exec(rest);
    if (sel) {
      const cols = (sel[1] ?? sel[2] ?? '').split(',').map((c) => c.trim()).filter(Boolean);
      for (const c of cols) {
        if (c === '*' || c.includes('(')) continue;
        found.push({ table, column: c, kind: 'select' });
      }
    }

    const insBody = extractInsertObject(rest);
    if (insBody !== null) {
      // Only top-level keys are columns. A key nested inside a value —
      // metadata: { review_status: ... } — is not a column, and counting
      // it would produce noisy false failures.
      for (const key of topLevelKeys(insBody)) {
        found.push({ table, column: key, kind: 'insert' });
      }
    }

    const eqRe = /\.eq\('(\w+)'/g;
    for (let e = eqRe.exec(rest); e; e = eqRe.exec(rest)) {
      found.push({ table, column: e[1], kind: 'filter' });
    }

    const ordRe = /\.order\('(\w+)'/g;
    for (let o = ordRe.exec(rest); o; o = ordRe.exec(rest)) {
      found.push({ table, column: o[1], kind: 'order' });
    }
  }

  return found;
}

describe('MCP tools match the real database schema', () => {
  const schema = readSchema();
  const usage = readToolUsage(readFileSync(TOOLS_SRC, 'utf8'));

  it('parsed the migrations at all', () => {
    // A silently empty parse would make every assertion below vacuous.
    expect(schema.size).toBeGreaterThan(8);
    expect(schema.get('approvals')?.has('action_preview')).toBe(true);
    expect(schema.get('evidence')?.has('relevance_note')).toBe(true);
    expect(usage.length).toBeGreaterThan(20);
  });

  it('references only columns that exist', () => {
    const bad = usage.filter(({ table, column }) => {
      const cols = schema.get(table);
      return !cols || !cols.has(column);
    });
    expect(
      bad.map((b) => `${b.table}.${b.column} (${b.kind})`),
      'columns used by mcp-server/src/tools.ts that no migration defines',
    ).toEqual([]);
  });

  it('supplies every NOT NULL column without a default when inserting', () => {
    // The other half of the original bug: three NOT NULL columns on
    // approvals were simply absent from the insert.
    const required: Record<string, string[]> = {
      approvals: ['project_id', 'action_type', 'action_preview', 'target_reference'],
      evidence: ['project_id', 'title'],
      artifacts: ['project_id', 'name'],
      jobs: ['project_id', 'job_type', 'idempotency_key'],
    };
    for (const [table, cols] of Object.entries(required)) {
      const inserted = new Set(
        usage.filter((u) => u.table === table && u.kind === 'insert').map((u) => u.column),
      );
      if (inserted.size === 0) continue; // this tool set does not insert here
      for (const col of cols) {
        expect(inserted.has(col), `${table} insert is missing required column ${col}`).toBe(true);
      }
    }
  });
});
