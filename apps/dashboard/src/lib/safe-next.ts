/**
 * Sanitises the `next` parameter carried through sign-in.
 *
 * The middleware puts the page you were trying to reach into `?next=`,
 * and the login action redirects there afterwards. The obvious check —
 * "does it start with a slash?" — is not enough, and the gap only
 * matters once the console has a public URL.
 *
 * `//evil.example` starts with a slash. Browsers read it as a
 * protocol-relative URL and leave the site. `/\evil.example` does the
 * same in several browsers, which fold the backslash into a slash. The
 * result is a link that carries your own domain, sends you through a
 * real successful sign-in, and lands you somewhere else — the shape of
 * a credential-phishing link, made credible by the fact that the first
 * half of it is genuine.
 *
 * So: a path, not a URL. Exactly one leading slash, no host, no control
 * characters. Anything else goes to the overview page rather than being
 * repaired, because guessing what a malformed redirect "meant" is how
 * these functions grow holes.
 */
export function safeNext(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();

  if (value === '') return '/';
  if (!value.startsWith('/')) return '/';

  // Protocol-relative, and the backslash variants browsers fold into it.
  // A scheme cannot appear here — the string already begins with '/' —
  // so the host-bearing forms are the only ones left to exclude.
  if (/^\/[/\\]/.test(value)) return '/';

  // Control characters, which can break out of a header or a URL when
  // this value is echoed back into either.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return '/';

  return value;
}
