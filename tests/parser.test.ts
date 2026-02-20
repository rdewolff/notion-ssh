import { describe, expect, it } from 'vitest';

import { parseCommandLine, tokenize } from '../src/session/parser';

describe('tokenize', () => {
  it('handles quoted strings', () => {
    expect(tokenize('grep -r "hello world" /pages')).toEqual(['grep', '-r', 'hello world', '/pages']);
  });

  it('handles escaped spaces', () => {
    expect(tokenize('cat my\\ file.md')).toEqual(['cat', 'my file.md']);
  });
});

describe('parseCommandLine', () => {
  it('parses command and args', () => {
    expect(parseCommandLine('ls -la /pages')).toEqual({
      command: 'ls',
      args: ['-la', '/pages']
    });
  });

  it('returns empty command for blank input', () => {
    expect(parseCommandLine('   ')).toEqual({
      command: '',
      args: []
    });
  });
});
