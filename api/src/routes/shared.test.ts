import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakePaymentAdapter } from '../adapters/payments';
import { FakeEmailAdapter } from '../adapters/email';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryDepartureRepo } from '../db/departureRepo';
import { nextIsoWeekday } from '../testSupport/dates';

// Anchored to "now" and weekday-preserving so neither the past-date rule nor the service-day
// schedule (corridors run Wed & Sat) ever expires these (see testSupport/dates).
const wednesday = nextIsoWeekday(3); // a shared service day
const saturday = nextIsoWeekday(6); // the corridor's other service day
const monday = nextIsoWeekday(1); // off-schedule (not a service day)

const valid = {
  corridorId: 'hill-line', // Kandy → Nuwara Eliya → Ella, $21/seat
  date: wednesday, // Wednesday — a shared service day (corridors run Wed & Sat)
  time: '08:00',
  seats: 2,
  customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

async function postShared(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/bookings/shared', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /bookings/shared', () => {
  it('books a shared seat (201) priced seats × corridor price', async () => {
    const app = createApp();
    const res = await postShared(app, valid);
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.mode).toBe('shared');
    expect(b.total).toBe(4200); // 2 seats × $21 (hill-line)
  });

  it('400 for an unknown corridor', async () => {
    const res = await postShared(createApp(), { ...valid, corridorId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('400 for a malformed / non-calendar date (would otherwise bypass the past-date rule)', async () => {
    // A non-ISO or impossible date is treated as "not past" by isPastIsoDate, so without
    // schema-level ISO validation it slips through with a garbage departure date.
    expect((await postShared(createApp(), { ...valid, date: '2026-13-45' })).status).toBe(400);
    expect((await postShared(createApp(), { ...valid, date: 'tomorrow' })).status).toBe(400);
  });

  it('resolves the corridor from from/to (what the website sends)', async () => {
    const app = createApp();
    const { corridorId: _omit, ...byRoute } = valid;
    void _omit;
    const res = await postShared(app, { ...byRoute, from: 'Kandy', to: 'Ella', seats: 1 });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.mode).toBe('shared');
    expect(b.input.corridorId).toBe('hill-line');
  });

  it('resolves a mid-corridor pair (neither endpoint is the corridor terminus)', async () => {
    const app = createApp();
    const { corridorId: _o2, ...byRoute } = valid;
    void _o2;
    // Negombo → Kandy both sit on airport-cultural, but neither is its first/last stop
    const res = await postShared(app, { ...byRoute, from: 'Negombo', to: 'Kandy', time: '07:30', seats: 1 });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.input.corridorId).toBe('airport-cultural');
  });

  it('400 when from/to has no matching corridor', async () => {
    const app = createApp();
    const { corridorId: _o, ...byRoute } = valid;
    void _o;
    const res = await postShared(app, { ...byRoute, from: 'Nowhere', to: 'Elsewhere' });
    expect(res.status).toBe(400);
  });

  it('409 when the departure is sold out', async () => {
    const res = await postShared(createApp(), { ...valid, seats: 13 }); // capacity is 12
    expect(res.status).toBe(409);
  });

  it('400 not_a_service_day for a date off the corridor schedule (a Monday)', async () => {
    const res = await postShared(createApp(), { ...valid, date: monday }); // Monday
    expect(res.status).toBe(400);
    const b = await res.json();
    expect(b.error).toBe('not_a_service_day');
    expect(b.message).toContain('Wed & Sat');
  });

  it('accepts a Saturday departure (the corridor’s other service day)', async () => {
    const res = await postShared(createApp(), { ...valid, date: saturday }); // Saturday
    expect(res.status).toBe(201);
  });

  it('rejects an off-schedule date before holding a seat (no phantom hold)', async () => {
    const departures = new InMemoryDepartureRepo();
    const app = createApp({ departures });
    await postShared(app, { ...valid, date: monday, seats: 12 }); // Monday, rejected
    // the Monday departure must be untouched — a full bus can still be held there directly
    const held = await departures.holdSeats({ corridorId: 'hill-line', date: monday, time: '08:00', seats: 12 });
    expect(held?.seatsBooked).toBe(12);
  });

  it('flows through checkout → webhook → paid', async () => {
    const adapter = new FakePaymentAdapter();
    const email = new FakeEmailAdapter();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ adapter, email, bookings });

    const b = await (await postShared(app, valid)).json();
    await app.request(`/bookings/${b.id}/checkout`, { method: 'POST' });
    await app.request('/webhooks/payments', {
      method: 'POST',
      body: adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency }),
    });
    const paid = await bookings.get(b.id);
    expect(paid!.status).toBe('paid');
    expect(email.sent).toHaveLength(1);
  });
});
