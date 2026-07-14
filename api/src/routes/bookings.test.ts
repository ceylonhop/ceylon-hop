import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakeMapsAdapter, type MapsAdapter } from '../adapters/maps';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryDepartureRepo } from '../db/departureRepo';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { RATE_CARD } from '../quote/rateCard';
import { isoToday } from '../domain/dateRules';
import { signBookingToken } from '../lib/bookingToken';

const valid = {
  from: 'Colombo Airport',
  to: 'Ella',
  vehicleType: 'car',
  adults: 2,
  children: 0,
  bags: 2,
  customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

function post(
  app: ReturnType<typeof createApp>,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request('/bookings/single', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /bookings/single', () => {
  it('creates a draft (201) with reference and total', async () => {
    const app = createApp();
    const res = await post(app, valid);
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.reference).toMatch(/^CH-/);
    expect(b.status).toBe('draft');
    expect(b.total).toBe(5000); // unresolvable route, no quotedTotal → placeholder: 4000 + 1×1000
    expect(b.currency).toBe('USD');
  });

  it('accepts split phone fields while preserving the WhatsApp contact', async () => {
    const app = createApp();
    const res = await post(app, {
      ...valid,
      customer: {
        ...valid.customer,
        phoneCountryCode: '+94',
        phoneNumber: '771234567',
        whatsapp: '+94771234567',
        country: 'Sri Lanka',
      },
    });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.input.customer).toMatchObject({
      firstName: 'Maya',
      lastName: 'Silva',
      phoneCountryCode: '+94',
      phoneNumber: '771234567',
      whatsapp: '+94771234567',
      country: 'Sri Lanka',
    });
  });

  it('prices a resolvable route with the engine, due in full now (GL-3)', async () => {
    const app = createApp();
    const res = await post(app, { ...valid, from: 'Colombo Airport (CMB)', to: 'Galle' });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.total).toBe(7849); // km 180 → billable 195 after the 15km max buffer → round(195×40.25) = 7849
    expect(b.amountDueNow).toBe(7849);
  });

  // ── Rate-lock (spec 2026-07-11 §4): a booking carrying a live web quote id is priced against
  // that quote's frozen card, so a rate-card change under the hood can't move the customer's price.
  async function withLockedQuote(rateLockedUntil: Date | null, perKmCar: number) {
    const quotes = new InMemoryQuoteRepo();
    const saved = await quotes.save({
      channel: 'web', product: 'private', totalCents: 0, currency: 'USD', rateCardVersion: 'frozen',
      request: {}, result: {},
      rateCardJson: { ...RATE_CARD, version: 'frozen', perKmCents: { ...RATE_CARD.perKmCents, car: perKmCar } },
      rateLockedUntil,
    });
    return { app: createApp({ quotes }), quoteId: saved.id };
  }

  it('a live locked quote id prices the booking against its FROZEN card, not the live one', async () => {
    const { app, quoteId } = await withLockedQuote(new Date(Date.now() + 3 * 86_400_000), 20); // 20¢/km, held
    const b = await (await post(app, { ...valid, from: 'Colombo Airport (CMB)', to: 'Galle', quoteId })).json();
    expect(b.total).toBe(3900); // billable 195 × 20¢ (frozen) — NOT 7849 on the live 40.25¢ card
  });

  it('an EXPIRED locked quote id falls back to the live card (the 7-day hold has lapsed)', async () => {
    const { app, quoteId } = await withLockedQuote(new Date(Date.now() - 86_400_000), 20); // expired yesterday
    const b = await (await post(app, { ...valid, from: 'Colombo Airport (CMB)', to: 'Galle', quoteId })).json();
    expect(b.total).toBe(7849); // live 40.25¢ card
  });

  it('an unknown quote id is ignored — prices on the live card, never crashes', async () => {
    const app = createApp({ quotes: new InMemoryQuoteRepo() });
    const b = await (await post(app, { ...valid, from: 'Colombo Airport (CMB)', to: 'Galle', quoteId: 'no-such-quote' })).json();
    expect(b.total).toBe(7849);
  });

  it('prices payload extras through the engine (GL-3)', async () => {
    const app = createApp();
    const res = await post(app, { ...valid, from: 'Colombo Airport (CMB)', to: 'Galle', extras: ['luggage', 'front'] });
    const b = await res.json();
    expect(b.total).toBe(9149); // 7849 + luggage 500 + front 800
  });

  it('resolves each route pair once per request — pricing + enrichment share the billed lookup', async () => {
    const fake = new FakeMapsAdapter();
    let calls = 0;
    const counting: MapsAdapter = {
      provider: 'counting',
      distance: (f, t) => { calls++; return fake.distance(f, t); },
      places: (q) => fake.places(q),
    };
    const app = createApp({ maps: counting });
    await post(app, { ...valid, from: 'Colombo Airport (CMB)', to: 'Galle' });
    expect(calls).toBe(1); // not 2 (engine + M8 enrichment)
  });

  it('enriches the booking with road distance + duration (maps adapter)', async () => {
    const app = createApp();
    const b = await (await post(app, { ...valid, from: 'Colombo Airport (CMB)', to: 'Galle' })).json();
    expect(b.distanceKm).toBeGreaterThan(150); // ~180 km via the fake's haversine estimate
    expect(b.durationMin).toBeGreaterThan(0);
  });

  it('leaves distance null when the route is unrecognised (fake)', async () => {
    const app = createApp();
    const b = await (await post(app, { ...valid, from: 'Somewhere', to: 'Elsewhere' })).json();
    expect(b.distanceKm).toBeNull();
  });

  it('rejects an invalid body (400)', async () => {
    const app = createApp();
    const res = await post(app, { ...valid, adults: 0 });
    expect(res.status).toBe(400);
  });

  it('rejects a past date (400 date_in_past); a future date is accepted', async () => {
    const app = createApp();
    const past = await post(app, { ...valid, date: '2020-01-01' });
    expect(past.status).toBe(400);
    expect((await past.json()).error).toBe('date_in_past');
    // a clearly-future date passes the guard (Asia/Colombo today floor)
    const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const ok = await post(app, { ...valid, date: soon });
    expect(ok.status).toBe(201);
  });

  it('floors an unpriceable route at the server placeholder — a tampered low quotedTotal is ignored', async () => {
    const app = createApp();
    // `valid` is an unresolvable route, so the engine can't price it → placeholder path.
    const baseline = await (await post(app, valid)).json();
    expect(baseline.total).toBe(5000); // server placeholder (4000 + 1×1000)
    // a tampered tiny quotedTotal must NOT be charged verbatim — floor at the placeholder
    const tampered = await (await post(app, { ...valid, quotedTotal: 200 })).json();
    expect(tampered.total).toBe(5000);
    expect(tampered.amountDueNow).toBe(5000);
    // a legitimately higher quotedTotal is still honored on the unpriced path
    const higher = await (await post(app, { ...valid, quotedTotal: 9000 })).json();
    expect(higher.total).toBe(9000);
  });

  it('is idempotent on Idempotency-Key — one booking, second call returns it', async () => {
    const app = createApp();
    const r1 = await post(app, valid, { 'Idempotency-Key': 'abc' });
    const r2 = await post(app, valid, { 'Idempotency-Key': 'abc' });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect((await r1.json()).id).toBe((await r2.json()).id);
  });
});

