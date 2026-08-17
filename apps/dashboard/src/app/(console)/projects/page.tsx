import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { Badge, Empty, ErrorBox, PageHeader, Panel, TD, TH, Table } from '@/components/ui';
import { fmtRelative, priorityClasses } from '@/lib/format';

export const dynamic = 'force-dynamic';

type ProjectSummary = {
  id: string;
  name: string;
  slug: string;
  status: string;
  priority: string;
  tags: string[] | null;
  is_demo: boolean;
  updated_at: string;
  open_tasks: number;
  done_tasks: number;
  artifact_count: number;
  evidence_count: number;
  active_jobs: number;
  failed_jobs: number;
  pending_approvals: number;
};

export default async function ProjectsPage() {
  const supabase = await createClient();
  const { data, error } = await supabase.from('v_project_summary').select('*').order('updated_at', { ascending: false });

  const rows = (data ?? []) as ProjectSummary[];

  return (
    <div className="space-y-4">
      <PageHeader title="Projects" meta="Non-archived projects and their live counts." />
      <ErrorBox error={error} context="v_project_summary" />

      <Panel title="Project summary" subtitle={`${rows.length} row(s)`} source="v_project_summary">
        {rows.length === 0 && !error ? (
          <Empty what="projects" />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>name</TH>
                <TH>slug</TH>
                <TH>status</TH>
                <TH>priority</TH>
                <TH className="text-right">open</TH>
                <TH className="text-right">done</TH>
                <TH className="text-right">artifacts</TH>
                <TH className="text-right">evidence</TH>
                <TH className="text-right">active jobs</TH>
                <TH className="text-right">failed</TH>
                <TH className="text-right">pending appr.</TH>
                <TH>tags</TH>
                <TH>updated</TH>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="hover:bg-panel2">
                  <TD>
                    <Link href={`/projects/${p.id}`} className="font-mono text-ink underline decoration-line hover:decoration-blue-400">
                      {p.name}
                    </Link>
                    {p.is_demo ? <span className="ml-2 font-mono text-2xs text-dimmer">demo</span> : null}
                  </TD>
                  <TD className="font-mono text-dimmer">{p.slug}</TD>
                  <TD>
                    <Badge value={p.status} />
                  </TD>
                  <TD className={`font-mono ${priorityClasses(p.priority)}`}>{p.priority}</TD>
                  <TD className="text-right font-mono text-ink">{p.open_tasks}</TD>
                  <TD className="text-right font-mono">{p.done_tasks}</TD>
                  <TD className="text-right font-mono">{p.artifact_count}</TD>
                  <TD className="text-right font-mono">{p.evidence_count}</TD>
                  <TD className={`text-right font-mono ${p.active_jobs > 0 ? 'text-blue-300' : ''}`}>{p.active_jobs}</TD>
                  <TD className={`text-right font-mono ${p.failed_jobs > 0 ? 'text-red-300' : ''}`}>{p.failed_jobs}</TD>
                  <TD className={`text-right font-mono ${p.pending_approvals > 0 ? 'text-amber-300' : ''}`}>
                    {p.pending_approvals}
                  </TD>
                  <TD className="font-mono text-dimmer">{(p.tags ?? []).join(' ') || '—'}</TD>
                  <TD className="whitespace-nowrap">{fmtRelative(p.updated_at)}</TD>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </div>
  );
}
