// Per-leg ops steps (spec 2026-11-19), step 2: the leg endpoints and the per-leg data on the queue
// row and the booking detail. Reproduced 2026-11-18: with one status per booking, marking leg 1 of
// a 3-leg trip completed closed the whole trip.
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import { issueSessionCookie } from '../lib/opsMiddleware';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';

const auth = { opsUsers: 'f@x.com:founder,o@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };
async function hdr(email = 'o@x.com') {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, email, 'sek', Date.now()); return ctx.text('ok'); });
  const cookie = (await c.request('/')).headers.get('set-cookie')!.split(';')[0]!;
  return { cookie, 'content-type': 'application/json' };
}

// Relative dates: a fixed calendar date in a test is a time bomb.
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };

// Airport → Kandy → Ella → Mirissa: three legs we drive.
const trip = (over: Record<string, unknown> = {}): NewBooking => ({
  mode: 'trip',
  input: {
    stops: ['Colombo Airport (CMB)', 'Kandy', 'Ella', 'Mirissa'], nights: [2, 2, 2, 0],
    dates: [inDays(10), inDays(12), inDays(14)], pax: 2, vehicleType: 'car', serviceType: 'private', customer, ...over,
  },
  total: 16100, amountDueNow: 16100, currency: 'USD',
} as NewBooking);
const single = (): NewBooking => ({
  mode: 'single',
  input: { from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2, date: inDays(10), time: '09:00', customer },
  total: 12100, amountDueNow: 12100, currency: 'USD',
});

type LegOps = { legId: string; seq: number; from: string; to: string; date: string | null; stage: string; vehiclePhotoReceived: boolean; customerUpdated: boolean };
type Detail = { booking: { status: string }; ops: { fulfilmentStatus: string }; legs: Array<{ id: string; kind: string }>; legOps: LegOps[] };
const PATH = ['vehicle_confirmed', 'pickup_confirmed', 'on_trip', 'completed'] as const;

