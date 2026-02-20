import path from 'node:path';

const posix = path.posix;

export function resolveVirtualPath(input: string, cwd: string): string {
  const base = input.startsWith('/') ? input : posix.join(cwd, input);
  let normalized = posix.normalize(base);

  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }

  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

export function parentPathOf(input: string): string {
  if (input === '/') {
    return '/';
  }

  const parent = posix.dirname(input);
  return parent === '.' ? '/' : parent;
}
