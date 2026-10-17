import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApp as realCreateApp, type AppDeps } from '../app';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryExperienceRepo } from '../db/experienceRepo';
import { InMemoryExperienceInterestRepo } from '../db/experienceInterestRepo';
import { PLACEHOLDERS } from '../experiences/placeholders';
import { signQuotePayToken } from '../lib/bookingToken';

// Partner experiences on the pay-link confirmation (owner, 2026-10-15, option B). They show only
// once the customer has paid — the `paid` keepsake and the `balance` "You're booked" screen — and a
// "Request info" tap is recorded on the BOOKING with source 'pay_page', so it is an ops lead at once.
// Best-effort like the quote page used to be (spec D17): a failure costs only the section.
const SECRET = 'test-link-secret';
const AUTH = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };
const CUSTOMER = { firstName: 'Nimal', lastName: 'Perera', email: 'nimal@x.com', whatsapp: '+94770001111', country: 'LK' };

const SIGIRIYA_LEGS = [
  { from: 'Colombo Airport (CMB)', to: 'Sigiriya / Dambulla', distanceKm: 168, date: '2026-09-01', category: 'transfer' },
  { from: 'Sigiriya / Dambulla', to: 'Kandy', distanceKm: 92, date: '2026-09-03', category: 'transfer' },
];
const GALLE_LEGS = [{ from: 'Colombo Airport (CMB)', to: 'Galle', distanceKm: 120, date: '2026-09-01', category: 'transfer' }];

afterEach(() => vi.restoreAllMocks());

async function world(opts: { legs?: unknown[]; deps?: AppDeps } = {}) {
  const quotes = new InMemoryQuoteRepo();
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const experiences = new InMemoryExperienceRepo();
  const [massage, cooking] = await Promise.all(PLACEHOLDERS.map((p) => experiences.create(p)));
  const far = await experiences.create({ ...PLACEHOLDERS[0], slug: 'far-away', name: 'Whale watching', lat: 5.95, lng: 80.46, radiusKm: 5 });
  const experienceInterests = new InMemoryExperienceInterestRepo({ bookings, quotes, experiences });
  const app = realCreateApp({
    auth: AUTH, adminApiKey: 'k', bookingLinkSecret: SECRET, quotes, bookings, payments, experiences, experienceInterests, ...opts.deps,
  });
  // A chauffeur trip ($219), so the link offers a deposit (deposits are chauffeur-only).
  const legs = opts.legs ?? SIGIRIYA_LEGS;
  const q = await quotes.save({
    channel: 'ops', product: 'chauffeur', vehicle: 'car', customerName: 'Nimal Perera', customerContact: '+94 77 000 1111',
    totalCents: 21_900, currency: 'USD', rateCardVersion: 'v1', marginCents: 4_300,
    request: {
      tool: { vehicle: 'car', passengerCount: 2, luggageCount: 1, legs },
      engine: { product: 'chauffeur', vehicle: 'car', pax: 2, bags: 1, firstDate: '2026-09-01', lastDate: '2026-09-06', travelDays: [{ date: '2026-09-01', from: 'CMB', to: 'Sigiriya', distanceKm: 168 }] },
    },
    result: { totalCents: 21_900, marginEstimateCents: 4_300, lineItems: [{ label: 'x', amountCents: 21_900 }] },
    rateCardJson: { version: 'LOCKED', chauffeur: { dayRateCostCents: 2700 } },
  } as never);
  await quotes.patch(q.id, { status: 'pending_review' });
  await quotes.patch(q.id, { status: 'ready' });
  await quotes.patch(q.id, { status: 'sent' });
  const t = signQuotePayToken(q.id, q.revision, SECRET);
  const view = async () => (await app.request(`/quotes/pay/view?t=${encodeURIComponent(t)}`)).json();
  const post = (body: unknown) => app.request('/quotes/pay/interest', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  // Pays on the link: `deposit` leaves the balance open, `full` settles it. Then settlement's effects.
  async function pay(payment: 'full' | 'deposit') {
    const res = await app.request('/quotes/pay/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t, customer: CUSTOMER, termsAccepted: true, payment }),
    });
    expect(res.status).toBe(201);
    const { bookingId } = await res.json();
    const booking = (await bookings.get(bookingId))!;
    const amount = payment === 'deposit' ? 5_000 : booking.total;
    const p = await payments.create({
      bookingId, provider: 'payhere', orderId: `${booking.reference}-${payment === 'deposit' ? 'D' : 'F'}`, amount, currency: 'USD',
      idempotencyKey: `checkout:${bookingId}:${payment}`, ...(payment === 'deposit' ? { purpose: 'deposit' } : {}),
    } as never);
    await payments.markSucceeded(p.id);
    await bookings.setStatus(bookingId, 'paid');
    await quotes.patch(q.id, { status: 'won' });
    return (await bookings.get(bookingId))!;
  }
  return { app, quotes, bookings, payments, experiences, experienceInterests, q, t, view, post, pay, massage: massage!, cooking: cooking!, far: far! };
}