describe('per-leg ops steps: the ops API', () => {
  let bookings: InMemoryBookingRepo;
  let rideOps: InMemoryRideOpsRepo;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    bookings = new InMemoryBookingRepo();
    rideOps = new InMemoryRideOpsRepo();
    app = createApp({ bookings, rideOps, auth });
  });

  const paid = async (nb: NewBooking) => {
    const b = await bookings.create(nb);
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    return b;
  };
  const detail = async (id: string): Promise<Detail> =>
    (await app.request(`/admin/ops/bookings/${id}`, { headers: await hdr() })).json();
  const setLeg = async (id: string, legId: string, to: string) =>
    app.request(`/admin/ops/bookings/${id}/legs/${legId}/status`, { method: 'POST', headers: await hdr(), body: JSON.stringify({ to }) });
  const walk = async (id: string, legId: string) => {
    for (const to of PATH) expect((await setLeg(id, legId, to)).status).toBe(200);
  };

  it('the booking detail lists each driven leg with its own stage, starting at paid', async () => {
    const b = await paid(trip());
    const d = await detail(b.id);
    expect(d.legOps.map((l) => [l.from, l.to, l.date, l.stage])).toEqual([
      ['Colombo Airport (CMB)', 'Kandy', inDays(10), 'paid'],
      ['Kandy', 'Ella', inDays(12), 'paid'],
      ['Ella', 'Mirissa', inDays(14), 'paid'],
    ]);
  });

  it('completing leg 1 does not complete the booking: the later legs are still to run', async () => {
    const b = await paid(trip());
    const [first] = (await detail(b.id)).legOps;
    await walk(b.id, first.legId);
    const d = await detail(b.id);
    expect(d.legOps.map((l) => l.stage)).toEqual(['completed', 'paid', 'paid']);
    expect(d.booking.status).toBe('in_progress');
  });

  it('the booking follows the legs: confirmed, in progress, and completed only after the last leg', async () => {
    const b = await paid(trip());
    const legs = (await detail(b.id)).legOps;
    await setLeg(b.id, legs[0].legId, 'vehicle_confirmed');
    expect((await detail(b.id)).booking.status).toBe('confirmed');
    await setLeg(b.id, legs[0].legId, 'pickup_confirmed');
    await setLeg(b.id, legs[0].legId, 'on_trip');
    expect((await detail(b.id)).booking.status).toBe('in_progress');
    await setLeg(b.id, legs[0].legId, 'completed');
    await walk(b.id, legs[1].legId);
    expect((await detail(b.id)).booking.status).toBe('in_progress');
    await walk(b.id, legs[2].legId);
    expect((await detail(b.id)).booking.status).toBe('completed');
  });

  it('confirming a later leg early does not confirm the booking', async () => {
    const b = await paid(trip());
    const legs = (await detail(b.id)).legOps;
    expect((await setLeg(b.id, legs[2].legId, 'vehicle_confirmed')).status).toBe(200);
    const d = await detail(b.id);
    expect(d.legOps.map((l) => l.stage)).toEqual(['paid', 'paid', 'vehicle_confirmed']);
    expect(d.booking.status).toBe('paid');
  });

  it('refuses an illegal skip', async () => {
    const b = await paid(trip());
    const [first] = (await detail(b.id)).legOps;
    const res = await setLeg(b.id, first.legId, 'completed');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'illegal_transition' });
  });

  it('refuses no_show on a leg: a no-show closes the whole booking', async () => {
    const b = await paid(trip());
    const [first] = (await detail(b.id)).legOps;
    expect((await setLeg(b.id, first.legId, 'no_show')).status).toBe(400);
  });

  it("404s a leg that is not this booking's, and the stretch the customer travels themselves", async () => {
    const a = await paid(trip());
    const other = await paid(trip());
    const otherLeg = (await detail(other.id)).legOps[0].legId;
    expect((await setLeg(a.id, otherLeg, 'vehicle_confirmed')).status).toBe(404);

    const gapped = await paid(trip({ dates: [inDays(10), '', inDays(14)], gaps: [1] }));
    const d = await detail(gapped.id);
    expect(d.legOps).toHaveLength(2);
    const gap = d.legs.find((l) => l.kind === 'gap')!;
    const res = await setLeg(gapped.id, gap.id, 'vehicle_confirmed');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'leg_not_found' });
  });

  it('keeps the booking-level status for a single transfer and a chauffeur trip', async () => {
    const s = await paid(single());
    const sd = await detail(s.id);
    expect(sd.legOps).toEqual([]);
    const res = await setLeg(s.id, sd.legs[0].id, 'vehicle_confirmed');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_per_leg' });

    const c = await paid(trip({ serviceType: 'chauffeur' }));
    const cd = await detail(c.id);
    expect(cd.legOps).toEqual([]);
    expect((await setLeg(c.id, cd.legs[0].id, 'vehicle_confirmed')).status).toBe(409);
  });

  it('refuses to move a leg of a cancelled booking', async () => {
    const b = await paid(trip());
    const [first] = (await detail(b.id)).legOps;
    await bookings.setStatus(b.id, 'cancelled');
    const res = await setLeg(b.id, first.legId, 'vehicle_confirmed');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'booking_closed' });
  });

  it('sets the ticks on one leg only', async () => {
    const b = await paid(trip());
    const legs = (await detail(b.id)).legOps;
    const res = await app.request(`/admin/ops/bookings/${b.id}/legs/${legs[1].legId}/flags`, {
      method: 'POST', headers: await hdr(), body: JSON.stringify({ vehiclePhotoReceived: true }),
    });
    expect(res.status).toBe(200);
    expect((await detail(b.id)).legOps.map((l) => [l.vehiclePhotoReceived, l.customerUpdated])).toEqual([
      [false, false], [true, false], [false, false],
    ]);
  });

  it('needs a signed-in operator', async () => {
    const b = await paid(trip());
    const [first] = (await detail(b.id)).legOps;
    const res = await app.request(`/admin/ops/bookings/${b.id}/legs/${first.legId}/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'vehicle_confirmed' }),
    });
    expect(res.status).toBe(401);
  });

  it('the queue row carries the same per-leg stages, and none for a single transfer', async () => {
    const t = await paid(trip());
    const s = await paid(single());
    const [first] = (await detail(t.id)).legOps;
    await walk(t.id, first.legId);
    const rows: Array<{ id: string; stage: string; legOps: LegOps[] }> =
      await (await app.request('/admin/ops/bookings', { headers: await hdr() })).json();
    const row = rows.find((r) => r.id === t.id)!;
    expect(row.legOps.map((l) => l.stage)).toEqual(['completed', 'paid', 'paid']);
    expect(rows.find((r) => r.id === s.id)!.legOps).toEqual([]);
  });

  // Step 3: the queue and the old button now go by the legs.
  type Row = { id: string; stage: string; vehiclePhotoReceived: boolean; customerUpdated: boolean; legOps: LegOps[] };
  const rowFor = async (id: string): Promise<Row> =>
    ((await (await app.request('/admin/ops/bookings', { headers: await hdr() })).json()) as Row[]).find((r) => r.id === id)!;
  const setBooking = async (id: string, to: string) =>
    app.request(`/admin/ops/bookings/${id}/status`, { method: 'POST', headers: await hdr(), body: JSON.stringify({ to }) });

  it("the queue row's stage is the current leg's: back to paid once leg 1 is done", async () => {
    const b = await paid(trip());
    const legs = (await detail(b.id)).legOps;
    await setLeg(b.id, legs[0].legId, 'vehicle_confirmed');
    expect((await rowFor(b.id)).stage).toBe('vehicle_confirmed');
    await setLeg(b.id, legs[0].legId, 'pickup_confirmed');
    await setLeg(b.id, legs[0].legId, 'on_trip');
    await setLeg(b.id, legs[0].legId, 'completed');
    expect((await rowFor(b.id)).stage).toBe('paid');
    await walk(b.id, legs[1].legId);
    await walk(b.id, legs[2].legId);
    expect((await rowFor(b.id)).stage).toBe('completed');
  });

  it("the queue row's ticks are the current leg's", async () => {
    const b = await paid(trip());
    const legs = (await detail(b.id)).legOps;
    const tick = async (legId: string) => app.request(`/admin/ops/bookings/${b.id}/legs/${legId}/flags`, {
      method: 'POST', headers: await hdr(), body: JSON.stringify({ customerUpdated: true }),
    });
    await tick(legs[0].legId);
    expect((await rowFor(b.id)).customerUpdated).toBe(true);
    await walk(b.id, legs[0].legId);
    expect((await rowFor(b.id)).customerUpdated).toBe(false);
  });

  it('the booking-level button can no longer advance or complete a per-leg trip', async () => {
    const b = await paid(trip());
    const res = await setBooking(b.id, 'vehicle_confirmed');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'per_leg_trip' });
    const d = await detail(b.id);
    expect(d.ops.fulfilmentStatus).toBe('paid');
    expect(d.booking.status).toBe('paid');
  });

  it('a no-show still closes the whole trip from the booking-level button', async () => {
    const b = await paid(trip());
    const [first] = (await detail(b.id)).legOps;
    await setLeg(b.id, first.legId, 'vehicle_confirmed');
    expect((await setBooking(b.id, 'no_show')).status).toBe(200);
    expect((await rowFor(b.id)).stage).toBe('no_show');
    expect((await detail(b.id)).booking.status).toBe('no_show');
  });

  // Before per-leg steps a trip was closed with the one booking-level status. Those stay closed:
  // their legs have no rows, and reading that as "leg 1 still to do" would reopen finished trips.
  it('a trip already completed with the old single status stays closed', async () => {
    const b = await paid(trip());
    for (const to of PATH) await rideOps.setStatus(b.id, to);
    const row = await rowFor(b.id);
    expect(row.stage).toBe('completed');
    expect(row.legOps).toEqual([]);
    const d = await detail(b.id);
    expect(d.legOps).toEqual([]);
    const leg = d.legs.find((l) => l.kind === 'leg')!;
    const res = await setLeg(b.id, leg.id, 'vehicle_confirmed');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_per_leg' });
  });

  it('a single transfer and a chauffeur trip still use the booking-level button', async () => {
    const s = await paid(single());
    expect((await setBooking(s.id, 'vehicle_confirmed')).status).toBe(200);
    expect((await rowFor(s.id)).stage).toBe('vehicle_confirmed');
    const c = await paid(trip({ serviceType: 'chauffeur' }));
    expect((await setBooking(c.id, 'vehicle_confirmed')).status).toBe(200);
    expect((await rowFor(c.id)).stage).toBe('vehicle_confirmed');
  });
});
