import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { FakeEmailAdapter } from '../adapters/email';
import { InMemoryNotificationLogRepo } from '../db/notificationLogRepo';
import { issueSessionCookie } from '../lib/opsMiddleware';

const auth = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };

async function hdr(extra: Record<string, string> = {}) {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, 'f@x.com', 'sek', Date.now()); return ctx.text('ok'); });
  const cookie = (await c.request('/')).headers.get('set-cookie')!.split(';')[0];
  return { cookie, 'content-type': 'application/json', ...extra };
}

// Relative dates: a fixed calendar date in a test is a time bomb.
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('POST /admin/ops/bookings/:id/schedule', () => {
  let app: ReturnType<typeof createApp>;
  let bookings: InMemoryBookingRepo;
  let rideOps: InMemoryRideOpsRepo;
  let email: FakeEmailAdapter;
  let bid: string;

  beforeEach(async () => {
    bookings = new InMemoryBookingRepo();
    rideOps = new InMemoryRideOpsRepo();
    email = new FakeEmailAdapter();
    app = createApp({ bookings, rideOps, email, auth, adminApiKey: 'adminkey' });
    const b = await bookings.create({
      mode: 'single', total: 12100, amountDueNow: 12100, currency: 'USD',
      input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1,
        customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' } },
    });
    bid = b.id;
    await bookings.setStatus(bid, 'payment_pending');
    await bookings.setStatus(bid, 'paid');
  });

  const post = async (body: unknown, extra: Record<string, string> = {}, id = bid) =>
    app.request(`/admin/ops/bookings/${id}/schedule`, { method: 'POST', headers: await hdr(extra), body: JSON.stringify(body) });

  const blank = { date: null, time: null };

  it('fills a blank date/time, emails the customer and shows the change in the detail', async () => {
    const date = inDays(10);
    const res = await post({ date, time: '09:00', expected: blank, notifyCustomer: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ date, time: '09:00', emailed: true, driverNotified: false });
    expect(email.sent.map((m) => m.subject)).toContain(`Your pickup is set — ${(await bookings.get(bid))!.reference}`);
    const detail = await (await app.request(`/admin/ops/bookings/${bid}`, { headers: await hdr() })).json();
    expect(detail.booking.input.date).toBe(date);
    expect(detail.scheduleEvents).toHaveLength(1);
    expect(detail.scheduleEvents[0]).toMatchObject({ toDate: date, toTime: '09:00', actorType: 'staff', actorId: 'f@x.com' });
  });

  it('does not email when the operator unticks it', async () => {
    const res = await post({ date: inDays(10), time: null, expected: blank, notifyCustomer: false });
    expect((await res.json()).emailed).toBe(false);
    expect(email.sent).toHaveLength(0);
  });

  // The operator reads `emailed` as "the customer knows", so it must mean delivered. With
  // notifications switched off the guard holds the email back without throwing.
  it('reports emailed:false when the email is held back, and keeps the change', async () => {
    app = createApp({ bookings, rideOps, email, auth, adminApiKey: 'adminkey', emailPolicy: { enabled: false } });
    const date = inDays(10);
    const res = await post({ date, time: '09:00', expected: blank, notifyCustomer: true });
    expect(res.status).toBe(200);
    expect((await res.json()).emailed).toBe(false);
    expect(email.sent).toHaveLength(0);
    expect((await bookings.get(bid))!.input).toMatchObject({ date, time: '09:00' });
  });

  it('reports emailed:false when the send throws, and keeps the change', async () => {
    app = createApp({ bookings, rideOps, email: { send: async () => { throw new Error('provider down'); } }, auth, adminApiKey: 'adminkey' });
    const date = inDays(10);
    const res = await post({ date, time: null, expected: blank, notifyCustomer: true });
    expect(res.status).toBe(200);
    expect((await res.json()).emailed).toBe(false);
    expect((await bookings.get(bid))!.input).toMatchObject({ date });
  });

  it('409s a stale edit and returns the current value', async () => {
    await post({ date: inDays(10), time: '09:00', expected: blank, notifyCustomer: false });
    const res = await post({ date: inDays(12), time: '10:00', expected: blank, notifyCustomer: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict', current: { date: inDays(10), time: '09:00' } });
  });

  it('400s a past date and a malformed body', async () => {
    expect((await (await post({ date: inDays(-1), time: null, expected: blank, notifyCustomer: false })).json()).error).toBe('past');
    expect((await post({ date: inDays(10) })).status).toBe(400);
  });

  it('409s a booking that is not paid yet', async () => {
    const b = await bookings.create({
      mode: 'single', total: 100, amountDueNow: 100, currency: 'USD',
      input: { from: 'A', to: 'B', vehicleType: 'car', adults: 1, children: 0, bags: 0,
        customer: { firstName: 'X', email: 'x@x.com', whatsapp: '+1', country: 'US' } },
    });
    const res = await post({ date: inDays(10), time: null, expected: blank, notifyCustomer: false }, {}, b.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('not_editable');
  });

  it('404s an unknown or malformed id', async () => {
    expect((await post({ date: inDays(10), time: null, expected: blank, notifyCustomer: false }, {}, '00000000-0000-4000-8000-0000000000ff')).status).toBe(404);
    expect((await post({ date: inDays(10), time: null, expected: blank, notifyCustomer: false }, {}, 'not-a-uuid')).status).toBe(404);
  });

  it('tells the operator when a driver already has the job', async () => {
    await rideOps.setStatus(bid, 'vehicle_confirmed');
    const res = await post({ date: inDays(10), time: '09:00', expected: blank, notifyCustomer: false });
    expect((await res.json()).driverNotified).toBe(true);
  });

  it('refuses a cross-site request (CSRF)', async () => {
    const res = await post({ date: inDays(10), time: null, expected: blank, notifyCustomer: false }, { 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
  });

  it('shows which details reminders went out', async () => {
    const log = new InMemoryNotificationLogRepo();
    app = createApp({ bookings, rideOps, email, notificationLog: log, auth, adminApiKey: 'adminkey' });
    await log.markSent(bid, 'details_reminder_1');
    const detail = await (await app.request(`/admin/ops/bookings/${bid}`, { headers: await hdr() })).json();
    expect(detail.reminders.map((r: { kind: string }) => r.kind)).toEqual(['details_reminder_1']);
  });
});