type Item = { id: string; name: string; interested: boolean; aboutKm: number };

describe('GET /quotes/pay/view — partner experiences', () => {
  it('a full payment’s `paid` keepsake lists the experiences near the trip’s stops, public fields only', async () => {
    const w = await world();
    await w.pay('full');
    const body = await w.view();
    expect(body.state).toBe('paid');
    expect(body.experiences).toHaveLength(1);
    expect(body.experiences[0].place).toBe('Sigiriya');
    const items: Item[] = body.experiences[0].items;
    expect(items.map((i) => i.name).sort()).toEqual(['Ayurvedic massage', 'Elephant jeep safari', 'Village cooking lesson']);
    expect(items.every((i) => i.interested === false)).toBe(true);
    expect(items[0]!.aboutKm).toEqual(expect.any(Number));
    expect(JSON.stringify(body.experiences)).not.toMatch(/partnerContact|"lat"|"lng"|radiusKm|createdBy|updatedBy|"active"/);
  });

  it('a deposit’s `balance` screen lists them too, `interested` read from the BOOKING', async () => {
    const w = await world();
    const booking = await w.pay('deposit');
    await w.experienceInterests.record({ experience: w.massage, source: 'pay_page', bookingId: booking.id });
    const body = await w.view();
    expect(body.state).toBe('balance');
    const items: Item[] = body.experiences[0].items;
    expect(items.find((i) => i.id === w.massage.id)!.interested).toBe(true);
    expect(items.find((i) => i.id === w.cooking.id)!.interested).toBe(false);
  });

  it('an interest ticked on the quote before booking still reads as requested (it followed the quote into the booking)', async () => {
    const w = await world();
    await w.experienceInterests.record({ experience: w.cooking, source: 'quote_page', quoteId: w.q.id });
    await w.pay('full'); // /start links the quote's interests onto the booking
    const items: Item[] = (await w.view()).experiences[0].items;
    expect(items.find((i) => i.id === w.cooking.id)!.interested).toBe(true);
  });

  it('a trip with no stop near an experience gets experiences: []', async () => {
    const w = await world({ legs: GALLE_LEGS });
    await w.pay('full');
    const body = await w.view();
    expect(body.state).toBe('paid');
    expect(body.experiences).toEqual([]);
  });

  it('the payable page (before any payment) carries none', async () => {
    const w = await world();
    const body = await w.view();
    expect(body.state).toBe('payable');
    expect(body).not.toHaveProperty('experiences');
  });

  it('a matcher failure degrades to experiences: [] and the keepsake still renders', async () => {
    const w = await world();
    await w.pay('deposit');
    vi.spyOn(w.experiences, 'listActive').mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await w.view();
    expect(body.state).toBe('balance');
    expect(body.balance.balanceUsd).toBe('$169.00');
    expect(body.experiences).toEqual([]);
  });
});

