export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export function fmtRelative(value: string | null | undefined): string {
  if (!value) return 'never';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const diffMs = Date.now() - d.getTime();
  const future = diffMs < 0;
  const s = Math.floor(Math.abs(diffMs) / 1000);
  const out =
    s < 45
      ? `${s}s`
      : s < 3600
        ? `${Math.floor(s / 60)}m`
        : s < 86400
          ? `${Math.floor(s / 3600)}h`
          : s < 2592000
            ? `${Math.floor(s / 86400)}d`
            : `${Math.floor(s / 2592000)}mo`;
  return future ? `in ${out}` : `${out} ago`;
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function isPast(value: string | null | undefined): boolean {
  if (!value) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}

export function shortId(id: string | null | undefined, chars = 8): string {
  if (!id) return '—';
  return id.slice(0, chars);
}

export function pretty(json: unknown): string {
  try {
    return JSON.stringify(json ?? {}, null, 2);
  } catch {
    return String(json);
  }
}

/**
 * Consistent status colour coding across the whole console.
 *   neutral grey = queued / backlog
 *   blue         = running / in_progress / claimed
 *   amber        = awaiting_approval / pending / blocked
 *   green        = completed / done / approved / idle
 *   red          = failed / denied / error
 *   dim          = cancelled / expired / offline
 */
export function statusClasses(status: string | null | undefined): string {
  const s = (status ?? '').toLowerCase();
  switch (s) {
    case 'queued':
    case 'backlog':
    case 'ready':
    case 'unverified':
      return 'border-line bg-panel2 text-dim';
    case 'agent':
    case 'running':
    case 'claimed':
    case 'in_progress':
    case 'active':
      return 'border-blue-500/40 bg-blue-500/10 text-blue-300';
    case 'awaiting_approval':
    case 'pending':
    case 'blocked':
    case 'on_hold':
    case 'paused':
    case 'disputed':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-300';
    case 'completed':
    case 'done':
    case 'approved':
    case 'idle':
    case 'corroborated':
    case 'primary_source':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
    case 'failed':
    case 'denied':
    case 'error':
      return 'border-red-500/50 bg-red-500/10 text-red-300';
    case 'cancelled':
    case 'expired':
    case 'archived':
    case 'system':
    case 'offline':
      return 'border-line bg-transparent text-dimmer';
    default:
      return 'border-line bg-panel2 text-dim';
  }
}

/** risk_class colour coding: read is calm, prohibited is loud. */
export function riskClasses(risk: string | null | undefined): string {
  switch ((risk ?? '').toLowerCase()) {
    case 'read':
      return 'border-line bg-panel2 text-dim';
    case 'internal_write':
      return 'border-blue-500/40 bg-blue-500/10 text-blue-300';
    case 'external_draft':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-300';
    case 'approval_required':
      return 'border-orange-500/50 bg-orange-500/10 text-orange-300';
    case 'prohibited':
      return 'border-red-500/50 bg-red-500/10 text-red-300';
    default:
      return 'border-line bg-panel2 text-dim';
  }
}

export function priorityClasses(priority: string | null | undefined): string {
  switch ((priority ?? '').toLowerCase()) {
    case 'critical':
      return 'text-red-300';
    case 'high':
      return 'text-amber-300';
    case 'medium':
      return 'text-dim';
    default:
      return 'text-dimmer';
  }
}
