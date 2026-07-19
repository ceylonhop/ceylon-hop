import { describe, it, expect } from 'vitest';
import {
  can, parseOpsUsers, roleForEmail, signSession, verifySession, displayNameFor, approverOpsUsers,
  type OpsRole, type OpsAction,
} from './opsAuth';

describe('can() capability matrix', () => {
  const rows: [OpsRole, OpsAction, boolean][] = [
    ['founder', 'quote:manage', true], ['founder', 'quote:approve', true], ['founder', 'margin:view', true],
    ['finance', 'quote:approve', false], ['ops', 'quote:approve', false],
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

// The assign picker and the queue's assignee chip both label staff by person, not by inbox.
// Format is "first name + last initial" — short enough for a queue row, and unambiguous
// across a 3-person team in a way a bare first name would stop being if we ever hire a
// second Roshen. No stored name (nobody has signed in since profiles shipped, or a
// dev-login session) → the email local part, which is what the UI showed before.
describe('displayNameFor', () => {
  it('renders a full name as first name + last initial', () => {
    expect(displayNameFor('Roshen Wijesinghe', 'roshen@ceylonhop.com')).toBe('Roshen W.');
  });

  it('uses the LAST name part for the initial, not the middle one', () => {
    expect(displayNameFor('Geethma Devan Perera', 'geethmadevan@gmail.com')).toBe('Geethma P.');
  });

  it('leaves a single-word name alone — there is no last initial to add', () => {
    expect(displayNameFor('Dasis', 'dasis@ceylonhop.com')).toBe('Dasis');
  });

  it('falls back to the email local part when no name is stored', () => {
    expect(displayNameFor(null, 'dasis@ceylonhop.com')).toBe('dasis');
    expect(displayNameFor(undefined, 'dasis@ceylonhop.com')).toBe('dasis');
  });

  it('treats a blank or whitespace-only name as no name', () => {
    expect(displayNameFor('   ', 'dasis@ceylonhop.com')).toBe('dasis');
  });

  it('tolerates untidy spacing in the stored name', () => {
    expect(displayNameFor('  Roshen   Wijesinghe  ', 'roshen@ceylonhop.com')).toBe('Roshen W.');
  });

  it('never returns an empty label, even with nothing to work from', () => {
    expect(displayNameFor(null, '')).toBe('unknown');
  });
});

it('approverOpsUsers returns only quote:approve holders (founders)', () => {
  const raw = 'f@x.com:founder,fin@x.com:finance,op@x.com:ops';
  expect(approverOpsUsers(raw).map((u) => u.email)).toEqual(['f@x.com']);
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
  it('round-trips the optional display name (Google profile → avatar initials)', () => {
    const tok = signSession({ email: 'a@x.com', exp: 2000, name: 'Sandra Wolker' }, secret);
    expect(verifySession(tok, secret, 1000)).toEqual({ email: 'a@x.com', exp: 2000, name: 'Sandra Wolker' });
    // Legacy cookies minted before `name` existed must stay valid (no forced logout).
    const legacy = signSession({ email: 'a@x.com', exp: 2000 }, secret);
    expect(verifySession(legacy, secret, 1000)).toEqual({ email: 'a@x.com', exp: 2000 });
  });

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
