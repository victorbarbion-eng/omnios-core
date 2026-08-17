import { resolve, relative, isAbsolute, sep } from 'node:path';

export class WorkspaceBoundaryError extends Error {
  constructor(attempted: string, root: string) {
    super(
      `OMNIOS_OUTSIDE_WORKSPACE: "${attempted}" resolves outside the approved workspace root "${root}". ` +
        `File actions outside the root are policy action "run_command_outside_root" and require approval.`,
    );
    this.name = 'WorkspaceBoundaryError';
  }
}

/**
 * Every file path an agent touches passes through here.
 *
 * Guards against the three things that actually go wrong in practice:
 * `../` traversal, absolute paths pointing elsewhere, and sibling
 * directories that merely share a name prefix with the root
 * (`/work/project` must not grant `/work/project-secrets`).
 */
export function resolveInsideWorkspace(root: string, candidate: string): string {
  if (!root || !isAbsolute(root)) {
    throw new Error(`OMNIOS_BAD_ROOT: workspace root must be an absolute path, got "${root}".`);
  }

  // A shell would expand "~" to the home directory; Node does not.
  // Left alone, "~/.aws/credentials" would silently resolve to a
  // literal "~" folder inside the workspace — a path that looks like
  // it escaped, does not, and hides what the agent actually touched.
  // Refuse it outright rather than guess the intent.
  if (candidate.startsWith('~')) {
    throw new WorkspaceBoundaryError(candidate, resolve(root));
  }

  const normalisedRoot = resolve(root);
  const resolved = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(normalisedRoot, candidate);

  const rel = relative(normalisedRoot, resolved);
  const escapes = rel.startsWith('..') || (rel !== '' && isAbsolute(rel));

  if (escapes || (rel !== '' && rel.split(sep)[0] === '..')) {
    throw new WorkspaceBoundaryError(candidate, normalisedRoot);
  }

  return resolved;
}

export function isInsideWorkspace(root: string, candidate: string): boolean {
  try {
    resolveInsideWorkspace(root, candidate);
    return true;
  } catch {
    return false;
  }
}
