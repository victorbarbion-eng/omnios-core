import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { Badge, Empty, ErrorBox, Mono, PageHeader, Panel, TD, TH, Table } from '@/components/ui';
import { fmtDateTime, fmtDuration, fmtRelative, priorityClasses, shortId } from '@/lib/format';

export const dynamic = 'force-dynamic';

type Project = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  priority: string;
  tags: string[] | null;
  canonical_location: string | null;
  location_kind: string;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type Task = {
  id: string;
  title: string;
  status: string;
  priority: string;
  assigned_agent_id: string | null;
  parent_task_id: string | null;
  due_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

type Artifact = {
  id: string;
  name: string;
  artifact_type: string;
  location_kind: string;
  local_path: string | null;
  external_url: string | null;
  storage_path: string | null;
  version: number;
  created_by: string;
  created_at: string;
};

type Evidence = {
  id: string;
  title: string;
  source_url: string | null;
  publisher: string | null;
  verification: string;
  confidence: number | null;
  captured_at: string;
  source_published_at: string | null;
};

type Job = {
  id: string;
  job_type: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  agent_id: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_summary: string | null;
  output_artifact_id: string | null;
};

type Approval = {
  id: string;
  action_type: string;
  risk_level: string;
  status: string;
  target_reference: string;
  decided_at: string | null;
  decision_note: string | null;
  requested_at: string;
};

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [project, tasks, artifacts, evidence, jobs, approvals, agents] = await Promise.all([
    supabase.from('projects').select('*').eq('id', id).maybeSingle(),
    supabase
      .from('tasks')
      .select('id,title,status,priority,assigned_agent_id,parent_task_id,due_at,completed_at,updated_at')
      .eq('project_id', id)
      .order('updated_at', { ascending: false }),
    supabase
      .from('artifacts')
      .select('id,name,artifact_type,location_kind,local_path,external_url,storage_path,version,created_by,created_at')
      .eq('project_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('evidence')
      .select('id,title,source_url,publisher,verification,confidence,captured_at,source_published_at')
      .eq('project_id', id)
      .order('captured_at', { ascending: false }),
    supabase
      .from('jobs')
      .select(
        'id,job_type,status,attempt_count,max_attempts,agent_id,queued_at,started_at,finished_at,error_summary,output_artifact_id',
      )
      .eq('project_id', id)
      .order('queued_at', { ascending: false }),
    supabase
      .from('approvals')
      .select('id,action_type,risk_level,status,target_reference,decided_at,decision_note,requested_at')
      .eq('project_id', id)
      .not('decided_at', 'is', null)
      .order('decided_at', { ascending: false })
      .limit(20),
    supabase.from('agents').select('id,name'),
  ]);

  const p = project.data as Project | null;
  const agentName = new Map<string, string>(
    ((agents.data ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]),
  );

  const taskRows = (tasks.data ?? []) as Task[];
  const artifactRows = (artifacts.data ?? []) as Artifact[];
  const evidenceRows = (evidence.data ?? []) as Evidence[];
  const jobRows = (jobs.data ?? []) as Job[];
  const approvalRows = (approvals.data ?? []) as Approval[];

  return (
    <div className="space-y-4">
      <PageHeader
        title={p?.name ?? 'Project not found'}
        meta={
          p ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>
                <Badge value={p.status} /> <span className={`ml-1 font-mono ${priorityClasses(p.priority)}`}>{p.priority}</span>
              </span>
              <span>
                slug <Mono className="text-ink">{p.slug}</Mono>
              </span>
              <span>
                id <Mono className="text-dimmer">{p.id}</Mono>
              </span>
              <span>
                location <Mono className="text-ink">{p.canonical_location ?? '—'}</Mono>{' '}
                <span className="text-dimmer">({p.location_kind})</span>
              </span>
              <span>tags <Mono>{(p.tags ?? []).join(' ') || '—'}</Mono></span>
              <span>created {fmtDateTime(p.created_at)}</span>
              <span>updated {fmtRelative(p.updated_at)}</span>
              {p.archived_at ? <span className="text-dimmer">archived {fmtDateTime(p.archived_at)}</span> : null}
            </div>
          ) : (
            <>
              No project with id <Mono>{id}</Mono> is visible to your account.
            </>
          )
        }
        right={
          <Link href="/projects" className="font-mono text-xs text-dim underline hover:text-ink">
            ← all projects
          </Link>
        }
      />

      <div className="space-y-2">
        <ErrorBox error={project.error} context="projects" />
        <ErrorBox error={tasks.error} context="tasks" />
        <ErrorBox error={artifacts.error} context="artifacts" />
        <ErrorBox error={evidence.error} context="evidence" />
        <ErrorBox error={jobs.error} context="jobs" />
        <ErrorBox error={approvals.error} context="approvals" />
        <ErrorBox error={agents.error} context="agents" />
      </div>

      {p?.description ? (
        <Panel title="Description" source="projects.description">
          <p className="px-3 py-2 text-sm text-dim">{p.description}</p>
        </Panel>
      ) : null}

      <Panel title="Tasks" subtitle={`${taskRows.length} row(s)`} source="tasks">
        {taskRows.length === 0 ? (
          <Empty what="tasks" />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>title</TH>
                <TH>status</TH>
                <TH>priority</TH>
                <TH>agent</TH>
                <TH>parent</TH>
                <TH>due</TH>
                <TH>completed</TH>
              </tr>
            </thead>
            <tbody>
              {taskRows.map((t) => (
                <tr key={t.id} className="hover:bg-panel2">
                  <TD className="text-ink">{t.title}</TD>
                  <TD>
                    <Badge value={t.status} />
                  </TD>
                  <TD className={`font-mono ${priorityClasses(t.priority)}`}>{t.priority}</TD>
                  <TD className="font-mono">{t.assigned_agent_id ? (agentName.get(t.assigned_agent_id) ?? shortId(t.assigned_agent_id)) : '—'}</TD>
                  <TD className="font-mono text-dimmer">{shortId(t.parent_task_id)}</TD>
                  <TD className="whitespace-nowrap font-mono">{t.due_at ? fmtDateTime(t.due_at) : '—'}</TD>
                  <TD className="whitespace-nowrap font-mono">{t.completed_at ? fmtDateTime(t.completed_at) : '—'}</TD>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Panel title="Artifacts" subtitle={`${artifactRows.length} row(s)`} source="artifacts">
        {artifactRows.length === 0 ? (
          <Empty what="artifacts" />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>name</TH>
                <TH>type</TH>
                <TH>where</TH>
                <TH>pointer</TH>
                <TH className="text-right">v</TH>
                <TH>created by</TH>
                <TH>created</TH>
              </tr>
            </thead>
            <tbody>
              {artifactRows.map((a) => {
                const pointer = a.local_path ?? a.external_url ?? a.storage_path ?? 'inline';
                return (
                  <tr key={a.id} className="hover:bg-panel2">
                    <TD className="text-ink">{a.name}</TD>
                    <TD className="font-mono">{a.artifact_type}</TD>
                    <TD className="font-mono text-dimmer">{a.location_kind}</TD>
                    <TD className="max-w-[26rem] break-all font-mono text-dimmer">
                      {a.external_url ? (
                        <a href={a.external_url} target="_blank" rel="noreferrer" className="underline hover:text-ink">
                          {a.external_url}
                        </a>
                      ) : (
                        pointer
                      )}
                    </TD>
                    <TD className="text-right font-mono">{a.version}</TD>
                    <TD className="font-mono">{a.created_by}</TD>
                    <TD className="whitespace-nowrap font-mono">{fmtDateTime(a.created_at)}</TD>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Panel>

      <Panel title="Evidence" subtitle={`${evidenceRows.length} row(s)`} source="evidence">
        {evidenceRows.length === 0 ? (
          <Empty what="evidence" />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>title</TH>
                <TH>publisher</TH>
                <TH>source</TH>
                <TH>verification</TH>
                <TH className="text-right">confidence</TH>
                <TH>published</TH>
                <TH>captured</TH>
              </tr>
            </thead>
            <tbody>
              {evidenceRows.map((e) => (
                <tr key={e.id} className="hover:bg-panel2">
                  <TD className="text-ink">{e.title}</TD>
                  <TD className="font-mono">{e.publisher ?? '—'}</TD>
                  <TD className="max-w-[22rem] break-all font-mono text-dimmer">
                    {e.source_url ? (
                      <a href={e.source_url} target="_blank" rel="noreferrer" className="underline hover:text-ink">
                        {e.source_url}
                      </a>
                    ) : (
                      '—'
                    )}
                  </TD>
                  <TD>
                    <Badge value={e.verification} />
                  </TD>
                  <TD className="text-right font-mono">{e.confidence ?? '—'}</TD>
                  <TD className="whitespace-nowrap font-mono">{e.source_published_at ?? '—'}</TD>
                  <TD className="whitespace-nowrap font-mono">{fmtDateTime(e.captured_at)}</TD>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Panel title="Jobs" subtitle={`${jobRows.length} row(s)`} source="jobs">
        {jobRows.length === 0 ? (
          <Empty what="jobs" />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>job</TH>
                <TH>type</TH>
                <TH>status</TH>
                <TH>agent</TH>
                <TH className="text-right">attempts</TH>
                <TH>duration</TH>
                <TH>error</TH>
              </tr>
            </thead>
            <tbody>
              {jobRows.map((j) => {
                const end = j.finished_at ? new Date(j.finished_at).getTime() : Date.now();
                const start = new Date(j.started_at ?? j.queued_at).getTime();
                return (
                  <tr key={j.id} className="hover:bg-panel2">
                    <TD>
                      <Link href={`/jobs/${j.id}`} className="font-mono text-ink underline decoration-line hover:decoration-blue-400">
                        {shortId(j.id)}
                      </Link>
                    </TD>
                    <TD className="font-mono">{j.job_type}</TD>
                    <TD>
                      <Badge value={j.status} />
                    </TD>
                    <TD className="font-mono">{j.agent_id ? (agentName.get(j.agent_id) ?? shortId(j.agent_id)) : '—'}</TD>
                    <TD className="text-right font-mono">
                      {j.attempt_count}/{j.max_attempts}
                    </TD>
                    <TD className="whitespace-nowrap font-mono">{fmtDuration(Math.round((end - start) / 1000))}</TD>
                    <TD className={j.error_summary ? 'text-red-300' : 'text-dimmer'}>{j.error_summary ?? '—'}</TD>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Panel>

      <Panel title="Recent approval decisions" subtitle={`${approvalRows.length} row(s)`} source="approvals · decided_at not null">
        {approvalRows.length === 0 ? (
          <Empty what="decided approvals" />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>action</TH>
                <TH>risk</TH>
                <TH>status</TH>
                <TH>target</TH>
                <TH>requested</TH>
                <TH>decided</TH>
                <TH>note</TH>
              </tr>
            </thead>
            <tbody>
              {approvalRows.map((a) => (
                <tr key={a.id} className="hover:bg-panel2">
                  <TD className="font-mono text-ink">{a.action_type}</TD>
                  <TD>
                    <Badge value={a.risk_level} kind="risk" />
                  </TD>
                  <TD>
                    <Badge value={a.status} />
                  </TD>
                  <TD className="max-w-[20rem] break-all font-mono text-dimmer">{a.target_reference}</TD>
                  <TD className="whitespace-nowrap font-mono">{fmtDateTime(a.requested_at)}</TD>
                  <TD className="whitespace-nowrap font-mono">{fmtDateTime(a.decided_at)}</TD>
                  <TD>{a.decision_note ?? '—'}</TD>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </div>
  );
}