describe('POST /quotes/pay/interest', () => {
  it('records the interest on the booking (source pay_page) and it is an ops lead at once; a double tap is one row', async () => {
    const w = await world();
    const booking = await w.pay('deposit');
    for (let i = 0; i < 2; i++) {
      const res = await w.post({ t: w.t, experienceId: w.massage.id, interested: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ interested: true });
    }
    const rows = await w.experienceInterests.listForBooking(booking.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ experienceId: w.massage.id, bookingId: booking.id, quoteId: null, source: 'pay_page', status: 'new' });
    const lead = (await w.experienceInterests.listLeads(50)).find((l) => l.id === rows[0]!.id);
    expect(lead).toMatchObject({ ownerKind: 'booking', reference: booking.reference, experienceName: 'Ayurvedic massage' });
    // The page reads it back as requested.
    expect((await w.view()).experiences[0].items.find((i: Item) => i.id === w.massage.id).interested).toBe(true);
  });

  it('works on the `paid` keepsake too', async () => {
    const w = await world();
    const booking = await w.pay('full');
    const res = await w.post({ t: w.t, experienceId: w.cooking.id, interested: true });
    expect(res.status).toBe(200);
    expect((await w.experienceInterests.listForBooking(booking.id)).map((r) => r.experienceId)).toEqual([w.cooking.id]);
  });

  it('withdraws while the lead is still new, and withdrawing twice is fine', async () => {
    const w = await world();
    const booking = await w.pay('full');
    await w.post({ t: w.t, experienceId: w.massage.id, interested: true });
    for (let i = 0; i < 2; i++) {
      const res = await w.post({ t: w.t, experienceId: w.massage.id, interested: false });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ interested: false });
    }
    expect(await w.experienceInterests.listForBooking(booking.id)).toEqual([]);
  });

  it('once ops has acted on it the interest stays: 200 {interested:true}', async () => {
    const w = await world();
    const booking = await w.pay('full');
    const row = await w.experienceInterests.record({ experience: w.massage, source: 'pay_page', bookingId: booking.id });
    await w.experienceInterests.patch(row.id, { status: 'contacted', updatedBy: 'ops@ceylonhop.com' });
    const res = await w.post({ t: w.t, experienceId: w.massage.id, interested: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ interested: true });
    expect(await w.experienceInterests.listForBooking(booking.id)).toHaveLength(1);
  });

  it('409 not_paid while the link has not been paid; 409 quote_unavailable for a bad token', async () => {
    const w = await world();
    const unpaid = await w.post({ t: w.t, experienceId: w.massage.id, interested: true });
    expect(unpaid.status).toBe(409);
    expect(await unpaid.json()).toEqual({ error: 'not_paid' });
    const bad = await w.post({ t: 'nonsense', experienceId: w.massage.id, interested: true });
    expect(bad.status).toBe(409);
    expect(await bad.json()).toEqual({ error: 'quote_unavailable' });
    expect(await w.experienceInterests.listForQuote(w.q.id)).toEqual([]);
  });

  it('422 not_offered for an experience that is not among this trip’s matches', async () => {
    const w = await world();
    const booking = await w.pay('full');
    const retired = await w.experiences.create({ ...PLACEHOLDERS[0], slug: 'retired', active: false });
    for (const id of [w.far.id, retired.id, '3f1c2d4e-0000-4000-8000-000000000000']) {
      const res = await w.post({ t: w.t, experienceId: id, interested: true });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: 'not_offered' });
    }
    expect(await w.experienceInterests.listForBooking(booking.id)).toEqual([]);
  });

  it('400 for a malformed or over-long body', async () => {
    const w = await world();
    await w.pay('full');
    const good = { t: w.t, experienceId: w.massage.id, interested: true };
    for (const bad of [{}, { ...good, interested: 'yes' }, { ...good, experienceId: 'nope' }, { ...good, extra: 1 }, { ...good, t: undefined }, { ...good, t: 'x'.repeat(2001) }]) {
      expect((await w.post(bad)).status).toBe(400);
    }
    const raw = await w.app.request('/quotes/pay/interest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect(raw.status).toBe(400);
  });

  it('is rate-limited like the other public pay-link writes', async () => {
    const w = await world({ deps: { rateLimit: { max: 2, windowMs: 60_000 } } });
    const bad = () => w.app.request('/quotes/pay/interest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect((await bad()).status).toBe(400);
    expect((await bad()).status).toBe(400);
    expect((await bad()).status).toBe(429);
  });
});
