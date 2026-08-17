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
 */
export async function decideApproval(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const decision = String(formData.get('decision') ?? '');
  const note = String(formData.get('note') ?? '').trim();

  const fail = (message: string): never => {
    redirect(`/approvals?error=${encodeURIComponent(message)}&error_id=${encodeURIComponent(id)}`);
  };

  if (!id) fail('No approval id was submitted.');
  if (decision !== 'approved' && decision !== 'denied') fail(`Unrecognised decision "${decision}".`);
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
