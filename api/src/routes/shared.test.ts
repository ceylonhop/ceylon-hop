import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakePaymentAdapter } from '../adapters/payments';
import { FakeEmailAdapter } from '../adapters/email';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryDepartureRepo } from '../db/departureRepo';
import { nextIsoWeekday } from '../testSupport/dates';
import { sweepStaleSharedHolds } from '../services/scheduler';

// Anchored to "now" and weekday-preserving so neither the past-date rule nor the service-day
// schedule (corridors run Wed & Sat) ever expires these (see testSupport/dates).
const wednesday = nextIsoWeekday(3); // a shared service day
const saturday = nextIsoWeekday(6); // the corridor's other service day
const monday = nextIsoWeekday(1); // off-schedule (not a service day)

const valid = {
  // A leg we actually sell: Negombo → Sigiriya, $27.49/seat, boards 07:30.
  // (hill-line's Kandy→Ella was withdrawn — corridor adjacency is no longer an offer.)
  from: 'Negombo',
  to: 'Sigiriya / Dambulla',
  date: wednesday, // Wednesday — a shared service day (corridors run Wed & Sat)
  time: '07:30',
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

// A shared seat is sold on an explicit catalogue of directed legs (departureRepo
// SHARED_PRODUCTS), not on any pair that shares a corridor. Pricing follows: a corridor
// holds several products at different prices (airport-cultural sells Negombo->Sigiriya at
// $27.49 AND Sigiriya->Kandy at $19.99), so corridor.seatPrice cannot price a booking.
describe('POST /bookings/shared — catalogue pricing', () => {
  const leg = {
    from: 'Negombo',
    to: 'Sigiriya / Dambulla',
    date: wednesday,
    time: '07:30',
    seats: 2,
    customer: valid.customer,
  };

  it('prices from the product, not the corridor seat price', async () => {
    const res = await postShared(createApp(), leg);
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.mode).toBe('shared');
    expect(b.total).toBe(5498); // 2 × $27.49 — NOT 2 × $19 (airport-cultural seat)
  });

  it('prices a second product on the SAME corridor at its own price', async () => {
    const res = await postShared(createApp(), {
      ...leg, from: 'Sigiriya / Dambulla', to: 'Kandy', time: '11:30', seats: 1,
    });
    expect(res.status).toBe(201);
    expect((await res.json()).total).toBe(1999); // $19.99, same corridor as above
  });

  it('accepts the product boarding time, not just the corridor departure', async () => {
    // Sigiriya->Kandy boards at 11:30; the corridor's own time is 07:30 (when the van
    // leaves CMB). Validating against the corridor rejected every intermediate leg.
    const res = await postShared(createApp(), {
      ...leg, from: 'Sigiriya / Dambulla', to: 'Kandy', time: '11:30', seats: 1,
    });
    expect(res.status).toBe(201);
  });

  it('400s a pair that shares a corridor but is not sold', async () => {
    const res = await postShared(createApp(), { ...leg, from: 'Kandy', to: 'Ella' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('not_a_shared_route');
  });

  it('400s the reverse of a sold leg', async () => {
    const res = await postShared(createApp(), {
      ...leg, from: 'Sigiriya / Dambulla', to: 'Negombo',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('not_a_shared_route');
  });
});

describe('POST /bookings/shared', () => {
  it('books a shared seat (201) priced seats × catalogue price', async () => {
    const app = createApp();
    const res = await postShared(app, valid);
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.mode).toBe('shared');
    expect(b.total).toBe(5498); // 2 seats × $27.49 (negombo-sigiriya)
  });

  it('ignores a bogus corridorId — the catalogue leg decides', async () => {
    // corridorId is no longer the resolver: a corridor can hold several products at
    // different prices, so from/to identifies the booking and carries its own corridor.
    const res = await postShared(createApp(), { ...valid, corridorId: 'nope' });
    expect(res.status).toBe(201);
    expect((await res.json()).input.corridorId).toBe('airport-cultural');
  });

  it('400s when from/to are missing, since a corridor alone cannot be priced', async () => {
    const { from: _f, to: _t, ...noRoute } = valid;
    void _f; void _t;
    const res = await postShared(createApp(), { ...noRoute, corridorId: 'airport-cultural' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('not_a_shared_route');
  });

  it('400 for a malformed / non-calendar date (would otherwise bypass the past-date rule)', async () => {
    // A non-ISO or impossible date is treated as "not past" by isPastIsoDate, so without
    // schema-level ISO validation it slips through with a garbage departure date.
    expect((await postShared(createApp(), { ...valid, date: '2026-13-45' })).status).toBe(400);
    expect((await postShared(createApp(), { ...valid, date: 'tomorrow' })).status).toBe(400);
  });

  it('resolves the corridor from from/to (what the website sends)', async () => {
    const app = createApp();
    const res = await postShared(app, { ...valid, seats: 1 });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.mode).toBe('shared');
    expect(b.input.corridorId).toBe('airport-cultural');
  });

  it('sells a mid-corridor leg (neither endpoint is the corridor terminus)', async () => {
    // Negombo → Sigiriya sits inside airport-cultural (CMB … Kandy); travellers do board
    // mid-corridor, so an intermediate leg is a first-class product with its own price.
    const res = await postShared(createApp(), { ...valid, seats: 1 });
    expect(res.status).toBe(201);
    expect((await res.json()).total).toBe(2749);
  });

  it('400s Negombo → Kandy: both on the corridor, but not a product', async () => {
    // The van does run Negombo → … → Kandy, but we sell it as two legs and never priced
    // the through-journey. Adjacency used to make it bookable at the corridor's $19.
    const res = await postShared(createApp(), { ...valid, from: 'Negombo', to: 'Kandy' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('not_a_shared_route');
  });

  it('400 when from/to is not a catalogue leg', async () => {
    const res = await postShared(createApp(), { ...valid, from: 'Nowhere', to: 'Elsewhere' });
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
    await app.request(`/bookings/${b.id}/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.checkoutToken}` },
    });
    await app.request('/webhooks/payments', {
      method: 'POST',
      body: adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency }),
    });
    const paid = await bookings.get(b.id);
    expect(paid!.status).toBe('paid');
    expect(email.sent).toHaveLength(1);
  });
});

// CH-6HE3V (2026-09-21): the booking stored only a corridorId, so what the customer
// bought could not be recovered from the row — the emails and the ops tool each
// rebuilt it from the corridor's ends and named the wrong town. Record the leg.
describe('POST /bookings/shared — the booking records the leg it sold', () => {
  it('stores the product endpoints on the booking', async () => {
    const res = await postShared(createApp(), {
      ...valid, from: 'Colombo Airport (CMB)', to: 'Sigiriya / Dambulla', time: '07:00',
    });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.input.fromPlace).toBe('Colombo Airport (CMB)');
    expect(b.input.toPlace).toBe('Sigiriya / Dambulla');
  });

  // The catalogue's spelling is the one ops and the customer both read, so the
  // booking keeps THAT, not whatever casing/padding the request happened to carry.
  it('records the catalogue spelling, not the request spelling', async () => {
    const res = await postShared(createApp(), { ...valid, from: '  negombo ', to: 'sigiriya / dambulla' });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.input.fromPlace).toBe('Negombo');
    expect(b.input.toPlace).toBe('Sigiriya / Dambulla');
  });

  // Two legs on ONE corridor, told apart only by what the row records.
  it('tells two legs of the same corridor apart', async () => {
    const app = createApp();
    const north = await (await postShared(app, { ...valid, from: 'Colombo Airport (CMB)', to: 'Sigiriya / Dambulla', time: '07:00' })).json();
    const onward = await (await postShared(app, { ...valid, from: 'Sigiriya / Dambulla', to: 'Kandy', time: '11:30', seats: 1 })).json();
    expect(north.input.corridorId).toBe(onward.input.corridorId);
    expect(north.input.toPlace).toBe('Sigiriya / Dambulla');
    expect(onward.input.toPlace).toBe('Kandy');
  });
});

