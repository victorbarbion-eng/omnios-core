import type { NextConfig } from 'next';

/**
 * Response headers.
 *
 * These matter more once the console is on a public URL than they did
 * on localhost. The one that earns its place is `frame-ancestors`: this
 * app's whole purpose is a page with two buttons marked Approve and
 * Deny, and a page like that is the textbook clickjacking target — put
 * it in an invisible iframe under a "play video" button and a real,
 * signed-in human clicks Approve without knowing they did. The database
 * cannot tell that apart from a genuine decision, because it IS a
 * genuine decision: a real session, a real request, a real auth.uid().
 * Every guard in this project passes. The only place to stop it is here.
 *
 * X-Frame-Options says the same thing for older browsers.
 *
 * Deliberately NOT a full Content-Security-Policy. Next.js injects
 * inline bootstrap scripts, so a `script-src` directive needs
 * per-request nonces threaded through the app to avoid either breaking
 * the page or being defanged by 'unsafe-inline'. A CSP that has to be
 * neutered to work is worse than none, because it reads as protection.
 * Worth doing properly later; not worth faking now.
 */
const securityHeaders = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  // Two years, and subdomains. Vercel serves HTTPS only, so this costs
  // nothing and closes the downgrade window on every visit after the first.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
