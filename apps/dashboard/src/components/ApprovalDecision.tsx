'use client';

import { useState } from 'react';

/**
 * Decision controls for one approval card. The note is required before the Deny
 * button becomes usable; the server action re-checks it. Neither this component
 * nor the action makes any policy judgement — the database does that.
 *
 * The decision travels as a BOUND ARGUMENT, not as a form field, and the form
 * has no `action` of its own — each button supplies its own `formAction`.
 *
 * The previous version was ordinary HTML: one form action, two submit buttons
 * carrying `name="decision" value="approved|denied"`. By the specification the
 * submitter's name and value are part of the submitted data. React 19's form
 * action path does not include them, so `decision` never reached the server and
 * every click came back `Unrecognised decision ""`. This was measured against a
 * probe page, not inferred: mouse click, keyboard activation, with a note and
 * without — `id` and `note` arrived every time, `decision` never did. Pressing
 * Enter in the textarea submits nothing at all, as a textarea should.
 *
 * Binding removes the dependency on that agreement, and makes the mistake
 * uncompilable rather than merely untested.
 */
export default function ApprovalDecision({
  id,
  action,
}: {
  id: string;
  action: (decision: 'approved' | 'denied', formData: FormData) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const denyDisabled = note.trim().length === 0;

  return (
    <form className="space-y-2 border-t border-line px-3 py-2">
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
          formAction={action.bind(null, 'approved')}
          className="border border-emerald-500/50 bg-emerald-500/10 px-3 py-1 font-mono text-xs uppercase tracking-wider text-emerald-300 hover:bg-emerald-500/20"
        >
          Approve
        </button>
        <button
          type="submit"
          formAction={action.bind(null, 'denied')}
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
