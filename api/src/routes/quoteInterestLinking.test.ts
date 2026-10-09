import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApp as realCreateApp, type AppDeps } from '../app';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryExperienceRepo } from '../db/experienceRepo';
import { InMemoryExperienceInterestRepo } from '../db/experienceInterestRepo';
import { PLACEHOLDERS } from '../experiences/placeholders';
import { signQuotePayToken } from '../lib/bookingToken';
import { signSession } from '../lib/opsAuth';

// Spec 2026-10-06 D12: a quote's "interested" ticks follow the quote into the booking it becomes,
// at every point a quote converts — and a failure to link never fails the conversion.
const SECRET = 'test-link-secret';
const AUTH = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };
const COOKIE = `ch_ops=${signSession({ email: 'f@x.com', exp: Date.now() + 60_000 }, AUTH.opsSessionSecret)}`;
const CUSTOMER = { firstName: 'Nimal', lastName: 'Perera', email: 'nimal@x.com', whatsapp: '+94770001111', country: 'LK' };

afterEach(() => vi.restoreAllMocks());

async function world() {
  const quotes = new InMemoryQuoteRepo();
  const bookings = new InMemoryBookingRepo();
  const experiences = new InMemoryExperienceRepo();
  const massage = await experiences.create(PLACEHOLDERS[0]);
  const experienceInterests = new InMemoryExperienceInterestRepo({ bookings, quotes, experiences });
  const app = (deps: AppDeps = {}) => realCreateApp({
    auth: AUTH, adminApiKey: 'k', bookingLinkSecret: SECRET, quotes, bookings, experiences, experienceInterests, ...deps,
  });
  return { quotes, bookings, experiences, experienceInterests, massage, app };
}
type World = Awaited<ReturnType<typeof world>>;

async function tick(w: World, quoteId: string) {
  await w.experienceInterests.record({ experience: w.massage, source: 'quote_page', quoteId });
}

const legs = [{ from: 'Colombo Airport (CMB)', to: 'Galle', distanceKm: 120, date: '2026-09-01', category: 'transfer' }];
async function opsQuote(w: World) {
  const q = await w.quotes.save({
    channel: 'ops', product: 'private', vehicle: 'car', customerName: 'Nimal Perera', customerContact: '+94 77 000 1111',
    totalCents: 21_900, currency: 'USD', rateCardVersion: 'v1', marginCents: 4_300,
    request: {
      tool: { vehicle: 'car', passengerCount: 2, luggageCount: 1, legs },
      engine: { product: 'private', vehicle: 'car', pax: 2, bags: 1, legs: [{ from: 'CMB', to: 'Galle', distanceKm: 120 }] },
    },
    result: { totalCents: 21_900, marginEstimateCents: 4_300, lineItems: [{ label: 'x', amountCents: 21_900 }] },
    rateCardJson: { version: 'LOCKED' },
  } as never);
  await w.quotes.patch(q.id, { status: 'pending_review' });
  await w.quotes.patch(q.id, { status: 'ready' });
  await w.quotes.patch(q.id, { status: 'sent' });
  return (await w.quotes.get(q.id))!;
}

const BOOK_BODY = { customer: { firstName: 'A', lastName: 'B', email: 'a@b.com', whatsapp: '+94123456', country: 'LK' }, vehicleType: 'car', pax: 2, bags: 1, date: '2026-09-01', time: '09:00' };
const book = (app: ReturnType<World['app']>, id: string) => app.request(`/admin/quote/${id}/book`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body: JSON.stringify(BOOK_BODY),
});

describe('internalQuote "Mark booked"', () => {
  it('moves the quote’s interests onto the new booking', async () => {
    const w = await world();
    const q = await opsQuote(w);
    await tick(w, q.id);
    const res = await book(w.app(), q.id);
    expect(res.status).toBe(201);
    const rows = await w.experienceInterests.listForBooking((await res.json()).id);
    expect(rows.map((r) => r.experienceId)).toEqual([w.massage.id]);
  });

  it('also links on the re-book branch (the booking already existed)', async () => {
    const w = await world();
    const q = await opsQuote(w);
    const first = await (await book(w.app(), q.id)).json();
    await tick(w, q.id); // ticked after the first conversion, e.g. from a link opened later
    const res = await book(w.app(), q.id);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(first.id);
    expect((await w.experienceInterests.listForBooking(first.id)).map((r) => r.experienceId)).toEqual([w.massage.id]);
  });

  it('still books when linking throws', async () => {
    const w = await world();
    const q = await opsQuote(w);
    vi.spyOn(w.experienceInterests, 'linkQuoteToBooking').mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await book(w.app(), q.id);
    expect(res.status).toBe(201);
    expect((await w.quotes.get(q.id))!.status).toBe('won');
  });
});

describe('quote pay link — /quotes/pay/start', () => {
  it('moves the quote’s interests onto the booking the payer creates', async () => {
    const w = await world();
    const q = await opsQuote(w);
    await tick(w, q.id);
    const res = await w.app().request('/quotes/pay/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t: signQuotePayToken(q.id, q.revision, SECRET), customer: CUSTOMER, termsAccepted: true }),
    });
    expect(res.status).toBe(201);
    const { bookingId } = await res.json();
    expect((await w.experienceInterests.listForBooking(bookingId)).map((r) => r.experienceId)).toEqual([w.massage.id]);
  });

  it('still creates the booking when linking throws', async () => {
    const w = await world();
    const q = await opsQuote(w);
    vi.spyOn(w.experienceInterests, 'linkQuoteToBooking').mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await w.app().request('/quotes/pay/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t: signQuotePayToken(q.id, q.revision, SECRET), customer: CUSTOMER, termsAccepted: true }),
    });
    expect(res.status).toBe(201);
  });
});

describe('POST /bookings/from-quote-v2', () => {
  const intent = {
    product: 'private', routeId: 'kandy-nanu-oya', vehicle: 'car', pax: 2, bags: 1, date: '2026-09-10', time: '09:00',
    legs: [{ from: 'Kandy', to: 'Nanu Oya' }], extras: [],
  };
  const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+94770000000', country: 'Sri Lanka' };
  async function convert(w: World) {
    const app = w.app({ quoteV2Enabled: true });
    const lock = await app.request('/quote/v2/lock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(intent) });
    expect(lock.status).toBe(201);
    const locked = await lock.json();
    await tick(w, locked.quoteId);
    const res = await app.request('/bookings/from-quote-v2', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${locked.accessToken}` },
      body: JSON.stringify({ quoteId: locked.quoteId, revision: locked.revision, intent, bookingDetails: { customer, date: intent.date, time: intent.time } }),
    });
    return res;
  }

  it('moves the quote’s interests onto the converted booking', async () => {
    const w = await world();
    const res = await convert(w);
    expect(res.status).toBe(201);
    const rows = await w.experienceInterests.listForBooking((await res.json()).id);
    expect(rows.map((r) => r.experienceId)).toEqual([w.massage.id]);
  });

  it('still converts when linking throws', async () => {
    const w = await world();
    vi.spyOn(w.experienceInterests, 'linkQuoteToBooking').mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await convert(w)).status).toBe(201);
  });
});
