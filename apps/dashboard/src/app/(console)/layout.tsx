import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Nav from '@/components/Nav';
import { signOut } from '@/app/login/actions';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  // Live nav counts. Both are plain counts against a single table each.
  const [pending, failed, pause] = await Promise.all([
    supabase.from('approvals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
    supabase.from('system_settings').select('value').eq('key', 'emergency_pause').maybeSingle(),
  ]);

  const paused = pause.data?.value === true || pause.data?.value === 'true';

  return (
    <div className="flex min-h-screen">
      <Nav
        pendingApprovals={pending.count ?? null}
        failedJobs={failed.count ?? null}
        email={user.email ?? null}
        paused={paused}
        signOutAction={signOut}
      />
      <main className="min-w-0 flex-1 px-5 py-4">{children}</main>
    </div>
  );
}
