import { createClient } from '@/lib/supabase/server';
import EmergencyPause from '@/components/EmergencyPause';
import { Badge, Empty, ErrorBox, Mono, PageHeader, Panel, TD, TH, Table } from '@/components/ui';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import { setEmergencyPause } from './actions';

export const dynamic = 'force-dynamic';

const RISK_ORDER = ['read', 'internal_write', 'external_draft', 'approval_required', 'prohibited'] as const;

const RISK_NOTES: Record<string, string> = {
  read: 'Read allowed sources. No state change.',
  internal_write: 'Write inside this system and designated folders.',
  external_draft: 'Prepare something outward-facing, but never send it.',
  approval_required: 'Blocked until a human approves the exact action.',
  prohibited: 'Never permitted by this build, at any autonomy level.',
};

type Policy = {
  action_type: string;
  risk_level: string;
  description: string;
  auto_allowed: boolean;
  promoted_at: string | null;
  promoted_note: string | null;
  updated_at: string;
};

type Setting = { key: string; value: unknown; description: string; updated_at: string; updated_by: string | null };

export default async function PolicyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { error: actionError, ok } = await searchParams;
  const supabase = await createClient();

  const [policies, settings] = await Promise.all([
    supabase.from('action_policies').select('*').order('action_type'),
    supabase.from('system_settings').select('key,value,description,updated_at,updated_by').order('key'),
  ]);

  const rows = (policies.data ?? []) as Policy[];
  const settingRows = (settings.data ?? []) as Setting[];
  const pauseSetting = settingRows.find((s) => s.key === 'emergency_pause');
  const paused = pauseSetting?.value === true || pauseSetting?.value === 'true';
  const autonomy = settingRows.find((s) => s.key === 'autonomy_level');

  const grouped = RISK_ORDER.map((risk) => ({ risk, items: rows.filter((r) => r.risk_level === risk) }));
  const ungrouped = rows.filter((r) => !RISK_ORDER.includes(r.risk_level as (typeof RISK_ORDER)[number]));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Policy"
        meta={
          <>
            Autonomy matrix, read-only. {rows.length} action type(s) from <Mono>action_policies</Mono>. Widening autonomy
            is itself an <Mono>approval_required</Mono> action, so it is not editable here.
          </>
        }
      />

      {actionError ? (
        <div className="border border-red-500/50 bg-red-500/10 px-3 py-2">
          <div className="font-mono text-2xs uppercase tracking-wider text-red-300">emergency pause rpc failed</div>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-red-200">{actionError}</pre>
        </div>
      ) : null}
      {ok ? (
        <div className="border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 font-mono text-xs text-emerald-300">
          emergency pause {ok} — os_set_emergency_pause returned successfully
        </div>
      ) : null}

      <div className="space-y-2">
        <ErrorBox error={policies.error} context="action_policies" />
        <ErrorBox error={settings.error} context="system_settings" />
      </div>

      <Panel
        title="Emergency pause"
        subtitle="the kill switch"
        source="system_settings.emergency_pause · rpc os_set_emergency_pause"
        right={<Badge value={paused ? 'failed' : 'completed'} />}
      >
        <EmergencyPause
          paused={paused}
          action={setEmergencyPause}
          updatedAt={pauseSetting ? `${fmtDateTime(pauseSetting.updated_at)} (${fmtRelative(pauseSetting.updated_at)})` : null}
          updatedBy={pauseSetting?.updated_by ?? null}
        />
      </Panel>

      <Panel title="System settings" source="system_settings">
        {settingRows.length === 0 && !settings.error ? (
          <Empty what="system settings" />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>key</TH>
                <TH>value</TH>
                <TH>description</TH>
                <TH>updated</TH>
                <TH>updated_by</TH>
              </tr>
            </thead>
            <tbody>
              {settingRows.map((s) => (
                <tr key={s.key} className="hover:bg-panel2">
                  <TD className="font-mono text-ink">{s.key}</TD>
                  <TD className="font-mono text-ink">{JSON.stringify(s.value)}</TD>
                  <TD>{s.description}</TD>
                  <TD className="whitespace-nowrap font-mono">{fmtDateTime(s.updated_at)}</TD>
                  <TD className="font-mono text-dimmer">{s.updated_by ?? '—'}</TD>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <div className="border-t border-line px-3 py-2 text-2xs text-dimmer">
          Current autonomy level: <Mono className="text-ink">{JSON.stringify(autonomy?.value ?? null)}</Mono>
        </div>
      </Panel>

      {rows.length === 0 && !policies.error ? (
        <Panel title="Autonomy matrix" source="action_policies">
          <Empty what="action policies" />
        </Panel>
      ) : null}

      {grouped.map(({ risk, items }) => (
        <Panel
          key={risk}
          title={risk}
          subtitle={RISK_NOTES[risk]}
          source={`action_policies · risk_level=${risk}`}
          right={
            <span className="font-mono text-2xs text-dimmer">
              {items.filter((i) => i.auto_allowed).length}/{items.length} automatic
            </span>
          }
        >
          {items.length === 0 ? (
            <Empty what={`${risk} action types`} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <TH>action_type</TH>
                  <TH>automatic?</TH>
                  <TH>description</TH>
                  <TH>promoted_at</TH>
                  <TH>promoted_note</TH>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.action_type} className="hover:bg-panel2">
                    <TD className="font-mono text-ink">{p.action_type}</TD>
                    <TD>
                      {p.auto_allowed ? (
                        <Badge value="approved" />
                      ) : risk === 'prohibited' ? (
                        <Badge value="denied" />
                      ) : (
                        <Badge value="pending" />
                      )}
                      <span className="ml-2 font-mono text-2xs text-dimmer">
                        {p.auto_allowed ? 'runs without a human' : risk === 'prohibited' ? 'never runs' : 'needs approval'}
                      </span>
                    </TD>
                    <TD>{p.description}</TD>
                    <TD className="whitespace-nowrap font-mono">{p.promoted_at ? fmtDateTime(p.promoted_at) : '—'}</TD>
                    <TD>{p.promoted_note ?? '—'}</TD>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      ))}

      {ungrouped.length > 0 ? (
        <Panel title="Other risk levels" source="action_policies">
          <Table>
            <thead>
              <tr>
                <TH>action_type</TH>
                <TH>risk_level</TH>
                <TH>automatic?</TH>
                <TH>description</TH>
              </tr>
            </thead>
            <tbody>
              {ungrouped.map((p) => (
                <tr key={p.action_type}>
                  <TD className="font-mono text-ink">{p.action_type}</TD>
                  <TD>
                    <Badge value={p.risk_level} kind="risk" />
                  </TD>
                  <TD className="font-mono">{p.auto_allowed ? 'yes' : 'no'}</TD>
                  <TD>{p.description}</TD>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      ) : null}
    </div>
  );
}
