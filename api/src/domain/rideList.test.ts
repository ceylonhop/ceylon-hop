import { describe, it, expect } from 'vitest';
import {
  CreateListInput,
  JoinInput,
  cutoffAt,
  policyForCorridor,
  popularTime,
  committedSeats,
  routeInitials,
  makeCode,
  SLOT_TIMES,
  type RideMember,
} from './rideList';

const member = (over: Partial<RideMember> = {}): RideMember => ({
  id: 'm', listId: 'l', position: 1, sub: 's', firstName: 'A', country: 'LK', email: 'a@x.com',
  photoUrl: null, preferredTime: null, seats: 1, preapprovalRef: null, status: 'held',
  joinedAt: new Date('2026-07-01T00:00:00Z'), ...over,
});

describe('CreateListInput', () => {
  it('accepts from+to with a valid ISO date and slot', () => {
    const r = CreateListInput.safeParse({ from: 'Ella', to: 'Mirissa', date: '2026-08-08', slot: 'morning' });
    expect(r.success).toBe(true);
  });
  it('accepts a corridorId instead of from/to', () => {
    expect(CreateListInput.safeParse({ corridorId: 'ella-south', date: '2026-08-08', slot: 'afternoon' }).success).toBe(true);
  });
  it('rejects when neither corridorId nor from+to is given', () => {
    expect(CreateListInput.safeParse({ date: '2026-08-08', slot: 'morning' }).success).toBe(false);
  });
  it('rejects an impossible date (bypass of the no-past-date rule)', () => {
    expect(CreateListInput.safeParse({ from: 'Ella', to: 'Mirissa', date: '2026-13-45', slot: 'morning' }).success).toBe(false);
  });
  it('rejects a bad slot', () => {
    expect(CreateListInput.safeParse({ from: 'Ella', to: 'Mirissa', date: '2026-08-08', slot: 'evening' }).success).toBe(false);
  });
});

describe('JoinInput', () => {
  it('defaults seats to 1', () => {
    const r = JoinInput.parse({});
    expect(r.seats).toBe(1);
  });
  it('caps a group at 4 seats', () => {
    expect(JoinInput.safeParse({ seats: 5 }).success).toBe(false);
  });
});

describe('cutoffAt', () => {
  it('closes 48h before the window start in Asia/Colombo', () => {
    // morning window starts 07:00 +05:30 on 2026-08-08; minus 48h ⇒ 2026-08-06 01:30 UTC
    expect(cutoffAt('2026-08-08', 'morning').toISOString()).toBe('2026-08-06T01:30:00.000Z');
  });
});

describe('policyForCorridor', () => {
  it('defaults to 4 names / 6 seats', () => {
    expect(policyForCorridor('hill-line')).toEqual({ minSeats: 4, capacity: 6 });
  });
});

describe('popularTime', () => {
  it('returns the most-preferred time in the slot', () => {
    expect(popularTime(['08:00', '09:00', '09:00'], 'morning')).toBe('09:00');
  });
  it('falls back to the middle of the window with no preferences', () => {
    expect(popularTime([null, undefined, 'flex'], 'morning')).toBe(SLOT_TIMES.morning[1]);
  });
});

describe('committedSeats', () => {
  it('counts held and charged members, ignores scratched/failed', () => {
    const members = [
      member({ seats: 1, status: 'held' }),
      member({ seats: 2, status: 'charged' }),
      member({ seats: 1, status: 'scratched' }),
      member({ seats: 1, status: 'charge_failed' }),
    ];
    expect(committedSeats(members)).toBe(3);
  });
});

describe('code generation', () => {
  it('builds route initials from place names', () => {
    expect(routeInitials('Ella', 'Mirissa')).toBe('EM');
    expect(routeInitials('Colombo Airport (CMB)', 'Sigiriya / Dambulla')).toBe('CS');
  });
  it('formats a public code', () => {
    expect(makeCode('Ella', 'Mirissa', '4821')).toBe('EM-4821');
  });
});
