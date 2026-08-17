import type { PostgrestError } from '@supabase/supabase-js';
import type { ReactNode } from 'react';
import { riskClasses, statusClasses } from '@/lib/format';

export function Panel({
  title,
  subtitle,
  right,
  children,
  source,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  /** The table or view this panel's numbers come from. Every number is traceable. */
  source?: string;
}) {
  return (
    <section className="border border-line bg-panel">
      <header className="flex items-baseline justify-between gap-3 border-b border-line px-3 py-2">
        <div className="flex items-baseline gap-2">
          <h2 className="font-mono text-xs uppercase tracking-wider text-ink">{title}</h2>
          {subtitle ? <span className="text-xs text-dimmer">{subtitle}</span> : null}
        </div>
        <div className="flex items-center gap-3">
          {source ? <code className="text-2xs text-dimmer">{source}</code> : null}
          {right}
        </div>
      </header>
      <div>{children}</div>
    </section>
  );
}

export function Badge({ value, kind = 'status' }: { value: string | null | undefined; kind?: 'status' | 'risk' }) {
  const label = value ?? '—';
  const cls = kind === 'risk' ? riskClasses(value) : statusClasses(value);
  return (
    <span className={`inline-block whitespace-nowrap border px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wide ${cls}`}>
      {label}
    </span>
  );
}

export function Empty({ what }: { what: string }) {
  return (
    <div className="px-3 py-6 text-center text-sm text-dimmer">
      Nothing here yet — no {what} visible to your account.
    </div>
  );
}

export function ErrorBox({
  error,
  context,
}: {
  error: PostgrestError | Error | { message: string; details?: string | null; hint?: string | null; code?: string } | null | undefined;
  context?: string;
}) {
  if (!error) return null;
  const anyErr = error as { message: string; details?: string | null; hint?: string | null; code?: string };
  return (
    <div className="border border-red-500/50 bg-red-500/10 px-3 py-2">
      <div className="font-mono text-2xs uppercase tracking-wider text-red-300">
        query failed{context ? ` — ${context}` : ''}
      </div>
      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-red-200">{anyErr.message}</pre>
      {anyErr.details ? (
        <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-2xs text-red-200/80">{anyErr.details}</pre>
      ) : null}
      {anyErr.hint ? (
        <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-2xs text-red-200/80">hint: {anyErr.hint}</pre>
      ) : null}
      {anyErr.code ? <div className="mt-1 font-mono text-2xs text-red-200/60">code: {anyErr.code}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  meta,
  right,
}: {
  title: string;
  meta?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
      <div>
        <h1 className="font-mono text-lg tracking-tight text-ink">{title}</h1>
        {meta ? <div className="mt-1 text-xs text-dim">{meta}</div> : null}
      </div>
      {right}
    </div>
  );
}

export function Stat({
  label,
  value,
  source,
  tone,
}: {
  label: string;
  value: string | number;
  source: string;
  tone?: 'default' | 'amber' | 'red' | 'blue' | 'green';
}) {
  const toneCls =
    tone === 'amber'
      ? 'text-amber-300'
      : tone === 'red'
        ? 'text-red-300'
        : tone === 'blue'
          ? 'text-blue-300'
          : tone === 'green'
            ? 'text-emerald-300'
            : 'text-ink';
  return (
    <div className="border border-line bg-panel px-3 py-2">
      <div className="font-mono text-2xs uppercase tracking-wider text-dimmer">{label}</div>
      <div className={`font-mono text-xl ${toneCls}`}>{value}</div>
      <div className="mt-0.5 font-mono text-2xs text-dimmer">{source}</div>
    </div>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">{children}</table>
    </div>
  );
}

export function TH({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <th
      className={`border-b border-line px-2 py-1.5 font-mono text-2xs font-normal uppercase tracking-wider text-dimmer ${className}`}
    >
      {children}
    </th>
  );
}

export function TD({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`border-b border-line/60 px-2 py-1.5 align-top text-dim ${className}`}>{children}</td>;
}

export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono ${className}`}>{children}</span>;
}
