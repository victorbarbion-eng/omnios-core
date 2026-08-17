import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { Badge, Empty, ErrorBox, PageHeader, Panel, TD, TH, Table } from '@/components/ui';
import { fmtDateTime, pretty, shortId } from '@/lib/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const ACTOR_TYPES = ['user', 'agent', 'system'] as const;

type AuditRow = {
  id: number;
  created_at: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  project_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before_data: unknown;
  after_data: unknown;
  metadata: unknown;
};

type Search = {
  project?: string;
  actor?: string;
  action?: string;
  entity?: string;
  page?: string;
};

function buildQuery(base: Search, overrides: Search): string {
  const merged = { ...base, ...overrides };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v && v.length > 0) params.set(k, v);
  }
  const s = params.toString();
  return s ? `/audit?${s}` : '/audit';
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const supabase = await createClient();

  let query = supabase
    .from('audit_events')
    .select(
      'id,created_at,actor_type,actor_id,actor_name,project_id,action,entity_type,entity_id,before_data,after_data,metadata',
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })
    .range(from, to);

  if (sp.project) query = query.eq('project_id', sp.project);
  if (sp.actor) query = query.eq('actor_type', sp.actor);
  if (sp.action) query = query.ilike('action', `%${sp.action}%`);
  if (sp.entity) query = query.ilike('entity_type', `%${sp.entity}%`);

  const [{ data, error, count }, projects] = await Promise.all([
    query,
    supabase.from('projects').select('id,name').order('name'),
  ]);

  const rows = (data ?? []) as AuditRow[];
  const projectRows = (projects.data ?? []) as { id: string; name: string }[];
  const projectName = new Map(projectRows.map((p) => [p.id, p.name]));
  const total = count ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const inputCls =
    'mt-1 w-full border border-line bg-base px-2 py-1 font-mono text-xs text-ink outline-none focus:border-blue-500/60';

  return (
    <div className="space-y-4">
      <PageHeader
        title="Audit"
        meta={`${total} matching event(s) — append-only history. Page ${page} of ${lastPage}, ${PAGE_SIZE} rows per page.`}
      />

      <ErrorBox error={error} context="audit_events" />
      <ErrorBox error={projects.error} context="projects (filter list)" />

      <Panel title="Filters" source="audit_events">
        <form method="get" action="/audit" className="grid grid-cols-1 gap-3 px-3 py-2 sm:grid-cols-2 lg:grid-cols-5">
          <label className="block">
            <span className="font-mono text-2xs uppercase tracking-wider text-dimmer">project</span>
            <select name="project" defaultValue={sp.project ?? ''} className={inputCls}>
              <option value="">any project</option>
              {projectRows.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="font-mono text-2xs uppercase tracking-wider text-dimmer">actor_type</span>
            <select name="actor" defaultValue={sp.actor ?? ''} className={inputCls}>
              <option value="">any actor</option>
              {ACTOR_TYPES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="font-mono text-2xs uppercase tracking-wider text-dimmer">action contains</span>
            <input name="action" defaultValue={sp.action ?? ''} placeholder="status_changed" className={inputCls} />
          </label>
          <label className="block">
            <span className="font-mono text-2xs uppercase tracking-wider text-dimmer">entity_type contains</span>
            <input name="entity" defaultValue={sp.entity ?? ''} placeholder="jobs" className={inputCls} />
          </label>
          <div className="flex items-end gap-2">
            <button
              type="submit"
              className="border border-line bg-panel2 px-3 py-1 font-mono text-xs uppercase tracking-wider text-ink hover:border-blue-500/60"
            >
              Apply
            </button>
            <Link
              href="/audit"
              className="border border-line px-3 py-1 font-mono text-xs uppercase tracking-wider text-dim hover:text-ink"
            >
              Reset
            </Link>
          </div>
        </form>
      </Panel>

      <Panel title="Events" subtitle={`${rows.length} row(s) on this page`} source="audit_events">
        {rows.length === 0 && !error ? (
          <Empty what="audit events for these filters" />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>id</TH>
                <TH>time</TH>
                <TH>actor</TH>
                <TH>action</TH>
                <TH>entity</TH>
                <TH>entity id</TH>
                <TH>project</TH>
                <TH>data</TH>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="hover:bg-panel2">
                  <TD className="font-mono text-dimmer">{e.id}</TD>
                  <TD className="whitespace-nowrap font-mono">{fmtDateTime(e.created_at)}</TD>
                  <TD className="whitespace-nowrap">
                    <Badge value={e.actor_type} />
                    <span className="ml-2 font-mono">{e.actor_name ?? '—'}</span>
                  </TD>
                  <TD className="font-mono text-ink">{e.action}</TD>
                  <TD className="font-mono">{e.entity_type}</TD>
                  <TD className="font-mono text-dimmer">{shortId(e.entity_id, 12)}</TD>
                  <TD className="font-mono">
                    {e.project_id ? (
                      projectName.has(e.project_id) ? (
                        <Link href={`/projects/${e.project_id}`} className="underline decoration-line hover:text-ink">
                          {projectName.get(e.project_id)}
                        </Link>
                      ) : (
                        // audit_events.project_id is not a foreign key (migration 0008):
                        // history outlives the project it referred to.
                        <span className="text-dimmer" title={e.project_id}>
                          {shortId(e.project_id)} (deleted project)
                        </span>
                      )
                    ) : (
                      '—'
                    )}
                  </TD>
                  <TD>
                    <details>
                      <summary className="cursor-pointer font-mono text-2xs text-dimmer hover:text-ink">before/after</summary>
                      <div className="mt-1 space-y-1">
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border border-line bg-base px-2 py-1 font-mono text-2xs text-dim">
                          before: {pretty(e.before_data)}
                        </pre>
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border border-line bg-base px-2 py-1 font-mono text-2xs text-dim">
                          after: {pretty(e.after_data)}
                        </pre>
                        <pre className="whitespace-pre-wrap break-words border border-line bg-base px-2 py-1 font-mono text-2xs text-dimmer">
                          metadata: {pretty(e.metadata)}
                        </pre>
                      </div>
                    </details>
                  </TD>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        <div className="flex items-center justify-between border-t border-line px-3 py-2 font-mono text-xs">
          <span className="text-dimmer">
            rows {total === 0 ? 0 : from + 1}–{Math.min(from + PAGE_SIZE, total)} of {total}
          </span>
          <span className="flex items-center gap-2">
            {page > 1 ? (
              <Link href={buildQuery(sp, { page: String(page - 1) })} className="border border-line px-2 py-0.5 text-dim hover:text-ink">
                ← prev
              </Link>
            ) : (
              <span className="border border-line px-2 py-0.5 text-dimmer">← prev</span>
            )}
            <span className="text-dim">
              {page} / {lastPage}
            </span>
            {page < lastPage ? (
              <Link href={buildQuery(sp, { page: String(page + 1) })} className="border border-line px-2 py-0.5 text-dim hover:text-ink">
                next →
              </Link>
            ) : (
              <span className="border border-line px-2 py-0.5 text-dimmer">next →</span>
            )}
          </span>
        </div>
      </Panel>
    </div>
  );
}
