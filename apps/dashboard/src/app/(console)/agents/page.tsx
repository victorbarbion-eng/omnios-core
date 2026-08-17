import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { Badge, Empty, ErrorBox, Mono, PageHeader, Panel, TD, TH, Table } from '@/components/ui';
import { fmtDateTime, fmtRelative, shortId } from '@/lib/format';

export const dynamic = 'force-dynamic';

type Agent = {
  id: string;
  name: string;
  role: string;
  runtime_type: string;
  status: string;
  allowed_actions: string[] | null;
  allowed_project_scope: string[] | null;
  configuration_reference: string | null;
  last_seen_at: string | null;
};

type Job = {
  id: string;
  agent_id: string | null;
  job_type: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  queued_at: string;
  finished_at: string | null;
  error_summary: string | null;
};

export default async function AgentsPage() {
  const supabase = await createClient();

  const [agents, jobs] = await Promise.all([
    supabase
      .from('agents')
      .select(
        'id,name,role,runtime_type,status,allowed_actions,allowed_project_scope,configuration_reference,last_seen_at',
      )
      .order('name'),
    supabase
      .from('jobs')
      .select('id,agent_id,job_type,status,attempt_count,max_attempts,queued_at,finished_at,error_summary')
      .not('agent_id', 'is', null)
      .order('queued_at', { ascending: false })
      .limit(400),
  ]);

  const agentRows = (agents.data ?? []) as Agent[];
  const jobRows = (jobs.data ?? []) as Job[];

  const jobsByAgent = new Map<string, Job[]>();
  for (const j of jobRows) {
    if (!j.agent_id) continue;
    const list = jobsByAgent.get(j.agent_id);
    if (list) list.push(j);
    else jobsByAgent.set(j.agent_id, [j]);
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Agents" meta="Declared runtimes, their permitted action types, and what they last did." />

      <div className="space-y-2">
        <ErrorBox error={agents.error} context="agents" />
        <ErrorBox error={jobs.error} context="jobs" />
      </div>

      <Panel title="Agent register" subtitle={`${agentRows.length} row(s)`} source="agents">
        {agentRows.length === 0 && !agents.error ? (
          <Empty what="agents" />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>name</TH>
                <TH>role</TH>
                <TH>runtime</TH>
                <TH>status</TH>
                <TH>last seen</TH>
                <TH>allowed actions</TH>
                <TH>project scope</TH>
                <TH>config pointer</TH>
              </tr>
            </thead>
            <tbody>
              {agentRows.map((a) => {
                const actions = a.allowed_actions ?? [];
                const scope = a.allowed_project_scope ?? [];
                return (
                  <tr key={a.id} className="hover:bg-panel2">
                    <TD className="font-mono text-ink">{a.name}</TD>
                    <TD>{a.role}</TD>
                    <TD className="font-mono">{a.runtime_type}</TD>
                    <TD>
                      <Badge value={a.status} />
                    </TD>
                    <TD className="whitespace-nowrap">
                      <span className="font-mono text-ink">{fmtRelative(a.last_seen_at)}</span>
                      <div className="font-mono text-2xs text-dimmer">{a.last_seen_at ? fmtDateTime(a.last_seen_at) : '—'}</div>
                    </TD>
                    <TD>
                      {actions.length === 0 ? (
                        <span className="text-dimmer">none</span>
                      ) : (
                        <details>
                          <summary className="cursor-pointer font-mono text-ink hover:text-blue-200">
                            {actions.length} action type(s)
                          </summary>
                          <ul className="mt-1 space-y-0.5">
                            {actions.map((act) => (
                              <li key={act} className="font-mono text-2xs text-dim">
                                {act}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </TD>
                    <TD className="font-mono text-dimmer">
                      {scope.length === 0 ? 'all owned projects' : `${scope.length} project(s)`}
                    </TD>
                    <TD className="max-w-[16rem] break-all font-mono text-dimmer">
                      {a.configuration_reference ?? '—'}
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Panel>

      {agentRows.map((a) => {
        const agentJobs = jobsByAgent.get(a.id) ?? [];
        const errors = agentJobs.filter((j) => j.status === 'failed' || j.error_summary);
        return (
          <Panel
            key={a.id}
            title={`${a.name} — recent jobs`}
            subtitle={`${agentJobs.length} of the 400 most recent jobs`}
            source="jobs · agent_id"
            right={<Badge value={a.status} />}
          >
            {agentJobs.length === 0 ? (
              <Empty what={`jobs for ${a.name}`} />
            ) : (
              <>
                <Table>
                  <thead>
                    <tr>
                      <TH>job</TH>
                      <TH>type</TH>
                      <TH>status</TH>
                      <TH className="text-right">attempts</TH>
                      <TH>queued</TH>
                      <TH>finished</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {agentJobs.slice(0, 10).map((j) => (
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
                        <TD className="text-right font-mono">
                          {j.attempt_count}/{j.max_attempts}
                        </TD>
                        <TD className="whitespace-nowrap font-mono">{fmtDateTime(j.queued_at)}</TD>
                        <TD className="whitespace-nowrap font-mono">{j.finished_at ? fmtDateTime(j.finished_at) : '—'}</TD>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <div className="border-t border-line px-3 py-2">
                  <div className="font-mono text-2xs uppercase tracking-wider text-dimmer">errors</div>
                  {errors.length === 0 ? (
                    <div className="mt-1 text-xs text-dimmer">No failed jobs or error summaries for this agent.</div>
                  ) : (
                    <ul className="mt-1 space-y-1">
                      {errors.slice(0, 5).map((j) => (
                        <li key={j.id} className="border-l-2 border-red-500/60 pl-2">
                          <Mono className="text-2xs text-dimmer">
                            {fmtDateTime(j.finished_at ?? j.queued_at)} · {j.job_type} · {shortId(j.id)}
                          </Mono>
                          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-red-300">
                            {j.error_summary ?? 'failed with no error_summary recorded'}
                          </pre>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </Panel>
        );
      })}
    </div>
  );
}
