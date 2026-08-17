'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

/**
 * Kill switch. Calls the existing database RPC through the signed-in user's
 * session; the function itself decides whether the caller may flip it.
 */
export async function setEmergencyPause(formData: FormData): Promise<void> {
  const on = String(formData.get('on') ?? '') === 'true';
  const reason = String(formData.get('reason') ?? '').trim();

  const supabase = await createClient();
  const { error } = await supabase.rpc('os_set_emergency_pause', { p_on: on, p_reason: reason });

  if (error) {
    const parts = [error.message];
    if (error.details) parts.push(`details: ${error.details}`);
    if (error.hint) parts.push(`hint: ${error.hint}`);
    if (error.code) parts.push(`code: ${error.code}`);
    redirect(`/policy?error=${encodeURIComponent(parts.join('\n'))}`);
  }

  revalidatePath('/policy');
  revalidatePath('/');
  redirect(`/policy?ok=${on ? 'engaged' : 'released'}`);
}
