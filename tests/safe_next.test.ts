import { describe, expect, it } from 'vitest';
import { safeNext } from '../apps/dashboard/src/lib/safe-next';

/**
 * The `next` parameter survives a full, successful sign-in and then
 * decides where the browser lands. On localhost that is uninteresting.
 * On a public URL it is an open-redirect primitive: a link that begins
 * with your real domain, walks the victim through a real login, and
 * finishes somewhere else.
 *
 * These cases are the ones that beat a naive `startsWith('/')` check.
 */
describe('safeNext', () => {
  it('keeps ordinary in-app paths', () => {
    expect(safeNext('/approvals')).toBe('/approvals');
    expect(safeNext('/jobs/8f2c1e00-0000-0000-0000-000000000000')).toBe('/jobs/8f2c1e00-0000-0000-0000-000000000000');
    expect(safeNext('/projects?filter=open')).toBe('/projects?filter=open');
  });

  it('falls back to the overview when there is nothing useful', () => {
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext(null)).toBe('/');
    expect(safeNext('')).toBe('/');
    expect(safeNext('   ')).toBe('/');
  });

  it('refuses absolute URLs', () => {
    expect(safeNext('https://evil.example/phish')).toBe('/');
    expect(safeNext('http://evil.example')).toBe('/');
    expect(safeNext('javascript:alert(1)')).toBe('/');
  });

  it('refuses protocol-relative URLs, which do start with a slash', () => {
    // The case a `startsWith('/')` check waves through.
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('//evil.example/approvals')).toBe('/');
  });

  it('refuses the backslash variants browsers fold into a slash', () => {
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('\\\\evil.example')).toBe('/');
    expect(safeNext('\\/evil.example')).toBe('/');
  });

  it('refuses control characters', () => {
    expect(safeNext('/approvals\r\nSet-Cookie: x=y')).toBe('/');
    expect(safeNext('/approvals\u0000')).toBe('/');
  });

  it('is not fooled by leading whitespace around a hostile value', () => {
    expect(safeNext('  //evil.example')).toBe('/');
    expect(safeNext('\t https://evil.example')).toBe('/');
  });
});