// ── Follow-up to CH-6HE3V (2026-09-22) ─────────────────────────────────────
// The seat hold is keyed on the TRIMMED departure time, but the booking stored the raw
// request string. One stray space and every later release — ops cancel, refund, and the
// 24h stale-hold sweep — reads a key the hold never wrote. Nothing errors: the sweep even
// reports success. The seats are simply gone, held against a departure nobody can find.
describe('POST /bookings/shared — the stored time is the one the hold used', () => {
  const padded = { ...valid, from: 'Negombo', to: 'Sigiriya / Dambulla', time: ' 07:30 ' };
  const departure = { corridorId: 'airport-cultural', date: wednesday, time: '07:30' } as const;

  it('stores the trimmed departure time, not the request string', async () => {
    const res = await postShared(createApp(), padded);
    expect(res.status).toBe(201);
    expect((await res.json()).input.time).toBe('07:30');
  });

  // The one that costs money: a whole van's seats stranded with no error anywhere.
  it('gives the seats back when a stale hold is swept', async () => {
    const bookings = new InMemoryBookingRepo();
    const departures = new InMemoryDepartureRepo();
    const app = createApp({ bookings, departures });

    const res = await postShared(app, { ...padded, seats: 12 }); // the whole van
    expect(res.status).toBe(201);
    // the hold is real: nothing more can be sold on that departure
    expect(await departures.holdSeats({ ...departure, seats: 1 })).toBeNull();

    const r = await sweepStaleSharedHolds({
      bookings,
      departures,
      now: new Date(Date.now() + 25 * 3600 * 1000),
    });
    expect(r.swept).toBe(1);
    // and the seats are ACTUALLY back, not merely reported swept
    expect(await departures.holdSeats({ ...departure, seats: 12 })).not.toBeNull();
  });
});
