import { describe, it, expect } from 'vitest';
import { signSession, verifySession, roleForKey } from './opsAuth';

const SECRET = 'test-secret';

describe('opsAuth', () => {
  it('signs and verifies a role token round-trip', () => {
    const t = signSession('support', SECRET);
    expect(verifySession(t, SECRET)).toBe('support');
    expect(verifySession(signSession('founder', SECRET), SECRET)).toBe('founder');
  });
  it('rejects a tampered or wrong-secret token', () => {
    const t = signSession('support', SECRET);
    expect(verifySession(t, 'other-secret')).toBeNull();
    expect(verifySession('founder.deadbeef', SECRET)).toBeNull();
    expect(verifySession(undefined, SECRET)).toBeNull();
  });
  it('maps login keys to roles', () => {
    const cfg = { supportKey: 'sup', founderKey: 'fou' };
    expect(roleForKey('sup', cfg)).toBe('support');
    expect(roleForKey('fou', cfg)).toBe('founder');
    expect(roleForKey('nope', cfg)).toBeNull();
    expect(roleForKey('', cfg)).toBeNull(); // empty never matches even if a key is unset
  });
});
