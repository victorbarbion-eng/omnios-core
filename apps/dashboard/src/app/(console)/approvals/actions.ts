'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

/**
 * Approve or deny an approval request.
 *
 * This action deliberately contains NO policy logic. It does not look at
 * risk_level, does not check expiry, does not touch the jobs table, and does not
 * use any privileged key. It issues one statement through the signed-in user's
 * session:
 *
 *   update approvals set status = ..., decision_note = ... where id = ...
 *
 * The database triggers (os_guard_approval_decision) are the enforcement layer:
 * they demand a real end-user session, refuse agent traffic, refuse anything that
 * is no longer pending, and refuse expired requests. Their raw Postgres error
 * message is passed back to the page verbatim.
 *
 * The only local check is form validation: a denial must carry a note.
 *
 * WHY `decision` IS AN ARGUMENT AND NOT A FORM FIELD.
 *
 * It used to be read from the form, with the two buttons carrying
 * `name="decision" value="approved|denied"`. That is correct HTML — the
 * submitter's name/value belongs in the submitted data — and it did not
 * work. React 19's `<form action={fn}>` path builds the FormData without
 * the submitter, so `decision` never arrived at all and every attempt
 * failed with `Unrecognised decision ""`. Measured, not guessed: a probe
 * page logging the received FormData showed `id` and `note` present and
 * `decision` absent on a plain mouse click, on a keyboard activation,
 * and with or without a note.
 *
 * Binding it as an argument removes the dependency on browser and
 * framework agreement about submitters. It is also stronger than a test
 * would be: the decision is now a typed parameter, so a caller that
 * forgets to supply one fails to compile rather than failing in front of
 * someone trying to approve something.
 *
 * Worth stating plainly, because it says something about what testing
 * was and was not covering: the approve button in this console had never
 * worked. Guard test 07 proves the DATABASE accepts a decision from a
 * signed-in session, and it passes, and it always did — it exercises SQL,
 * not the form. The one human action the entire system exists to make
 * safe was the one path nothing was checking.
 */
export async function decideApproval(
  decision: 'approved' | 'denied',
  formData: FormData,
): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const note = String(formData.get('note') ?? '').trim();

  const fail = (message: string): never => {
    redirect(`/approvals?error=${encodeURIComponent(message)}&error_id=${encodeURIComponent(id)}`);
  };

  if (!id) fail('No approval id was submitted.');
  if (decision !== 'approved' && decision !== 'denied') {
    // Unreachable through the UI now that this is a bound argument. Kept
    // because this action is a privileged entry point and an unchecked
    // value here would go straight into an UPDATE.
    fail(`Unrecognised decision "${String(decision)}".`);
  }
  if (decision === 'denied' && note.length === 0) fail('A decision note is required when denying a request.');

  const supabase = await createClient();
  const { error } = await supabase
    .from('approvals')
    .update({ status: decision, decision_note: note.length > 0 ? note : null })
    .eq('id', id);

  if (error) {
    // Raw Postgres message, verbatim. These codes are meaningful:
    // OMNIOS_HUMAN_SESSION_REQUIRED, OMNIOS_NOT_PENDING, OMNIOS_EXPIRED, ...
    const parts = [error.message];
    if (error.details) parts.push(`details: ${error.details}`);
    if (error.hint) parts.push(`hint: ${error.hint}`);
    if (error.code) parts.push(`code: ${error.code}`);
    fail(parts.join('\n'));
  }

  revalidatePath('/approvals');
  revalidatePath('/');
  redirect('/approvals');
}
