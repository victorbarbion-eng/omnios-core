import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import ApprovalDecision from '@/components/ApprovalDecision';
import { Badge, Empty, ErrorBox, Mono, PageHeader, Panel } from '@/components/ui';
import { fmtDateTime, fmtRelative, isPast, pretty } from '@/lib/format';
import { decideApproval } from './actions';

export const dynamic = 'force-dynamic';

type PendingApproval = {
  id: string;
  project_id: string;
  action_type: string;
  action_preview: string;
  action_payload: unknown;
  target_reference: string;
  risk_level: string;
  requested_at: string;
  expires_at: string;
  job_id: string | null;
  requested_by_agent_id: string | null;
};

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; error_id?: string }>;
}) {
  const { error: actionError, error_id: errorId } = await searchParams;
  const supabase = await createClient();

  const [approvals, agents, projects] = await Promise.all([
    supabase
      .from('approvals')
      .select(
        'id,project_id,action_type,action_preview,action_payload,target_reference,risk_level,requested_at,expires_at,job_id,requested_by_agent_id',
      )
      .eq('status', 'pending')
      .order('requested_at', { ascending: false }),
    supabase.from('agents').select('id,name'),
    supabase.from('projects').select('id,name'),
  ]);

  const rows = (approvals.data ?? []) as PendingApproval[];
  const agentName = new Map<string, string>(
    ((agents.data ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]),
  );
  const projectName = new Map<string, string>(
    ((projects.data ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]),
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Approvals"
        meta={`${rows.length} pending request(s). A decision writes only approvals.status and approvals.decision_note; database triggers enforce every rule.`}
      />

      {actionError ? (
        <div className="border border-red-500/50 bg-red-500/10 px-3 py-2">
          <div className="font-mono text-2xs uppercase tracking-wider text-red-300">
            decision rejected by the database{errorId ? ` — approval ${errorId}` : ''}
          </div>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-red-200">{actionError}</pre>
        </div>
      ) : null}

      <div className="space-y-2">
        <ErrorBox error={approvals.error} context="approvals · pending" />
        <ErrorBox error={agents.error} context="agents" />
        <ErrorBox error={projects.error} context="projects" />
      </div>

      {rows.length === 0 && !approvals.error ? (
        <Panel title="Pending queue" source="approvals · status=pending">
          <Empty what="pending approval requests" />
        </Panel>
      ) : null}

      <div className="space-y-4">
        {rows.map((a) => {
          const expired = isPast(a.expires_at);
          return (
            <article
              key={a.id}
              className={`border bg-panel ${expired ? 'border-red-500/50' : 'border-amber-500/40'}`}
            >
              <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Mono className="text-sm text-ink">{a.action_type}</Mono>
                  <Badge value={a.risk_level} kind="risk" />
                  <Badge value="pending" />
                  {expired ? (
                    <span className="border border-red-500/50 bg-red-500/10 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wide text-red-300">
                      past expiry — database will refuse this decision
                    </span>
                  ) : null}
                </div>
                <Mono className="text-2xs text-dimmer">approvals.id {a.id}</Mono>
              </header>

              <dl className="grid grid-cols-1 gap-x-6 gap-y-1 px-3 py-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <dt className="font-mono text-2xs uppercase tracking-wider text-dimmer">target_reference</dt>
                  <dd className="break-all font-mono text-ink">{a.target_reference}</dd>
                </div>
                <div>
                  <dt className="font-mono text-2xs uppercase tracking-wider text-dimmer">requested by</dt>
                  <dd className="font-mono text-ink">
                    {a.requested_by_agent_id ? (agentName.get(a.requested_by_agent_id) ?? a.requested_by_agent_id) : 'unknown agent'}
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-2xs uppercase tracking-wider text-dimmer">project</dt>
                  <dd className="font-mono">
                    <Link href={`/projects/${a.project_id}`} className="text-ink underline decoration-line hover:decoration-blue-400">
                      {projectName.get(a.project_id) ?? a.project_id}
                    </Link>
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-2xs uppercase tracking-wider text-dimmer">requested_at</dt>
                  <dd className="font-mono text-ink">
                    {fmtDateTime(a.requested_at)} <span className="text-dimmer">({fmtRelative(a.requested_at)})</span>
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-2xs uppercase tracking-wider text-dimmer">expires_at</dt>
                  <dd className={`font-mono ${expired ? 'text-red-300' : 'text-ink'}`}>
                    {fmtDateTime(a.expires_at)} <span className={expired ? 'text-red-300' : 'text-dimmer'}>({fmtRelative(a.expires_at)})</span>
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-2xs uppercase tracking-wider text-dimmer">job</dt>
                  <dd className="font-mono">
                    {a.job_id ? (
                      <Link href={`/jobs/${a.job_id}`} className="text-ink underline decoration-line hover:decoration-blue-400">
                        {a.job_id}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
              </dl>

              <div className="border-t border-line px-3 py-2">
                <div className="font-mono text-2xs uppercase tracking-wider text-dimmer">
                  action_preview — the exact thing that would happen
                </div>
                <pre className="mt-1 whitespace-pre-wrap break-words border border-line bg-base px-2 py-2 font-mono text-xs leading-5 text-ink">
                  {a.action_preview}
                </pre>
              </div>

              <div className="border-t border-line px-3 py-2">
                <div className="font-mono text-2xs uppercase tracking-wider text-dimmer">action_payload</div>
                <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words border border-line bg-base px-2 py-2 font-mono text-xs leading-5 text-dim">
                  {pretty(a.action_payload)}
                </pre>
              </div>

              <ApprovalDecision id={a.id} action={decideApproval} />
            </article>
          );
        })}
      </div>
    </div>
  );
}
