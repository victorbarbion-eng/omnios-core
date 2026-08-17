/**
 * Nothing this system logs, stores in audit_events, or prints to a
 * terminal should ever contain a credential. This is the last filter
 * before text leaves the process.
 *
 * It is a safety net, not a licence to pass secrets around: the rule
 * remains that secrets live in `.env` and platform environment
 * variables and are never written into records at all.
 *
 * Two failure modes matter, and the tests cover both:
 *   1. missing a secret  — a credential ends up in the audit trail
 *   2. masking too much  — an evidence URL gets mangled and the trail
 *      becomes unverifiable
 * The second one bit during testing: the OpenAI-key pattern `sk-...`
 * matched inside "ri[sk-management]-framework" and destroyed a NIST
 * source URL. Patterns are now anchored on non-word boundaries.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Supabase / JWT style tokens
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted:jwt]'],
  [/sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g, '[redacted:supabase-key]'],
  // Provider key shapes. Anchored so they cannot fire mid-word.
  [/(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g, '[redacted:api-key]'],
  [/(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{16,}(?![A-Za-z0-9])/g, '[redacted:github-token]'],
  [/(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g, '[redacted:aws-key-id]'],
  // Connection strings with inline passwords
  [/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/gi, '$1[redacted:password]$2'],
  // PEM blocks
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted:private-key]'],
  // Bearer tokens in headers
  [/(?<![A-Za-z0-9])(Bearer\s+)[A-Za-z0-9._~+/=-]{10,}/gi, '$1[redacted]'],
  // key=value / "key": "value" assignments for anything secret-shaped.
  // Handles JSON quoting on the key, which the first version missed.
  [
    /("?\b(?:api[_-]?key|secret|token|password|passwd|authorization|service[_-]?role[_-]?key|access[_-]?key|private[_-]?key)\b"?\s*[:=]\s*)("?)([^\s"',}]{3,})(\2)/gi,
    '$1$2[redacted]$4',
  ],
];

/** Keys whose value is always masked in a structure, whatever it looks like. */
const SECRET_KEY_PATTERN =
  /(api[_-]?key|secret|token|password|passwd|credential|authorization|auth[_-]?header|service[_-]?role|access[_-]?key|private[_-]?key|session[_-]?id|cookie)/i;

export function redact(input: unknown): string {
  let text = typeof input === 'string' ? input : safeStringify(input);
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

/**
 * Recursively redact a value destined for a jsonb column or a log line.
 *
 * Walks the structure rather than round-tripping through a string, so
 * it can mask by key name (`password: "x"` is masked even though "x"
 * looks like nothing) and cannot throw on undefined.
 */
export function redactObject<T>(value: T): T {
  return walk(value, false) as T;
}

function walk(value: unknown, parentKeyIsSecret: boolean): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return parentKeyIsSecret ? '[redacted]' : redact(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return parentKeyIsSecret ? '[redacted]' : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, parentKeyIsSecret));
  }

  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = walk(item, parentKeyIsSecret || SECRET_KEY_PATTERN.test(key));
    }
    return out;
  }

  // Functions, symbols, bigints: never persisted.
  return String(value);
}

function safeStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Drop-in replacement for console.log inside agent code. */
export function safeLog(...parts: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(parts.map((p) => redact(p)).join(' '));
}
