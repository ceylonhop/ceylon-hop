import { describe, it, expect } from 'vitest';
import { rideListToOpsRow, boardRowsForOps } from './opsBoardView';
import type { RideList, RideMember } from '../domain/rideList';

// ────────────────────────────────────────────────────────────────────────────
//  A ride-board van is not a booking — it lives in its own tables and has no
//  booking/quote/payment row. These tests pin the read-time projection that
//  lets ops SEE one, without any of it being written back.
//
//  The contract ops cares about: one van = one row, and the row tells you who
//  is on it, when it leaves, and whether it is actually going to run.
// ────────────────────────────────────────────────────────────────────────────

const AT = (s: string) => new Date(s);

function list(over: Partial<RideList> = {}): RideList {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'EM-4821',
    corridorId: 'south-coast',
    fromPlace: 'Ella',
    toPlace: 'Mirissa',
    date: '2026-08-14',
    slot: 'morning',
    lockedTime: null,
    minSeats: 3,
    capacity: 6,
    seatPrice: 2450,
    status: 'gathering',
    note: null,
    cutoffAt: AT('2026-08-12T12:30:00Z'),
    createdBy: 'sub-1',
    createdAt: AT('2026-08-01T00:00:00Z'),
    updatedAt: AT('2026-08-01T00:00:00Z'),
    ...over,
  };
}

let seq = 0;
function member(over: Partial<RideMember> = {}): RideMember {
  seq += 1;
  return {
    id: `m-${seq}`,
    listId: '11111111-1111-4111-8111-111111111111',
    position: seq,
    sub: `sub-${seq}`,
    firstName: 'Nimal',
    country: 'LK',
    email: `n${seq}@example.com`,
    photoUrl: null,
    preferredTime: null,
    seats: 1,
    preapprovalRef: 'pre-1',
    status: 'held',
    joinedAt: AT('2026-08-01T00:00:00Z'),
    ...over,
  };
}

