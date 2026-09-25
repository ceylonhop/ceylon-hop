import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryBookingCheckoutEventRepo, type BookingCheckoutEventRepo } from '../db/bookingCheckoutEventRepo';
import { issueSessionCookie } from '../lib/opsMiddleware';

// The booking drawer's "Payment attempts" block (2026-09-24): debugging a failed payment took
// SQL against booking_checkout_event. GET /admin/ops/bookings/:id now carries the log.

const auth = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };

async function hdr() {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, 'f@x.com', 'sek', Date.now()); return ctx.text('ok'); });
  const res = await c.request('/');
  return { cookie: res.headers.get('set-cookie')!.split(';')[0] };
}

const KEYS = ['action', 'at', 'attempt', 'httpStatus', 'outcome', 'reason', 'source'];

describe('GET /admin/ops/bookings/:id — checkoutEvents', () => {
  let bookings: InMemoryBookingRepo;
  let bid: string;

  beforeEach(async () => {
    bookings = new InMemoryBookingRepo();
    bid = (await bookings.create({
      mode: 'single', total: 12100, amountDueNow: 12100, currency: 'USD',
      input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1, date: '2026-06-22', time: '09:00',
        customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34', country: 'ES' } },
    })).id;
  });

  const detail = async (checkoutEvents?: BookingCheckoutEventRepo) => {
    const app = createApp({
      bookings, payments: new InMemoryPaymentRepo(), rideOps: new InMemoryRideOpsRepo(), auth, adminApiKey: 'k',
      ...(checkoutEvents ? { checkoutEvents } : {}),
    });
    const res = await app.request(`/admin/ops/bookings/${bid}`, { headers: await hdr() });
    expect(res.status).toBe(200);
    return res.json() as Promise<{ checkoutEvents: Array<Record<string, unknown>> }>;
  };

  it('returns the events oldest first, without the user agent', async () => {
    const log = new InMemoryBookingCheckoutEventRepo();
    const t0 = Date.parse('2026-09-24T10:00:00Z');
    await log.record({ action: 'checkout', outcome: 'succeeded', source: 'server', bookingId: bid, attempt: 1, httpStatus: 200, ua: 'Mozilla/5.0 secret' }, new Date(t0 + 1000));
    await log.record({ action: 'create', outcome: 'succeeded', source: 'server', bookingId: bid, httpStatus: 201, ua: 'Mozilla/5.0 secret' }, new Date(t0));
    await log.record({ action: 'gateway', outcome: 'error', source: 'client', bookingId: bid, reason: 'card declined' }, new Date(t0 + 2000));
    await log.record({ action: 'create', outcome: 'succeeded', source: 'server', bookingId: 'someone-else' }, new Date(t0));

    const body = await detail(log);
    expect(body.checkoutEvents.map((e) => e.action)).toEqual(['create', 'checkout', 'gateway']);
    for (const e of body.checkoutEvents) expect(Object.keys(e).sort()).toEqual(KEYS);
    expect(body.checkoutEvents[0]).toEqual({
      at: '2026-09-24T10:00:00.000Z', action: 'create', outcome: 'succeeded', reason: null, source: 'server', attempt: null, httpStatus: 201,
    });
    expect(body.checkoutEvents[1]).toMatchObject({ action: 'checkout', attempt: 1, httpStatus: 200 });
    expect(body.checkoutEvents[2]).toMatchObject({ action: 'gateway', outcome: 'error', reason: 'card declined', source: 'client' });
    expect(JSON.stringify(body)).not.toContain('Mozilla');
  });

  it('caps at the latest 50, still oldest first', async () => {
    const log = new InMemoryBookingCheckoutEventRepo();
    const t0 = Date.parse('2026-09-24T10:00:00Z');
    for (let i = 0; i < 60; i++) {
      await log.record({ action: 'checkout', outcome: 'succeeded', source: 'server', bookingId: bid, attempt: i + 1 }, new Date(t0 + i * 1000));
    }
    const body = await detail(log);
    expect(body.checkoutEvents).toHaveLength(50);
    expect(body.checkoutEvents[0].attempt).toBe(11);
    expect(body.checkoutEvents[49].attempt).toBe(60);
  });

  it('is [] when no repo is wired', async () => {
    expect((await detail()).checkoutEvents).toEqual([]);
  });

  it('is [] (not a failed drawer) when the log cannot be read', async () => {
    const broken: BookingCheckoutEventRepo = {
      record: () => Promise.resolve(),
      listByBookingId: () => Promise.reject(new Error('db down')),
    };
    expect((await detail(broken)).checkoutEvents).toEqual([]);
  });
});