describe('GET /bookings/view (tokenized customer view)', () => {
  const SECRET = 'dev-booking-link-secret-change-me';

  it('returns a customer-safe projection for a valid token', async () => {
    const bookings = new InMemoryBookingRepo();
    const created = await bookings.create({
      mode: 'single',
      total: 6000,
      amountDueNow: 6000,
      currency: 'USD',
      input: {
        from: 'Colombo Airport (CMB)',
        to: 'Kandy',
        vehicleType: 'car',
        adults: 2,
        children: 0,
        bags: 1,
        customer: { firstName: 'Maya', lastName: 'Fernandez', email: 'maya@example.com', whatsapp: '+94771234567', country: 'Spain' },
      },
    });
    const app = createApp({ bookings });
    const res = await app.request(`/bookings/view?t=${signBookingToken(created.id, SECRET)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reference).toBe(created.reference);
    expect(body.from).toBe('Colombo Airport (CMB)');
    expect(body.firstName).toBe('Maya');
    expect(body.totalCents).toBe(6000);
    // Allow-list: never leak the id, channel, or contact details.
    for (const leak of ['id', 'channel', 'email', 'whatsapp', 'country', 'lastName']) {
      expect(JSON.stringify(body)).not.toContain(leak === 'email' ? 'maya@example.com' : leak === 'whatsapp' ? '+94771234567' : leak === 'country' ? 'Spain' : leak === 'lastName' ? 'Fernandez' : `"${leak}"`);
    }
  });

  it('401s a missing or invalid token', async () => {
    const app = createApp();
    expect((await app.request('/bookings/view')).status).toBe(401);
    expect((await app.request('/bookings/view?t=garbage')).status).toBe(401);
  });

  it('404s a valid signature for an unknown booking', async () => {
    const app = createApp();
    const res = await app.request(`/bookings/view?t=${signBookingToken('no-such-id', SECRET)}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /bookings — no past dates (trip + shared)', () => {
  const jpost = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('trip rejects a past leg date (400 date_in_past)', async () => {
    const app = createApp();
    const res = await jpost(app, '/bookings/trip', {
      stops: ['Colombo Airport (CMB)', 'Kandy'], nights: [1, 0], dates: ['2020-01-01'],
      pax: 2, vehicleType: 'car', serviceType: 'private', customer: valid.customer,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('date_in_past');
  });

  it('a live locked quote id prices a TRIP against its frozen card (rate-lock §4)', async () => {
    const quotes = new InMemoryQuoteRepo();
    const saved = await quotes.save({
      channel: 'web', product: 'private', totalCents: 0, currency: 'USD', rateCardVersion: 'frozen',
      request: {}, result: {},
      rateCardJson: { ...RATE_CARD, version: 'frozen', perKmCents: { ...RATE_CARD.perKmCents, car: 20 } },
      rateLockedUntil: new Date(Date.now() + 3 * 86_400_000),
    });
    const app = createApp({ quotes });
    const b = await (await jpost(app, '/bookings/trip', {
      stops: ['Colombo Airport (CMB)', 'Galle'], nights: [0, 0],
      pax: 2, vehicleType: 'car', serviceType: 'private', customer: valid.customer, quoteId: saved.id,
    })).json();
    expect(b.total).toBe(3900); // billable 195 × 20¢ (frozen) — NOT 7849 on the live card
  });

  it('shared rejects a past date (400 date_in_past)', async () => {
    const app = createApp();
    const res = await jpost(app, '/bookings/shared', {
      corridorId: 'hill-line', date: '2020-01-01', time: '08:00', seats: 2, customer: valid.customer,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('date_in_past');
  });
});

describe('POST /bookings/shared — seat-hold compensation', () => {
  const jpost = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // A future shared service day (Wed=3 / Sat=6) so the request clears the date + service-day
  // guards and actually reaches bookings.create.
  function futureServiceDay(): string {
    for (let i = 14; i < 60; i++) {
      const iso = isoToday('Asia/Colombo', new Date(Date.now() + i * 86_400_000));
      const wd = new Date(`${iso}T00:00:00Z`).getUTCDay();
      if (wd === 3 || wd === 6) return iso;
    }
    throw new Error('no service day found');
  }

  it('releases the held seats when booking creation fails (no leaked inventory)', async () => {
    const departures = new InMemoryDepartureRepo();
    let released = 0;
    const orig = departures.releaseSeats.bind(departures);
    departures.releaseSeats = async (args) => { released += args.seats; return orig(args); };
    class FailingBookings extends InMemoryBookingRepo {
      async create(): Promise<never> { throw new Error('db down after hold'); }
    }
    const app = createApp({ departures, bookings: new FailingBookings() });
    const res = await jpost(app, '/bookings/shared', {
      corridorId: 'hill-line', date: futureServiceDay(), time: '08:00', seats: 2, customer: valid.customer,
    });
    expect(res.status).toBeGreaterThanOrEqual(500); // the create threw
    expect(released).toBe(2); // the 2 held seats were given back, not stranded on the departure
  });

  it('charges the shared extra-bag fee end to end ($10/bag beyond one free per seat)', async () => {
    const app = createApp();
    const res = await jpost(app, '/bookings/shared', {
      corridorId: 'hill-line', date: futureServiceDay(), time: '08:00', seats: 2, bags: 4, customer: valid.customer,
    });
    expect(res.status).toBe(201);
    // 2 seats × $21 + 2 extra bags × $10 = $62 — the fee the customer saw is actually captured
    expect((await res.json()).total).toBe(6200);
  });
});
