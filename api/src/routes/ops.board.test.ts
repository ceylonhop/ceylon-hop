import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryRideListRepo } from '../db/rideListRepo';
import { issueSessionCookie } from '../lib/opsMiddleware';

// ────────────────────────────────────────────────────────────────────────────
//  Ride-board vans in the ops Bookings queue (2026-07-26).
//  One van with at least one live name = exactly one row, read-only.
// ────────────────────────────────────────────────────────────────────────────

const auth = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };

async function cookie(email: string) {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, email, 'sek', Date.now()); return ctx.text('ok'); });
  const res = await c.request('/');
  return res.headers.get('set-cookie')!.split(';')[0];
}
async function hdr() {
  return { cookie: await cookie('f@x.com'), 'content-type': 'application/json' };
}

const FUTURE = '2027-03-18';

// The repo mints the public code itself, so tests read it back off the created
// list rather than pinning a literal.
async function makeList(
  rideLists: InMemoryRideListRepo,
  over: { from?: string; to?: string; date?: string } = {},
) {
  return rideLists.createList({
    corridorId: 'south-coast',
    fromPlace: over.from ?? 'Ella',
    toPlace: over.to ?? 'Mirissa',
    date: over.date ?? FUTURE,
    slot: 'morning',
    minSeats: 3,
    capacity: 6,
    seatPrice: 2450,
    note: null,
    cutoffAt: new Date('2027-03-16T12:30:00Z'),
    createdBy: 'sub-a',
  });
}

async function join(
  rideLists: InMemoryRideListRepo,
  listId: string,
  over: { sub?: string; firstName?: string; seats?: number } = {},
) {
  return rideLists.addMember(listId, {
    sub: over.sub ?? 'sub-a',
    firstName: over.firstName ?? 'Ann',
    country: 'GB',
    email: `${over.sub ?? 'sub-a'}@example.com`,
    photoUrl: null,
    preferredTime: null,
    seats: over.seats ?? 1,
    preapprovalRef: 'pre-1',
  });
}

describe('ops bookings queue — ride-board vans', () => {
  let app: ReturnType<typeof createApp>;
  let rideLists: InMemoryRideListRepo;

  beforeEach(() => {
    rideLists = new InMemoryRideListRepo();
    app = createApp({
      bookings: new InMemoryBookingRepo(),
      rideOps: new InMemoryRideOpsRepo(),
      rideLists,
      auth,
      adminApiKey: 'adminkey',
    });
  });

  async function rows() {
    const res = await app.request('/admin/ops/bookings', { headers: await hdr() });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<Record<string, unknown>>;
  }

  it('shows a van with one name on it as a single row', async () => {
    const list = await makeList(rideLists);
    await join(rideLists, list.id);

    const all = await rows();
    const board = all.filter((r) => r.source === 'ride_board');
    expect(board).toHaveLength(1);
    expect(board[0].reference).toBe(list.code);
    expect(board[0].route).toBe('Ella → Mirissa');
    expect(board[0].mode).toBe('board');
    expect(board[0].pax).toBe(1);
  });

  it('one van stays one row no matter how many people join', async () => {
    const list = await makeList(rideLists);
    await join(rideLists, list.id, { sub: 'a', firstName: 'Ann' });
    await join(rideLists, list.id, { sub: 'b', firstName: 'Bo' });
    await join(rideLists, list.id, { sub: 'c', firstName: 'Cal' });

    const board = (await rows()).filter((r) => r.source === 'ride_board');
    expect(board).toHaveLength(1);
    expect(board[0].pax).toBe(3);
    expect(board[0].customerName).toBe('Ann +2');
    expect(board[0].amount).toBe(2450 * 3);
  });

  it('hides a van nobody has joined', async () => {
    await makeList(rideLists);
    const board = (await rows()).filter((r) => r.source === 'ride_board');
    expect(board).toEqual([]);
  });

  it('drops the row when the last member scratches off', async () => {
    const list = await makeList(rideLists);
    await join(rideLists, list.id, { sub: 'a' });
    expect((await rows()).filter((r) => r.source === 'ride_board')).toHaveLength(1);

    await rideLists.removeMember(list.id, 'a');
    expect((await rows()).filter((r) => r.source === 'ride_board')).toEqual([]);
  });

  it('shows two vans as two rows', async () => {
    const a = await makeList(rideLists, { to: 'Mirissa' });
    const b = await makeList(rideLists, { to: 'Galle' });
    await join(rideLists, a.id, { sub: 'a' });
    await join(rideLists, b.id, { sub: 'b' });

    const board = (await rows()).filter((r) => r.source === 'ride_board');
    expect(board).toHaveLength(2);
    expect(board.map((r) => r.reference).sort()).toEqual([a.code, b.code].sort());
  });

  it('marks real bookings as source "booking" so the two kinds stay tellable apart', async () => {
    const bookings = new InMemoryBookingRepo();
    const listRepo = new InMemoryRideListRepo();
    const withBoth = createApp({
      bookings, rideOps: new InMemoryRideOpsRepo(), rideLists: listRepo, auth, adminApiKey: 'adminkey',
    });
    const booking = await bookings.create({
      mode: 'single', total: 12100, amountDueNow: 12100, currency: 'USD',
      input: {
        from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1,
        date: FUTURE, time: '09:00',
        customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' },
      },
    });
    await bookings.setStatus(booking.id, 'payment_pending');
    const list = await makeList(listRepo);
    await join(listRepo, list.id);

    const res = await withBoth.request('/admin/ops/bookings', { headers: await hdr() });
    const all = (await res.json()) as Array<Record<string, unknown>>;
    expect(all.filter((r) => r.source === 'booking')).toHaveLength(1);
    expect(all.filter((r) => r.source === 'ride_board')).toHaveLength(1);
  });

  it('never leaks a member email or Google subject to ops', async () => {
    const list = await makeList(rideLists);
    await join(rideLists, list.id, { sub: 'google-oauth-999' });

    const res = await app.request('/admin/ops/bookings', { headers: await hdr() });
    const body = await res.text();
    expect(body).not.toContain('google-oauth-999');
    expect(body).not.toContain('@example.com');
  });

  it('requires the bookings:read capability like any other queue row', async () => {
    const list = await makeList(rideLists);
    await join(rideLists, list.id);
    const res = await app.request('/admin/ops/bookings'); // no session
    expect(res.status).toBe(401);
  });

  it('carries the manifest and threshold so ops can see if the van will run', async () => {
    const list = await makeList(rideLists);
    await join(rideLists, list.id, { sub: 'a', firstName: 'Ann', seats: 2 });

    const board = (await rows()).filter((r) => r.source === 'ride_board');
    expect(board[0].board).toMatchObject({
      code: list.code, seatsCommitted: 2, minSeats: 3, capacity: 6,
    });
    const detail = board[0].board as { members: Array<{ firstName: string }> };
    expect(detail.members.map((m) => m.firstName)).toEqual(['Ann']);
  });

  it('still returns bookings when no ride-board repo has any lists', async () => {
    const all = await rows();
    expect(Array.isArray(all)).toBe(true);
  });
});
