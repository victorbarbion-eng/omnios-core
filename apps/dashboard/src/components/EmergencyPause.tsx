'use client';

import { useState } from 'react';

/**
 * Two-step control: arm, then confirm. Nothing is sent until the confirm button
 * is pressed, and any database error is rendered by the page verbatim.
 */
export default function EmergencyPause({
  paused,
  action,
  updatedAt,
  updatedBy,
}: {
  paused: boolean;
  action: (formData: FormData) => Promise<void>;
  updatedAt: string | null;
  updatedBy: string | null;
}) {
  const [armed, setArmed] = useState(false);
  const [reason, setReason] = useState('');
  const target = !paused;

  return (
    <div className="space-y-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
        <span className="text-dimmer">current:</span>
        <span
          className={`border px-1.5 py-0.5 uppercase tracking-wide ${
            paused ? 'border-red-500/50 bg-red-500/10 text-red-300' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
          }`}
        >
          {paused ? 'paused' : 'running'}
        </span>
        <span className="text-dimmer">
          system_settings.emergency_pause · updated {updatedAt ?? '—'} {updatedBy ? `by ${updatedBy}` : ''}
        </span>
      </div>

      <p className="text-xs text-dim">
        While the pause is engaged, <code className="font-mono text-ink">os_guard_jobs()</code> refuses to start any job
        whose action type is not <code className="font-mono text-ink">risk_level=read</code>. This control calls the
        database RPC <code className="font-mono text-ink">os_set_emergency_pause(p_on, p_reason)</code>.
      </p>

      {!armed ? (
        <button
          type="button"
          onClick={() => setArmed(true)}
          className={`border px-3 py-1 font-mono text-xs uppercase tracking-wider ${
            target
              ? 'border-red-500/50 bg-red-500/10 text-red-300 hover:bg-red-500/20'
              : 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
          }`}
        >
          {target ? 'Engage emergency pause' : 'Release emergency pause'}
        </button>
      ) : (
        <form action={action} className="space-y-2 border border-amber-500/40 bg-amber-500/5 p-2">
          <input type="hidden" name="on" value={String(target)} />
          <div className="font-mono text-2xs uppercase tracking-wider text-amber-300">
            confirm: {target ? 'engage the kill switch' : 'release the kill switch'}
          </div>
          <p className="text-xs text-dim">
            {target
              ? 'All non-read work will stop starting immediately. Running jobs are not killed; they simply cannot advance past the guard.'
              : 'Non-read work will be able to start again, subject to the approval gate.'}
          </p>
          <label className="block">
            <span className="font-mono text-2xs uppercase tracking-wider text-dimmer">reason (recorded in the audit trail)</span>
            <input
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              placeholder={target ? 'Why are you pausing?' : 'Why is it safe to resume?'}
              className="mt-1 w-full border border-line bg-base px-2 py-1 font-mono text-xs text-ink outline-none placeholder:text-dimmer focus:border-blue-500/60"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={reason.trim().length === 0}
              className="border border-amber-500/50 bg-amber-500/10 px-3 py-1 font-mono text-xs uppercase tracking-wider text-amber-200 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-dimmer"
            >
              {target ? 'Yes, pause the system' : 'Yes, resume the system'}
            </button>
            <button
              type="button"
              onClick={() => setArmed(false)}
              className="border border-line px-3 py-1 font-mono text-xs uppercase tracking-wider text-dim hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
