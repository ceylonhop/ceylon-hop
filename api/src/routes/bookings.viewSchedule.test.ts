import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { FakeEmailAdapter } from '../adapters/email';
import { FakeAlertAdapter } from '../adapters/alerts';
import { signBookingToken } from '../lib/bookingToken';

const SECRET = 'test-link-secret';
// Relative dates: a fixed calendar date in a test is a time bomb.
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('POST /bookings/view/schedule — the customer fills a blank pickup (Phase 4)', () => {
  let app: ReturnType<typeof createApp>;
  let bookings: InMemoryBookingRepo;
  let email: FakeEmailAdapter;
  let alerts: FakeAlertAdapter;
  let bid: string;
  let token: string;

  async function paidBooking(input: Record<string, unknown> = {}) {
    const b = await bookings.create({
      mode: 'single', total: 12400, amountDueNow: 12400, currency: 'USD',
      input: { from: 'Colombo Airport (CMB)', to: 'Ella', vehicleType: 'car', adults: 2, children: 0, bags: 2,
        customer: { firstName: 'Sam', lastName: 'Perera', email: 's@x.com', whatsapp: '+447700900000', country: 'GB' }, ...input },
    });
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    return b.id;
  }

  beforeEach(async () => {
    bookings = new InMemoryBookingRepo();
    email = new FakeEmailAdapter();
    alerts = new FakeAlertAdapter();
    app = createApp({ bookings, email, alerts, bookingLinkSecret: SECRET, bookingBaseUrl: 'https://ceylonhop.com' });
    bid = await paidBooking();
    token = signBookingToken(bid, SECRET);
  });

  const post = (body: unknown, t: string | null = token) =>
    app.request('/bookings/view/schedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
      body: JSON.stringify(body),
    });

  it('fills both blanks, records the customer as the actor, emails the customer and the team', async () => {
    const date = inDays(14);
    const res = await post({ date, time: '09:00' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.view).toMatchObject({ date, time: '09:00', scheduleSetBy: 'customer' });
    expect(body.emailed).toBe(true);
    const events = await bookings.listScheduleEvents(bid);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromDate: null, fromTime: null, toDate: date, toTime: '09:00', actorType: 'customer', actorId: 'manage_link' });
    expect(email.sent.map((m) => m.subject)).toContain(`Your pickup is set — ${body.view.reference}`);
    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0].email?.subject.startsWith(`Date set: ${body.view.reference}`)).toBe(true);
  });

  it('lets the time be added later, once', async () => {
    const date = inDays(14);
    expect((await post({ date, time: null })).status).toBe(200);
    const res = await post({ date: null, time: '10:00' });
    expect(res.status).toBe(200);
    expect((await res.json()).view).toMatchObject({ date, time: '10:00' });
    expect(await bookings.listScheduleEvents(bid)).toHaveLength(2);
  });

  it('never moves a value that is already set (409 already_set with the current value)', async () => {
    const date = inDays(14);
    await post({ date, time: '09:00' });
    const res = await post({ date: inDays(15), time: '09:00' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_set', current: { date, time: '09:00' } });
    expect(await bookings.listScheduleEvents(bid)).toHaveLength(1);
  });

  it('binds the customer to 12 h notice (ops is not)', async () => {
    const res = await post({ date: inDays(0), time: '00:00' });
    expect(res.status).toBe(400);
    expect(['past', 'too_soon']).toContain((await res.json()).error);
  });

  it('400s an empty fill, a time with no date, and a malformed body', async () => {
    expect((await (await post({ date: null, time: null })).json()).error).toBe('nothing_to_set');
    expect((await (await post({ date: null, time: '09:00' })).json()).error).toBe('date_required');
    expect((await post({ date: 5 })).status).toBe(400);
  });

  it('401s without a valid manage token', async () => {
    expect((await post({ date: inDays(14), time: null }, null)).status).toBe(401);
    expect((await post({ date: inDays(14), time: null }, 'forged')).status).toBe(401);
  });

  it('409s a booking that is not paid', async () => {
    const b = await bookings.create({
      mode: 'single', total: 100, amountDueNow: 100, currency: 'USD',
      input: { from: 'A', to: 'B', vehicleType: 'car', adults: 1, children: 0, bags: 0,
        customer: { firstName: 'X', lastName: 'Y', email: 'x@x.com', whatsapp: '+1', country: 'US' } },
    });
    const res = await post({ date: inDays(14), time: null }, signBookingToken(b.id, SECRET));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('not_editable');
  });

  it('still saves when both emails fail', async () => {
    email.send = async () => { throw new Error('smtp down'); };
    alerts.send = async () => { throw new Error('alerts down'); };
    const res = await post({ date: inDays(14), time: '09:00' });
    expect(res.status).toBe(200);
    expect((await res.json()).emailed).toBe(false);
  });
});

describe('GET /bookings/view says who set the pickup', () => {
  it('is absent until someone changes it, then names the latest actor', async () => {
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ bookings, bookingLinkSecret: SECRET });
    const b = await bookings.create({
      mode: 'single', total: 100, amountDueNow: 100, currency: 'USD',
      input: { from: 'Kandy', to: 'Ella', vehicleType: 'car', adults: 1, children: 0, bags: 0,
        customer: { firstName: 'X', lastName: 'Y', email: 'x@x.com', whatsapp: '+1', country: 'US' } },
    });
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    const view = async () => (await app.request(`/bookings/view?t=${signBookingToken(b.id, SECRET)}`)).json();
    expect((await view()).scheduleSetBy).toBeUndefined();
    await bookings.setSchedule(b.id, { date: inDays(14), time: null, expected: { date: null, time: null }, actor: { type: 'staff', id: 'f@x.com' } });
    expect((await view()).scheduleSetBy).toBe('staff');
  });
});
