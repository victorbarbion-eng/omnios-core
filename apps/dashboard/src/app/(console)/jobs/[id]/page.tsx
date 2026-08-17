import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { Badge, Empty, ErrorBox, Mono, PageHeader, Panel, TD, TH, Table } from '@/components/ui';
import { fmtDateTime, fmtDuration, fmtRelative, pretty, shortId } from '@/lib/format';

export const dynamic = 'force-dynamic';

type Job = {
  id: string;
  project_id: string;
  task_id: string | null;
  agent_id: string | null;
  job_type: string;
  input_reference: unknown;
  status: string;
  attempt_count: number;
  max_attempts: number;
  queued_at: string;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  output_artifact_id: string | null;
  error_summary: string | null;
  idempotency_key: string;
};

type LogRow = {
  id: number;
  level: string;
  step: string | null;
  message: string;
  data: unknown;
  created_at: string;
};

type Approval = {
  id: string;
  action_type: string;
  status: string;
  risk_level: string;
  decided_at: string | null;
  decision_note: string | null;
  requested_at: string;
};

const LEVEL_CLASSES: Record<string, string> = {
  debug: 'text-dimmer border-line',
  info: 'text-dim border-line',
  warn: 'text-amber-300 border-amber-500/50',
  error: 'text-red-300 border-red-500/50',
};

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [job, logs, approvals, policy] = await Promise.all([
    supabase.from('jobs').select('*').eq('id', id).maybeSingle(),
    supabase
      .from('job_logs')
      .select('id,level,step,message,data,created_at')
      .eq('job_id', id)
      .order('created_at', { ascending: true })
      .limit(500),
    supabase
      .from('approvals')
      .select('id,action_type,status,risk_level,decided_at,decision_note,requested_at')
      .eq('job_id', id)
      .order('requested_at', { ascending: false }),
    supabase.from('action_policies').select('action_type,risk_level,auto_allowed,description'),
  ]);

  const j = job.data as Job | null;
  const logRows = (logs.data ?? []) as LogRow[];
  const approvalRows = (approvals.data ?? []) as Approval[];
  const pol = ((policy.data ?? []) as { action_type: string; risk_level: string; auto_allowed: boolean; description: string }[]).find(
    (p) => p.action_type === j?.job_type,
  );

  const durationSeconds = j
    ? Math.round(
        ((j.finished_at ? new Date(j.finished_at).getTime() : Date.now()) -
          new Date(j.started_at ?? j.queued_at).getTime()) /
          1000,
      )
    : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title={j ? `Job ${shortId(j.id, 12)}` : 'Job not found'}
        meta={
          j ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <Badge value={j.status} />
              <Mono className="text-ink">{j.job_type}</Mono>
              {pol ? <Badge value={pol.risk_level} kind="risk" /> : null}
              {pol ? <span className="text-dimmer">{pol.auto_allowed ? 'auto_allowed' : 'needs approval'}</span> : null}
              <span>
                attempts <Mono className="text-ink">{j.attempt_count}/{j.max_attempts}</Mono>
              </span>
              <span>
                duration <Mono className="text-ink">{fmtDuration(durationSeconds)}</Mono>
              </span>
              <span>
                id <Mono className="text-dimmer">{j.id}</Mono>
              </span>
            </div>
          ) : (
            <>
              No job with id <Mono>{id}</Mono> is visible to your account.
            </>
          )
        }
        right={
          <Link href="/jobs" className="font-mono text-xs text-dim underline hover:text-ink">
            ← all jobs
          </Link>
        }
      />

      <div className="space-y-2">
        <ErrorBox error={job.error} context="jobs" />
        <ErrorBox error={logs.error} context="job_logs" />
        <ErrorBox error={approvals.error} context="approvals" />
        <ErrorBox error={policy.error} context="action_policies" />
      </div>

      {j?.error_summary ? (
        <div className="border border-red-500/50 bg-red-500/10 px-3 py-2">
          <div className="font-mono text-2xs uppercase tracking-wider text-red-300">jobs.error_summary</div>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-red-200">{j.error_summary}</pre>
        </div>
      ) : null}

      {j ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Job record" source="jobs">
            <Table>
              <tbody>
                <tr>
                  <TD className="w-40 font-mono text-dimmer">project_id</TD>
                  <TD className="font-mono">
                    <Link href={`/projects/${j.project_id}`} className="text-ink underline decoration-line hover:decoration-blue-400">
                      {j.project_id}
                    </Link>
                  </TD>
                </tr>
                <tr>
                  <TD className="font-mono text-dimmer">task_id</TD>
                  <TD className="font-mono">{j.task_id ?? '—'}</TD>
                </tr>
                <tr>
                  <TD className="font-mono text-dimmer">agent_id</TD>
                  <TD className="font-mono">{j.agent_id ?? '—'}</TD>
                </tr>
                <tr>
                  <TD className="font-mono text-dimmer">queued_at</TD>
                  <TD className="font-mono">
                    {fmtDateTime(j.queued_at)} <span className="text-dimmer">({fmtRelative(j.queued_at)})</span>
                  </TD>
                </tr>
                <tr>
                  <TD className="font-mono text-dimmer">claimed_at</TD>
                  <TD className="font-mono">{j.claimed_at ? fmtDateTime(j.claimed_at) : '—'}</TD>
                </tr>
                <tr>
                  <TD className="font-mono text-dimmer">started_at</TD>
                  <TD className="font-mono">{j.started_at ? fmtDateTime(j.started_at) : '—'}</TD>
                </tr>
                <tr>
                  <TD className="font-mono text-dimmer">finished_at</TD>
                  <TD className="font-mono">{j.finished_at ? fmtDateTime(j.finished_at) : '—'}</TD>
                </tr>
                <tr>
                  <TD className="font-mono text-dimmer">output_artifact_id</TD>
                  <TD className="font-mono">{j.output_artifact_id ?? '—'}</TD>
                </tr>
                <tr>
                  <TD className="font-mono text-dimmer">idempotency_key</TD>
                  <TD className="break-all font-mono">{j.idempotency_key}</TD>
                </tr>
              </tbody>
            </Table>
          </Panel>

          <Panel title="input_reference" source="jobs.input_reference">
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs text-dim">
              {pretty(j.input_reference)}
            </pre>
          </Panel>
        </div>
      ) : null}

      <Panel title="Approvals for this job" subtitle={`${approvalRows.length} row(s)`} source="approvals · job_id">
        {approvalRows.length === 0 ? (
          <Empty what="approval requests for this job" />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>action</TH>
                <TH>risk</TH>
                <TH>status</TH>
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
                  <TD className="whitespace-nowrap font-mono">{fmtDateTime(a.requested_at)}</TD>
                  <TD className="whitespace-nowrap font-mono">{a.decided_at ? fmtDateTime(a.decided_at) : '—'}</TD>
                  <TD>{a.decision_note ?? '—'}</TD>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Panel title="job_logs timeline" subtitle={`${logRows.length} line(s), oldest first`} source="job_logs">
        {logRows.length === 0 ? (
          <Empty what="log lines for this job" />
        ) : (
          <ol className="divide-y divide-line/60">
            {logRows.map((l) => (
              <li key={l.id} className="flex gap-3 px-3 py-1.5">
                <span className="w-44 shrink-0 font-mono text-2xs text-dimmer">{fmtDateTime(l.created_at)}</span>
                <span
                  className={`h-fit w-14 shrink-0 border px-1 text-center font-mono text-2xs uppercase ${
                    LEVEL_CLASSES[l.level] ?? 'border-line text-dim'
                  }`}
                >
                  {l.level}
                </span>
                <span className="w-40 shrink-0 font-mono text-2xs text-dim">{l.step ?? '—'}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-xs text-ink">{l.message}</div>
                  {l.data && JSON.stringify(l.data) !== '{}' ? (
                    <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs text-dimmer">
                      {pretty(l.data)}
                    </pre>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}
