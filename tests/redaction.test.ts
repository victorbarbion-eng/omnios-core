import { describe, expect, it } from 'vitest';
import { redact, redactObject } from '@omnios/shared';

/**
 * Redaction is a safety net, not the primary control — the primary
 * control is never putting a secret in a log line in the first place.
 * These tests keep the net honest.
 */
const SERVICE_ROLE_SHAPED =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.aaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('redact', () => {
  it('masks a JWT-shaped token', () => {
    const out = redact(`token=${SERVICE_ROLE_SHAPED}`);
    expect(out).not.toContain(SERVICE_ROLE_SHAPED);
    expect(out).toContain('[redacted');
  });

  it('masks a Supabase secret key', () => {
    const out = redact('key: sb_secret_abcdefghijklmnopqrstuvwxyz123456');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });

  it('masks a database URL password', () => {
    const out = redact('postgresql://postgres:sup3rS3cret@db.abc.supabase.co:5432/postgres');
    expect(out).not.toContain('sup3rS3cret');
    expect(out).toContain('db.abc.supabase.co');
  });

  it('masks bearer tokens', () => {
    expect(redact('Authorization: Bearer abcdef1234567890abcdef')).not.toContain('abcdef1234567890abcdef');
  });

  it('leaves ordinary prose untouched', () => {
    const line = 'Recorded 2 evidence items for the demo project.';
    expect(redact(line)).toBe(line);
  });

  it('does not mangle a plain https URL that is meant to be visible', () => {
    const line = 'source: https://www.nist.gov/itl/ai-risk-management-framework';
    expect(redact(line)).toContain('nist.gov/itl/ai-risk-management-framework');
  });
});

describe('redactObject', () => {
  it('masks values under secret-shaped keys at any depth', () => {
    const out = redactObject({
      ok: 'visible',
      nested: { service_role_key: SERVICE_ROLE_SHAPED, password: 'hunter2', api_token: 'xyz' },
    }) as Record<string, unknown>;

    const serialised = JSON.stringify(out);
    expect(serialised).toContain('visible');
    expect(serialised).not.toContain(SERVICE_ROLE_SHAPED);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('xyz');
  });

  it('preserves structure and non-secret values', () => {
    const out = redactObject({ a: 1, b: [1, 2, 3], c: { d: true } }) as Record<string, unknown>;
    expect(out['a']).toBe(1);
    expect(out['b']).toEqual([1, 2, 3]);
    expect((out['c'] as Record<string, unknown>)['d']).toBe(true);
  });

  it('handles null and undefined without throwing', () => {
    expect(() => redactObject(null)).not.toThrow();
    expect(() => redactObject(undefined)).not.toThrow();
  });

  it('masks secret-shaped values even under an innocuous key name', () => {
    const out = redactObject({ note: `here it is: ${SERVICE_ROLE_SHAPED}` }) as Record<string, string>;
    expect(out['note']).not.toContain(SERVICE_ROLE_SHAPED);
  });
});