describe('rideListToOpsRow', () => {
  it('projects one van as one row, namespaced so it cannot collide with a booking id', () => {
    const row = rideListToOpsRow({ list: list(), members: [member()] }, { currency: 'USD' });
    expect(row.source).toBe('ride_board');
    expect(row.id).toBe('board:EM-4821');
    expect(row.reference).toBe('EM-4821');
    expect(row.mode).toBe('board');
    expect(row.route).toBe('Ella → Mirissa');
  });

  it('counts seats, not people — one member bringing three seats fills the threshold', () => {
    const row = rideListToOpsRow(
      { list: list(), members: [member({ seats: 3 })] },
      { currency: 'USD' },
    );
    expect(row.pax).toBe(3);
    expect(row.board?.seatsCommitted).toBe(3);
  });

  it('ignores scratched members in seats, money, and the manifest', () => {
    const row = rideListToOpsRow(
      {
        list: list(),
        members: [
          member({ firstName: 'Ann', seats: 2 }),
          member({ firstName: 'Bo', seats: 2, status: 'scratched' }),
        ],
      },
      { currency: 'USD' },
    );
    expect(row.pax).toBe(2);
    expect(row.amount).toBe(2450 * 2);
    expect(row.board?.members.map((m) => m.firstName)).toEqual(['Ann']);
  });

  it('prices the row at seat price × committed seats', () => {
    const row = rideListToOpsRow(
      { list: list({ seatPrice: 2450 }), members: [member({ seats: 2 }), member()] },
      { currency: 'USD' },
    );
    expect(row.amount).toBe(2450 * 3);
    expect(row.currency).toBe('USD');
  });

  it('names the row after the starter and the size of the group', () => {
    const row = rideListToOpsRow(
      {
        list: list(),
        members: [member({ firstName: 'Ann', position: 1 }), member({ firstName: 'Bo', position: 2 })],
      },
      { currency: 'USD' },
    );
    expect(row.customerFirstName).toBe('Ann');
    expect(row.customerName).toBe('Ann +1');
  });

  it('a solo starter reads as just their name', () => {
    const row = rideListToOpsRow(
      { list: list(), members: [member({ firstName: 'Ann' })] },
      { currency: 'USD' },
    );
    expect(row.customerName).toBe('Ann');
  });

  // ── the stage mapping: what ops needs to DO about this van ──
  it('a gathering van gets its own stage, not a booking stage', () => {
    const row = rideListToOpsRow({ list: list({ status: 'gathering' }), members: [member()] }, { currency: 'USD' });
    expect(row.stage).toBe('gathering');
    expect(row.paymentStatus).toBe('unpaid');
  });

  it('a confirmed van lands in "needs vehicle" — it is paid and wants a van assigned', () => {
    const row = rideListToOpsRow(
      {
        list: list({ status: 'confirmed', lockedTime: '08:00' }),
        members: [member({ status: 'charged' }), member({ status: 'charged' }), member({ status: 'charged' })],
      },
      { currency: 'USD' },
    );
    expect(row.stage).toBe('paid');
    expect(row.paymentStatus).toBe('paid');
    expect(row.travelTime).toBe('08:00');
  });

  it('keeps a failed charge on the manifest but not in the seat count', () => {
    const row = rideListToOpsRow(
      {
        list: list({ status: 'confirmed' }),
        members: [
          member({ firstName: 'Ann', status: 'charged', seats: 2 }),
          member({ firstName: 'Bo', status: 'charge_failed', seats: 2 }),
        ],
      },
      { currency: 'USD' },
    );
    // Bo pays for nothing and holds no seat, but ops still has to ring Bo.
    expect(row.pax).toBe(2);
    expect(row.amount).toBe(2450 * 2);
    expect(row.board?.members.map((m) => m.firstName)).toEqual(['Ann', 'Bo']);
  });

  it('a confirmed van with a failed charge is still unpaid', () => {
    const row = rideListToOpsRow(
      {
        list: list({ status: 'confirmed' }),
        members: [member({ status: 'charged' }), member({ status: 'charge_failed' })],
      },
      { currency: 'USD' },
    );
    expect(row.paymentStatus).toBe('unpaid');
  });

  it('falls back to the slot window when no departure time is locked yet', () => {
    const row = rideListToOpsRow(
      { list: list({ slot: 'afternoon', lockedTime: null }), members: [member()] },
      { currency: 'USD' },
    );
    expect(row.travelTime).toBe('13:00');
  });

  it('carries the threshold so ops can see how close the van is to running', () => {
    const row = rideListToOpsRow(
      { list: list({ minSeats: 3, capacity: 6 }), members: [member({ seats: 2 })] },
      { currency: 'USD' },
    );
    expect(row.board).toMatchObject({ seatsCommitted: 2, minSeats: 3, capacity: 6, code: 'EM-4821' });
  });

  it('never leaks a member email or subject into the ops row', () => {
    const row = rideListToOpsRow(
      { list: list(), members: [member({ email: 'secret@example.com', sub: 'google-123' })] },
      { currency: 'USD' },
    );
    expect(JSON.stringify(row)).not.toContain('secret@example.com');
    expect(JSON.stringify(row)).not.toContain('google-123');
  });

  it('surfaces the list note as ops notes', () => {
    const row = rideListToOpsRow(
      { list: list({ note: 'Wants a big boot' }), members: [member()] },
      { currency: 'USD' },
    );
    expect(row.opsNotes).toBe('Wants a big boot');
  });
});

describe('boardRowsForOps', () => {
  it('drops vans nobody is on — an empty van is not a row', () => {
    const rows = boardRowsForOps(
      [
        { list: list({ code: 'AA-1' }), members: [] },
        { list: list({ code: 'BB-2' }), members: [member()] },
      ],
      { currency: 'USD' },
    );
    expect(rows.map((r) => r.reference)).toEqual(['BB-2']);
  });

  it('drops a van whose every member scratched off', () => {
    const rows = boardRowsForOps(
      [{ list: list({ code: 'AA-1' }), members: [member({ status: 'scratched' })] }],
      { currency: 'USD' },
    );
    expect(rows).toEqual([]);
  });

  it('keeps a van with a single name on it — one person is enough to show up', () => {
    const rows = boardRowsForOps(
      [{ list: list({ code: 'AA-1' }), members: [member()] }],
      { currency: 'USD' },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].pax).toBe(1);
  });
});
