import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { Badge, Empty, ErrorBox, PageHeader, Panel, TD, TH, Table } from '@/components/ui';
import { fmtDateTime, fmtDuration, shortId } from '@/lib/format';

export const dynamic = 'force-dynamic';

type JobActivity = {
  id: string;
  project_id: string;
  project_name: string;
  job_type: string;
  risk_level: string;
  auto_allowed: boolean;
  status: string;
  attempt_count: number;
  max_attempts: number;
  agent_name: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_seconds: number | null;
  output_artifact_id: string | null;
  error_summary: string | null;
};

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const supabase = await createClient();

  let query = supabase.from('v_job_activity').select('*').limit(300);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  const rows = (data ?? []) as JobActivity[];
  const failed = rows.filter((j) => j.status === 'failed');

  const filters = ['', 'queued', 'claimed', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Jobs"
        meta={`${rows.length} row(s) from v_job_activity${status ? ` filtered to status=${status}` : ''} · 300 most recent.`}
        right={
          <div className="flex flex-wrap gap-1">
            {filters.map((f) => {
              const active = (status ?? '') === f;
              return (
                <Link
                  key={f || 'all'}
                  href={f ? `/jobs?status=${f}` : '/jobs'}
                  className={`border px-2 py-0.5 font-mono text-2xs uppercase tracking-wider ${
                    active ? 'border-blue-500/60 bg-blue-500/10 text-blue-200' : 'border-line text-dim hover:text-ink'
                  }`}
                >
                  {f || 'all'}
                </Link>
              );
            })}
          </div>
        }
      />

      <ErrorBox error={error} context="v_job_activity" />

      {failed.length > 0 ? (
        <Panel title="Failed jobs" subtitle={`${failed.length} failure(s) in this window`} source="v_job_activity · failed">
          <ul className="divide-y divide-line">
            {failed.slice(0, 10).map((j) => (
              <li key={j.id} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
                  <Link href={`/jobs/${j.id}`} className="text-ink underline decoration-line hover:decoration-blue-400">
                    {shortId(j.id)}
                  </Link>
                  <span className="text-ink">{j.job_type}</span>
                  <Badge value={j.risk_level} kind="risk" />
                  <span className="text-dimmer">{j.project_name}</span>
                  <span className="text-dimmer">
                    attempt {j.attempt_count}/{j.max_attempts}
                  </span>
                  <span className="text-dimmer">{fmtDateTime(j.finished_at ?? j.queued_at)}</span>
                </div>
                <pre className="mt-1 whitespace-pre-wrap break-words border border-red-500/40 bg-red-500/10 px-2 py-1 font-mono text-xs text-red-200">
                  {j.error_summary ?? 'failed with no error_summary recorded'}
                </pre>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title="Job activity" subtitle={`${rows.length} row(s)`} source="v_job_activity">
        {rows.length === 0 && !error ? (
          <Empty what="jobs" />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>job</TH>
                <TH>status</TH>
                <TH>job_type</TH>
                <TH>risk</TH>
                <TH>auto</TH>
                <TH>agent</TH>
                <TH>project</TH>
                <TH className="text-right">attempts</TH>
                <TH>duration</TH>
                <TH>output artifact</TH>
                <TH>error_summary</TH>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => (
                <tr key={j.id} className={`hover:bg-panel2 ${j.status === 'failed' ? 'bg-red-500/[0.04]' : ''}`}>
                  <TD>
                    <Link href={`/jobs/${j.id}`} className="font-mono text-ink underline decoration-line hover:decoration-blue-400">
                      {shortId(j.id)}
                    </Link>
                  </TD>
                  <TD>
                    <Badge value={j.status} />
                  </TD>
                  <TD className="font-mono text-ink">{j.job_type}</TD>
                  <TD>
                    <Badge value={j.risk_level} kind="risk" />
                  </TD>
                  <TD className="font-mono text-dimmer">{j.auto_allowed ? 'auto' : 'needs approval'}</TD>
                  <TD className="font-mono">{j.agent_name ?? '—'}</TD>
                  <TD className="font-mono">
                    <Link href={`/projects/${j.project_id}`} className="underline decoration-line hover:text-ink">
                      {j.project_name}
                    </Link>
                  </TD>
                  <TD
                    className={`text-right font-mono ${
                      j.attempt_count >= j.max_attempts ? 'text-amber-300' : ''
                    }`}
                  >
                    {j.attempt_count}/{j.max_attempts}
                  </TD>
                  <TD className="whitespace-nowrap font-mono">{fmtDuration(j.duration_seconds)}</TD>
                  <TD className="font-mono text-dimmer">
                    {j.output_artifact_id ? (
                      <Link
                        href={`/projects/${j.project_id}`}
                        title={j.output_artifact_id}
                        className="underline decoration-line hover:text-ink"
                      >
                        {shortId(j.output_artifact_id)}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TD>
                  <TD className={j.error_summary ? 'max-w-[24rem] text-red-300' : 'text-dimmer'}>
                    {j.error_summary ?? '—'}
                  </TD>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </div>
  );
}
