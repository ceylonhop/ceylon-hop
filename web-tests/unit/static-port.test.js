import { describe, it, expect } from 'vitest';
import { resolveStaticPort } from '../static-port.js';

// Guards the port picker that keeps concurrent worktrees' e2e runs off each
// other's static servers (a shared hardcoded 4173 + reuseExistingServer once
// made a run silently test another worktree's files).
describe('resolveStaticPort', () => {
  it('honours CH_STATIC_PORT when set', () => {
    expect(resolveStaticPort({ CH_STATIC_PORT: '4555' }, '/some/tree')).toBe(4555);
  });

  it('ignores a non-numeric CH_STATIC_PORT and falls back to the derived port', () => {
    const derived = resolveStaticPort({}, '/some/tree');
    expect(resolveStaticPort({ CH_STATIC_PORT: 'nope' }, '/some/tree')).toBe(derived);
    expect(resolveStaticPort({ CH_STATIC_PORT: '' }, '/some/tree')).toBe(derived);
  });

  it('derives the same port for the same worktree path', () => {
    expect(resolveStaticPort({}, '/Users/x/ceylon-hop')).toBe(
      resolveStaticPort({}, '/Users/x/ceylon-hop'),
    );
  });

  it('derives different ports for different worktree paths', () => {
    const a = resolveStaticPort({}, '/Users/x/ceylon-hop');
    const b = resolveStaticPort({}, '/Users/x/ceylon-hop/.claude/worktrees/determined-hermann');
    expect(a).not.toBe(b);
  });

  it('derives ports clear of the dev-server range (20000-29999)', () => {
    for (const p of ['/a', '/b/c', '/Users/x/ceylon-hop', '/ci/runner/work/repo']) {
      const port = resolveStaticPort({}, p);
      expect(port).toBeGreaterThanOrEqual(20000);
      expect(port).toBeLessThanOrEqual(29999);
    }
  });
});
