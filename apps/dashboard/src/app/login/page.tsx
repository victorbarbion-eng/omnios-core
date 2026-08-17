import Link from 'next/link';
import { signIn } from './actions';

export const metadata = { title: 'Sign in — OmniOS' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-6 flex items-center gap-2">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-label="OmniOS logo" role="img">
          <rect x="1.5" y="1.5" width="21" height="21" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 12h12M12 6v12" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="12" cy="12" r="3.25" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <span className="font-mono text-sm uppercase tracking-[0.2em] text-ink">OmniOS</span>
      </div>

      <h1 className="font-mono text-lg text-ink">Operations console</h1>
      <p className="mt-1 text-sm text-dim">
        Sign in with the email and password of your Supabase user. Every query in this console runs through your own
        session, so row-level security decides what you can see.
      </p>

      {error ? (
        <div className="mt-4 border border-red-500/50 bg-red-500/10 px-3 py-2">
          <div className="font-mono text-2xs uppercase tracking-wider text-red-300">sign-in failed</div>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-red-200">{error}</pre>
        </div>
      ) : null}

      <form action={signIn} className="mt-5 space-y-3 border border-line bg-panel p-4">
        <input type="hidden" name="next" value={next ?? '/'} />
        <label className="block">
          <span className="font-mono text-2xs uppercase tracking-wider text-dimmer">email</span>
          <input
            type="email"
            name="email"
            required
            autoComplete="username"
            className="mt-1 w-full border border-line bg-base px-2 py-1.5 font-mono text-sm text-ink outline-none focus:border-blue-500/60"
          />
        </label>
        <label className="block">
          <span className="font-mono text-2xs uppercase tracking-wider text-dimmer">password</span>
          <input
            type="password"
            name="password"
            required
            autoComplete="current-password"
            className="mt-1 w-full border border-line bg-base px-2 py-1.5 font-mono text-sm text-ink outline-none focus:border-blue-500/60"
          />
        </label>
        <button
          type="submit"
          className="w-full border border-line bg-panel2 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-ink hover:border-blue-500/60 hover:text-blue-200"
        >
          Sign in
        </button>
      </form>

      <div className="mt-4 border border-line bg-panel px-3 py-2 text-xs text-dim">
        <div className="font-mono text-2xs uppercase tracking-wider text-dimmer">no account?</div>
        <p className="mt-1">
          There is no signup here on purpose. Create your account by hand in the Supabase dashboard:{' '}
          <span className="font-mono text-ink">Authentication → Users → Add user</span>, with{' '}
          <span className="font-mono text-ink">Auto Confirm User</span> enabled, then sign in above. Email + password
          only — no magic links, no OAuth.
        </p>
      </div>

      <p className="mt-4 text-2xs text-dimmer">
        This app uses the publishable key only. A service-role key is never present here.{' '}
        <Link href="/" className="underline hover:text-dim">
          Overview
        </Link>
      </p>
    </main>
  );
}
