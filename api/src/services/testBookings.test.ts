import { describe, it, expect } from 'vitest';
import { isTeamEmail, parseTeamEmails } from './testBookings';

describe('parseTeamEmails', () => {
  it('normalizes a comma-separated list to a lower-cased, trimmed set', () => {
    expect(parseTeamEmails(' Owner@CeylonHop.com , ops@ceylonhop.com ,, ')).toEqual(
      new Set(['owner@ceylonhop.com', 'ops@ceylonhop.com']),
    );
  });
  it('empty / whitespace / undefined → empty set', () => {
    expect(parseTeamEmails('')).toEqual(new Set());
    expect(parseTeamEmails('   ')).toEqual(new Set());
    expect(parseTeamEmails(undefined)).toEqual(new Set());
  });
});

describe('isTeamEmail', () => {
  const team = parseTeamEmails('owner@ceylonhop.com');
  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(isTeamEmail('Owner@CeylonHop.com', team)).toBe(true);
    expect(isTeamEmail('  owner@ceylonhop.com \n', team)).toBe(true);
  });
  it('is false for a customer, and for a null / undefined / blank email', () => {
    expect(isTeamEmail('maya@example.com', team)).toBe(false);
    expect(isTeamEmail(null, team)).toBe(false);
    expect(isTeamEmail(undefined, team)).toBe(false);
    expect(isTeamEmail('', team)).toBe(false);
  });
  it('is always false against an empty set (feature inert when unset)', () => {
    expect(isTeamEmail('owner@ceylonhop.com', new Set())).toBe(false);
  });
});
