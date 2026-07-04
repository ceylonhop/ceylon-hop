import { describe, it, expect } from 'vitest';
import {
  can, parseOpsUsers, roleForEmail, signSession, verifySession,
  type OpsRole, type OpsAction,
} from './opsAuth';

describe('can() capability matrix', () => {
  const rows: [OpsRole, OpsAction, boolean][] = [
    ['founder', 'quote:manage', true], ['founder', 'margin:view', true],
    ['founder', 'bookings:operate', true], ['founder', 'bookings:read', true],
    ['founder', 'payments:act', true], ['founder', 'admin:jobs', true],
    ['finance', 'quote:manage', true], ['finance', 'margin:view', false],
    ['finance', 'bookings:operate', false], ['finance', 'bookings:read', true],
    ['finance', 'payments:act', true], ['finance', 'admin:jobs', false],
    ['ops', 'quote:manage', true], ['ops', 'margin:view', false],
    ['ops', 'bookings:operate', true], ['ops', 'bookings:read', true],
    ['ops', 'payments:act', false], ['ops', 'admin:jobs', false],
    ['system', 'admin:jobs', true], ['system', 'payments:act', false],
    ['system', 'quote:manage', false], ['system', 'bookings:read', false],
  ];
  it.each(rows)('%s can %s === %s', (role, action, expected) => {
    expect(can(role, action)).toBe(expected);
  });
});

describe('parseOpsUsers / roleForEmail', () => {
  const users = parseOpsUsers('Founder@x.com:founder, fin@x.com:finance ,ops@x.com:ops');
  it('maps each email to its role, case-insensitively', () => {
    expect(roleForEmail('founder@x.com', users)).toBe('founder');
    expect(roleForEmail('FOUNDER@X.COM', users)).toBe('founder');
    expect(roleForEmail('fin@x.com', users)).toBe('finance');
    expect(roleForEmail('ops@x.com', users)).toBe('ops');
  });
  it('returns null for an unknown email', () => {
    expect(roleForEmail('nobody@x.com', users)).toBeNull();
  });
  it('ignores malformed / blank entries and an unknown role string', () => {
    const u = parseOpsUsers('good@x.com:founder,,garbage,bad@x.com:wizard');
    expect(roleForEmail('good@x.com', u)).toBe('founder');
    expect(roleForEmail('bad@x.com', u)).toBeNull();
    expect(u.size).toBe(1);
  });
});

describe('identity session cookie', () => {
  const secret = 'sek';
  it('round-trips {email, exp}', () => {
    const tok = signSession({ email: 'a@x.com', exp: 2000 }, secret);
    expect(verifySession(tok, secret, 1000)).toEqual({ email: 'a@x.com', exp: 2000 });
  });
  it('rejects an expired cookie', () => {
    const tok = signSession({ email: 'a@x.com', exp: 500 }, secret);
    expect(verifySession(tok, secret, 1000)).toBeNull();
  });
  it('rejects a tampered payload (HMAC must verify)', () => {
    const tok = signSession({ email: 'a@x.com', exp: 2000 }, secret);
    const [body] = tok.split('.');
    const forged = `${body}.deadbeef`;
    expect(verifySession(forged, secret, 1000)).toBeNull();
  });
  it('rejects a cookie signed with a different secret', () => {
    const tok = signSession({ email: 'a@x.com', exp: 2000 }, 'other');
    expect(verifySession(tok, secret, 1000)).toBeNull();
  });
  it('treats undefined/garbage as null', () => {
    expect(verifySession(undefined, secret, 1000)).toBeNull();
    expect(verifySession('not-a-token', secret, 1000)).toBeNull();
  });
});
