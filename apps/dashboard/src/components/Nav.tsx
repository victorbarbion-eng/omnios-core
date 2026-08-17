'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ROUTES: { href: string; label: string; badge?: 'approvals' | 'jobs' }[] = [
  { href: '/', label: 'Overview' },
  { href: '/projects', label: 'Projects' },
  { href: '/agents', label: 'Agents' },
  { href: '/approvals', label: 'Approvals', badge: 'approvals' },
  { href: '/audit', label: 'Audit' },
  { href: '/jobs', label: 'Jobs', badge: 'jobs' },
  { href: '/policy', label: 'Policy' },
];

export default function Nav({
  pendingApprovals,
  failedJobs,
  email,
  paused,
  signOutAction,
}: {
  pendingApprovals: number | null;
  failedJobs: number | null;
  email: string | null;
  paused: boolean;
  signOutAction: () => Promise<void>;
}) {
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 flex h-screen w-52 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-3">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-label="OmniOS logo" role="img">
          <rect x="1.5" y="1.5" width="21" height="21" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 12h12M12 6v12" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="12" cy="12" r="3.25" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <span className="font-mono text-xs uppercase tracking-[0.18em]">OmniOS</span>
      </div>

      {paused ? (
        <Link
          href="/policy"
          className="border-b border-red-500/40 bg-red-500/10 px-3 py-1.5 font-mono text-2xs uppercase tracking-wider text-red-300 hover:bg-red-500/20"
        >
          ● emergency pause on
        </Link>
      ) : null}

      <ul className="flex-1 overflow-y-auto py-1">
        {ROUTES.map((r) => {
          const active = r.href === '/' ? pathname === '/' : pathname.startsWith(r.href);
          const count = r.badge === 'approvals' ? pendingApprovals : r.badge === 'jobs' ? failedJobs : null;
          const showCount = r.badge !== undefined && count !== null && count > 0;
          return (
            <li key={r.href}>
              <Link
                href={r.href}
                className={`flex items-center justify-between px-3 py-1.5 font-mono text-xs ${
                  active ? 'bg-panel2 text-ink' : 'text-dim hover:bg-panel2 hover:text-ink'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className={active ? 'text-blue-400' : 'text-dimmer'}>{active ? '▸' : '·'}</span>
                  {r.label}
                </span>
                {showCount ? (
                  <span
                    className={`border px-1 font-mono text-2xs ${
                      r.badge === 'approvals'
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                        : 'border-red-500/50 bg-red-500/10 text-red-300'
                    }`}
                  >
                    {count}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-line px-3 py-2">
        <div className="truncate font-mono text-2xs text-dimmer" title={email ?? ''}>
          {email ?? 'not signed in'}
        </div>
        <form action={signOutAction}>
          <button
            type="submit"
            className="mt-1 w-full border border-line px-2 py-1 font-mono text-2xs uppercase tracking-wider text-dim hover:border-red-500/50 hover:text-red-300"
          >
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}
