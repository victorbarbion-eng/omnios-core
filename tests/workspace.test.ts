import { describe, expect, it } from 'vitest';
import { isInsideWorkspace, resolveInsideWorkspace, WorkspaceBoundaryError } from '@omnios/shared';

/**
 * The agent may only touch files under its designated workspace root.
 * These are the escape attempts that matter: traversal, absolute paths,
 * sneaky prefixes, and home-directory shortcuts.
 */
const ROOT = '/home/victor/omnios-workspace';

describe('paths inside the workspace', () => {
  for (const p of ['notes.md', 'projects/a/report.md', './projects/a/../a/report.md', 'deep/a/b/c/d.txt']) {
    it(`accepts ${p}`, () => {
      expect(resolveInsideWorkspace(ROOT, p).startsWith(ROOT)).toBe(true);
      expect(isInsideWorkspace(ROOT, p)).toBe(true);
    });
  }

  it('accepts the root itself', () => {
    expect(isInsideWorkspace(ROOT, '.')).toBe(true);
  });
});

describe('escape attempts', () => {
  const escapes = [
    '../secrets.txt',
    '../../etc/passwd',
    'projects/../../outside.md',
    '/etc/passwd',
    '/home/victor/.ssh/id_rsa',
    '~/.aws/credentials',
    'a/b/../../../../../../tmp/x',
  ];

  for (const p of escapes) {
    it(`refuses ${p}`, () => {
      expect(() => resolveInsideWorkspace(ROOT, p)).toThrow(WorkspaceBoundaryError);
      expect(isInsideWorkspace(ROOT, p)).toBe(false);
    });
  }

  it('refuses a sibling directory that merely shares the prefix', () => {
    // /home/victor/omnios-workspace-backup must not pass a naive
    // startsWith check against /home/victor/omnios-workspace.
    expect(isInsideWorkspace(ROOT, '../omnios-workspace-backup/file.md')).toBe(false);
  });

  it('names the offending path in the error, without leaking file contents', () => {
    try {
      resolveInsideWorkspace(ROOT, '../../etc/passwd');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).name).toBe('WorkspaceBoundaryError');
      expect((err as Error).message).toContain('OMNIOS_OUTSIDE_WORKSPACE');
    }
  });
});
