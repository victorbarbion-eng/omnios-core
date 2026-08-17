'use client';

import { useState } from 'react';

/**
 * Decision controls for one approval card. The note is required before the Deny
 * button becomes usable; the server action re-checks it. Neither this component
 * nor the action makes any policy judgement — the database does that.
 */
export default function ApprovalDecision({
  id,
  action,
}: {
  id: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const denyDisabled = note.trim().length === 0;

  return (
    <form action={action} className="space-y-2 border-t border-line px-3 py-2">
      <input type="hidden" name="id" value={id} />
      <label className="block">
        <span className="font-mono text-2xs uppercase tracking-wider text-dimmer">
          decision note (required to deny, optional to approve)
        </span>
        <textarea
          name="note"
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why this decision?"
          className="mt-1 w-full resize-y border border-line bg-base px-2 py-1.5 font-mono text-xs text-ink outline-none placeholder:text-dimmer focus:border-blue-500/60"
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          name="decision"
          value="approved"
          className="border border-emerald-500/50 bg-emerald-500/10 px-3 py-1 font-mono text-xs uppercase tracking-wider text-emerald-300 hover:bg-emerald-500/20"
        >
          Approve
        </button>
        <button
          type="submit"
          name="decision"
          value="denied"
          disabled={denyDisabled}
          title={denyDisabled ? 'Write a decision note first' : 'Deny this request'}
          className="border border-red-500/50 bg-red-500/10 px-3 py-1 font-mono text-xs uppercase tracking-wider text-red-300 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-dimmer"
        >
          Deny
        </button>
        <span className="font-mono text-2xs text-dimmer">
          update approvals set status, decision_note — triggers enforce the rest
        </span>
      </div>
    </form>
  );
}
