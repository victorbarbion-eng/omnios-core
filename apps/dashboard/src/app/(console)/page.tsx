import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { Badge, Empty, ErrorBox, Mono, PageHeader, Panel, Stat, TD, TH, Table } from '@/components/ui';
import { fmtDateTime, fmtRelative, shortId } from '@/lib/format';

export const dynamic = 'force-dynamic';

const TASK_STATUSES = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'awaiting_approval',
  'done',
  'cancelled',
] as const;

type TaskRow = { status: string };
type AuditRow = {
  id: number;
  created_at: string;
  actor_type: string;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  project_id: string | null;
};
type SettingRow = { key: string; value: unknown; updated_at: string; updated_by: string | null };

export default async function OverviewPage() {
  const supabase = await createClient();

  const [projects, tasks, activeJobs, failedJobs, awaitingJobs, approvals, settings, audit] = await Promise.all([
    supabase.from('projects').select('id', { count: 'exact', head: true }).is('archived_at', null),
    supabase.from('tasks').select('status'),
    supabase.from('jobs').select('id', { count: 'exact', head: true }).in('status', ['queued', 'claimed', 'running']),
    supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
    supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('status', 'awaiting_approval'),
    supabase.from('approvals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('system_settings').select('key,value,updated_at,updated_by'),
    supabase
      .from('audit_events')
      .select('id,created_at,actor_type,actor_name,action,entity_type,entity_id,project_id')
      .order('created_at', { ascending: false })
      .limit(15),
  ]);

  const taskRows = (tasks.data ?? []) as TaskRow[];
  const taskCounts = new Map<string, number>();
  for (const t of taskRows) taskCounts.set(t.status, (taskCounts.get(t.status) ?? 0) + 1);

  const settingRows = (settings.data ?? []) as SettingRow[];
  const getSetting = (key: string) => settingRows.find((s) => s.key === key);
  const pauseSetting = getSetting('emergency_pause');
  const autonomySetting = getSetting('autonomy_level');
  const paused = pauseSetting?.value === true || pauseSetting?.value === 'true';
  const autonomy =
    typeof autonomySetting?.value === 'string' ? autonomySetting.value : JSON.stringify(autonomySetting?.value ?? null);

  const auditRows = (audit.data ?? []) as AuditRow[];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Overview"
        meta={
          <>
            Everything below is a live count against a single table. Generated{' '}
            <Mono>{fmtDateTime(new Date().toISOString())}</Mono>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="projects" value={projects.count ?? '—'} source="projects" />
        <Stat label="active jobs" value={activeJobs.count ?? '—'} source="jobs · queued+claimed+running" tone="blue" />
        <Stat label="failed jobs" value={failedJobs.count ?? '—'} source="jobs · failed" tone="red" />
        <Stat
          label="jobs awaiting approval"
          value={awaitingJobs.count ?? '—'}
          source="jobs · awaiting_approval"
          tone="amber"
        />
        <Stat label="pending approvals" value={approvals.count ?? '—'} source="approvals · pending" tone="amber" />
        <Stat label="tasks" value={taskRows.length} source="tasks" />
      </div>

      <div className="space-y-2">
        <ErrorBox error={projects.error} context="projects count" />
        <ErrorBox error={tasks.error} context="tasks" />
        <ErrorBox error={activeJobs.error} context="active jobs count" />
        <ErrorBox error={failedJobs.error} context="failed jobs count" />
        <ErrorBox error={awaitingJobs.error} context="awaiting-approval jobs count" />
        <ErrorBox error={approvals.error} context="pending approvals count" />
        <ErrorBox error={settings.error} context="system_settings" />
        <ErrorBox error={audit.error} context="audit_events" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Tasks by status" source="tasks.status">
          {taskRows.length === 0 ? (
            <Empty what="tasks" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <TH>status</TH>
                  <TH className="text-right">count</TH>
                </tr>
              </thead>
              <tbody>
                {TASK_STATUSES.map((s) => (
                  <tr key={s}>
                    <TD>
                      <Badge value={s} />
                    </TD>
                    <TD className="text-right font-mono text-ink">{taskCounts.get(s) ?? 0}</TD>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel title="System state" source="system_settings">
          <Table>
            <thead>
              <tr>
                <TH>key</TH>
                <TH>value</TH>
                <TH>updated</TH>
              </tr>
            </thead>
            <tbody>
              <tr>
                <TD className="font-mono text-ink">autonomy_level</TD>
                <TD>
                  <Mono className="text-ink">{autonomy ?? '—'}</Mono>
                </TD>
                <TD>{pauseSetting ? fmtRelative(autonomySetting?.updated_at) : '—'}</TD>
              </tr>
              <tr>
                <TD className="font-mono text-ink">emergency_pause</TD>
                <TD>
                  <Badge value={paused ? 'failed' : 'completed'} />
                  <span className="ml-2 font-mono text-xs">
                    {paused ? 'ENGAGED — only risk_level=read jobs may start' : 'released'}
                  </span>
                </TD>
                <TD>
                  {fmtRelative(pauseSetting?.updated_at)}
                  {pauseSetting?.updated_by ? <span className="text-dimmer"> by {pauseSetting.updated_by}</span> : null}
                </TD>
              </tr>
            </tbody>
          </Table>
          {settingRows.length === 0 && !settings.error ? <Empty what="system settings" /> : null}
          <div className="border-t border-line px-3 py-2 text-2xs text-dimmer">
            Change the pause on <Link href="/policy" className="underline hover:text-dim">/policy</Link>.
          </div>
        </Panel>
      </div>

      <Panel title="Recent audit events" subtitle="15 most recent" source="audit_events">
        {auditRows.length === 0 ? (
          <Empty what="audit events" />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>time</TH>
                <TH>actor</TH>
                <TH>action</TH>
                <TH>entity</TH>
                <TH>entity id</TH>
              </tr>
            </thead>
            <tbody>
              {auditRows.map((e) => (
                <tr key={e.id} className="hover:bg-panel2">
                  <TD className="whitespace-nowrap font-mono">{fmtDateTime(e.created_at)}</TD>
                  <TD>
                    <Badge value={e.actor_type} />
                    <span className="ml-2 font-mono">{e.actor_name ?? e.actor_type}</span>
                  </TD>
                  <TD className="font-mono text-ink">{e.action}</TD>
                  <TD className="font-mono">{e.entity_type}</TD>
                  <TD className="font-mono text-dimmer">{shortId(e.entity_id, 12)}</TD>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <div className="border-t border-line px-3 py-2 text-2xs text-dimmer">
          Full filterable history: <Link href="/audit" className="underline hover:text-dim">/audit</Link>
        </div>
      </Panel>
    </div>
  );
}
