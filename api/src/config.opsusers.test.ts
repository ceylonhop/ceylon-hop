import { describe, it, expect } from 'vitest';
import { parseOpsUsers, roleForEmail } from './lib/opsAuth';

describe('OPS_USERS wiring', () => {
  it('a realistic 3-person string resolves all three roles', () => {
    const u = parseOpsUsers('a@ceylonhop.com:founder,b@ceylonhop.com:finance,c@ceylonhop.com:ops');
    expect(roleForEmail('a@ceylonhop.com', u)).toBe('founder');
    expect(roleForEmail('b@ceylonhop.com', u)).toBe('finance');
    expect(roleForEmail('c@ceylonhop.com', u)).toBe('ops');
  });
});
