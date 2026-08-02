import { describe, it, expect } from 'vitest';
import { createApp as realCreateApp, type AppDeps } from '../app';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { signQuotePayToken } from '../lib/bookingToken';
import { signSession } from '../lib/opsAuth';

// The customer-facing half of pay links (spec §3–§5). Everything here is reachable by
// anyone holding the URL, so the two properties that matter most are pinned hard:
// margin can never appear on the wire, and no state ever lets the wrong amount be paid.

const SECRET = 'test-link-secret';
const AUTH = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };
type App = ReturnType<typeof realCreateApp>;
const createApp = (deps: AppDeps = {}): App =>
  realCreateApp({ auth: AUTH, adminApiKey: 'k', bookingLinkSecret: SECRET, ...deps });

const CUSTOMER = { firstName: 'Nimal', lastName: 'Perera', email: 'nimal@x.com', whatsapp: '+94770001111', country: 'LK' };

async function readyQuote(quotes: InMemoryQuoteRepo, opts: { product?: 'private' | 'chauffeur'; legs?: unknown[]; status?: 'ready' | 'sent'; marginCents?: number } = {}) {
  const product = opts.product ?? 'private';
  const legs = opts.legs ?? [{ from: 'Colombo Airport (CMB)', to: 'Galle', distanceKm: 120, date: '2026-09-01', category: 'transfer' }];
  const q = await quotes.save({
    channel: 'ops', product, vehicle: 'car', customerName: 'Nimal Perera', customerContact: '+94 77 000 1111',
    totalCents: 21900, currency: 'USD', rateCardVersion: 'v1',
    marginCents: opts.marginCents ?? 4300,
    request: {
      tool: { vehicle: 'car', passengerCount: 2, luggageCount: 1, legs },
      engine: product === 'chauffeur'
        ? { product, vehicle: 'car', pax: 2, bags: 1, firstDate: '2026-09-01', lastDate: '2026-09-06', travelDays: [{ date: '2026-09-01', from: 'CMB', to: 'Galle', distanceKm: 120 }] }
        : { product, vehicle: 'car', pax: 2, bags: 1, legs: [{ from: 'CMB', to: 'Galle', distanceKm: 120 }] },
    },
    result: { totalCents: 21900, marginEstimateCents: 4300, lineItems: [{ label: 'x', amountCents: 21900, meta: { hotZone: 'Ella +15%' } }] },
    rateCardJson: { version: 'LOCKED', chauffeur: { dayRateCostCents: 2700 } },
  });
  await quotes.patch(q.id, { status: 'pending_review' });
  await quotes.patch(q.id, { status: 'ready' });
  if ((opts.status ?? 'sent') === 'sent') await quotes.patch(q.id, { status: 'sent' });
  return q;
}

const view = (app: App, t: string) => app.request(`/quotes/pay/view?t=${encodeURIComponent(t)}`);
const start = (app: App, t: string, customer = CUSTOMER, billing?: Record<string, string>) =>
  app.request('/quotes/pay/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(billing ? { t, customer, billing, termsAccepted: true } : { t, customer, termsAccepted: true }),
  });

// Raw poster for the terms gate — `start` always accepts, which is the point of these.
const startRaw = (app: App, body: unknown) =>
  app.request('/quotes/pay/start', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

describe('GET /quotes/pay/view — state derivation and the wire', () => {
  it('payable: copy for the product, totals, prefill — and NEVER margin, rate card, or zones', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await readyQuote(quotes);
    const res = await view(createApp({ quotes }), signQuotePayToken(q.id, q.revision, SECRET));
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw);
    expect(body.state).toBe('payable');
    expect(body.copy.product).toBe('single');
    expect(body.copy.title).toBe('Colombo Airport (CMB) → Galle');
    // USD only — the owner cut the LKR conversion line (2026-07-31); customers pay in USD.
    expect(body.totals).toEqual({ cents: 21900, usd: '$219.00' });
    expect(body.prefill.firstName).toBe('Nimal');
    expect(body.prefill.whatsapp).toContain('77');
    // The three fields that must never reach a public URL, checked on the raw wire.
    expect(raw).not.toContain('margin');
    expect(raw).not.toContain('hotZone');
    expect(raw).not.toContain('LOCKED');
    expect(raw).not.toContain('dayRateCostCents');
  });

  it('prefers email prefill when the contact looks like one', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await readyQuote(quotes);
    await quotes.update(q.id, { customerContact: 'nimal@x.com' } as never);
    // Re-read for the revision: the edit above bumped it, and minting always signs the CURRENT
    // one (routes/internalQuote.ts reads quote.revision fresh). Signing the captured `q.revision`
    // would mint a link that is already stale — which is the point of the bump, not a bug here.
    const edited = await quotes.get(q.id);
    const body = await (await view(createApp({ quotes }), signQuotePayToken(q.id, edited!.revision, SECRET))).json();
    expect(body.prefill.email).toBe('nimal@x.com');
    expect(body.prefill.whatsapp ?? '').toBe('');
  });

  it('chauffeur copy carries the shape facts', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await readyQuote(quotes, { product: 'chauffeur' });
    const body = await (await view(createApp({ quotes }), signQuotePayToken(q.id, q.revision, SECRET))).json();
    expect(body.copy.product).toBe('chauffeur');
    expect(body.copy.title).toBe('Six days across Sri Lanka');
    expect(body.copy.facts.map((f: { k: string }) => f.k)).toEqual(['Trip', 'Days', 'Travellers', 'Starts']);
  });

  // Billing details (owner, 2026-08-01). The gateway used to be handed a hardcoded
  // `address: 'N/A', city: 'Colombo'` — fabricated billing data on a live card charge, and a
  // plausible AVS decline on foreign-issued cards. These pin the whole path: form → /start →
  // booking columns → checkout payload.
  it('start stores the billing details on the booking', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const q = await readyQuote(quotes);
    const res = await start(createApp({ quotes, bookings }), signQuotePayToken(q.id, q.revision, SECRET), CUSTOMER, {
      address: 'Prinsengracht 263', city: 'Amsterdam', country: 'Netherlands',
    });
    expect(res.status).toBe(201);
    const booking = await bookings.get((await res.json()).bookingId);
    expect(booking?.billing).toEqual({ address: 'Prinsengracht 263', city: 'Amsterdam', country: 'Netherlands' });
  });

  it('start keeps the cardholder name when billing differs from the lead passenger', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const q = await readyQuote(quotes);
    const res = await start(createApp({ quotes, bookings }), signQuotePayToken(q.id, q.revision, SECRET), CUSTOMER, {
      firstName: 'Anja', lastName: 'de Vries', address: 'Keizersgracht 1', city: 'Amsterdam', country: 'Netherlands',
    });
    const booking = await bookings.get((await res.json()).bookingId);
    // The traveller is unchanged — billing is a property of the transaction, not the person.
    expect(booking?.billing?.firstName).toBe('Anja');
    expect(booking?.input.customer.firstName).toBe('Nimal');
  });

  it('start refuses a half-filled billing object rather than passing it to the gateway', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await readyQuote(quotes);
    const res = await start(createApp({ quotes }), signQuotePayToken(q.id, q.revision, SECRET), CUSTOMER, {
      address: 'Prinsengracht 263',
    } as never);
    expect(res.status).toBe(400);
  });

  it('start still works with no billing at all — an older cached page must not break', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const q = await readyQuote(quotes);
    const res = await start(createApp({ quotes, bookings }), signQuotePayToken(q.id, q.revision, SECRET));
    expect(res.status).toBe(201);
    expect((await bookings.get((await res.json()).bookingId))?.billing).toBeNull();
  });

  // Terms + cancellation (owner, 2026-08-01). The pay-link path had NO terms step at all: a
  // customer could pay for a chauffeur trip without being shown that cancelling 9 days out
  // caps their refund at 80%. booking.html's checkbox is client-side only and records nothing,
  // so a refund dispute had no evidence either way — hence a server gate AND a timestamp.
  it('start refuses without an explicit terms acceptance', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await readyQuote(quotes);
    const app = createApp({ quotes });
    const token = signQuotePayToken(q.id, q.revision, SECRET);
    expect((await startRaw(app, { t: token, customer: CUSTOMER })).status).toBe(400);
    expect((await startRaw(app, { t: token, customer: CUSTOMER, termsAccepted: false })).status).toBe(400);
  });

  it('start records WHEN the terms were accepted, not merely that they were', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const q = await readyQuote(quotes);
    const res = await start(createApp({ quotes, bookings }), signQuotePayToken(q.id, q.revision, SECRET));
    const booking = await bookings.get((await res.json()).bookingId);
    expect(booking?.termsAcceptedAt).toBeTruthy();
    expect(new Date(booking!.termsAcceptedAt!).getTime()).toBeGreaterThan(0);
  });

  it('revised: a stale revision renders the safe state, no quote details', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await readyQuote(quotes);
    const body = await (await view(createApp({ quotes }), signQuotePayToken(q.id, q.revision + 1, SECRET))).json();
    expect(body.state).toBe('revised');
    expect(body.copy).toBeUndefined();
  });

  // The test above fabricates the mismatch (q.revision + 1). This one earns it, by driving the
  // real editing path an operator uses — reopen to draft, re-save, re-approve — because that is
  // where the guard was found unreachable (owner report, 2026-07-31): update() left the revision
  // at 1, so a link sent at $219 was still payable once the quote had become $1,019.
  it('revised: a quote reopened, re-priced and re-approved retires the link already sent', async () => {
    const quotes = new InMemoryQuoteRepo();
    const app = createApp({ quotes });
    const q = await readyQuote(quotes, { status: 'ready' });
    const sent = signQuotePayToken(q.id, q.revision, SECRET); // this URL is now in WhatsApp

    await quotes.patch(q.id, { status: 'draft' });
    await quotes.update(q.id, { ...(await quotes.get(q.id))!, totalCents: 101900 } as never);
    await quotes.patch(q.id, { status: 'pending_review' });
    await quotes.patch(q.id, { status: 'ready' });
    expect((await quotes.get(q.id))!.totalCents).toBe(101900); // the price really did move

    const body = await (await view(app, sent)).json();
    expect(body.state).toBe('revised');
    expect(body.totals).toBeUndefined(); // never quotes the new amount under the old link
    // …and the door is shut, not just the window: paying with the retired link is refused.
    const res = await start(app, sent);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('quote_revised');
  });

  // The operator's side of the same story: re-minting after an edit must hand back a DIFFERENT
  // URL. A byte-identical one is how this shipped — ops copied "the new link" and re-sent the old.
  it('a link re-minted after an edit is not the one that was already sent', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await readyQuote(quotes, { status: 'ready' });
    const sent = signQuotePayToken(q.id, q.revision, SECRET);
    await quotes.patch(q.id, { status: 'draft' });
    await quotes.update(q.id, { ...(await quotes.get(q.id))!, totalCents: 101900 } as never);
    const after = await quotes.get(q.id);
    expect(signQuotePayToken(after!.id, after!.revision, SECRET)).not.toBe(sent);
  });

  it('unavailable: garbage token, unknown quote, and every non-payable status', async () => {
    const quotes = new InMemoryQuoteRepo();
    const app = createApp({ quotes });
    expect((await (await view(app, 'garbage')).json()).state).toBe('unavailable');
    expect((await (await view(app, signQuotePayToken('nope', 1, SECRET))).json()).state).toBe('unavailable');
    const q = await readyQuote(quotes);
    await quotes.patch(q.id, { status: 'lost', lostReason: 'x' });
    expect((await (await view(app, signQuotePayToken(q.id, q.revision, SECRET))).json()).state).toBe('unavailable');
  });

  it('paid: a won quote (or a settled booking) shows the keepsake, never a Pay state', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const app = createApp({ quotes, bookings, payments });
    const q = await readyQuote(quotes);
    const t = signQuotePayToken(q.id, q.revision, SECRET);
    await start(app, t);
    const booking = (await bookings.list())[0];
    const p = await payments.create({ bookingId: booking.id, provider: 'payhere', orderId: booking.reference, amount: 21900, currency: 'USD', idempotencyKey: `checkout:${booking.id}` });
    await payments.markSucceeded(p.id);
    const body = await (await view(app, t)).json();
    expect(body.state).toBe('paid');
    expect(body.paid.reference).toBe(booking.reference);
    expect(body.paid.firstName).toBe('Nimal');
  });
});

describe('POST /quotes/pay/start — the booking is born at pay-commit', () => {
  it('creates one booking at the frozen total; the quote stays sent', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ quotes, bookings });
    const q = await readyQuote(quotes);
    const t = signQuotePayToken(q.id, q.revision, SECRET);
    const res = await start(app, t);
    expect(res.status).toBe(201);
    const { bookingId, checkoutToken } = await res.json();
    const b = (await bookings.get(bookingId))!;
    expect(b.total).toBe(21900);
    expect(b.amountDueNow).toBe(21900);
    expect(b.status).toBe('payment_pending');
    expect(b.channel).toBe('whatsapp');
    const after = (await quotes.get(q.id))!;
    expect(after.status).toBe('sent');           // NEVER won here — that's settlement's job
    expect(after.convertedBookingId).toBe(bookingId);
    expect(checkoutToken).toBeTruthy();

    // The checkout token actually opens a checkout on the fake gateway.
    const co = await app.request(`/bookings/${bookingId}/checkout`, {
      method: 'POST', headers: { authorization: `Bearer ${checkoutToken}` },
    });
    expect(co.status).toBe(200);
    expect((await co.json()).amount).toBe(21900);
  });

  it('is idempotent — a double tap returns the same booking with 200', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ quotes, bookings });
    const q = await readyQuote(quotes);
    const t = signQuotePayToken(q.id, q.revision, SECRET);
    const first = await (await start(app, t)).json();
    const res2 = await start(app, t);
    expect(res2.status).toBe(200);
    expect((await res2.json()).bookingId).toBe(first.bookingId);
    expect((await bookings.list())).toHaveLength(1);
  });

  it('works from ready — payment can land before ops marks sent', async () => {
    const quotes = new InMemoryQuoteRepo();
    const app = createApp({ quotes });
    const q = await readyQuote(quotes, { status: 'ready' });
    expect((await start(app, signQuotePayToken(q.id, q.revision, SECRET))).status).toBe(201);
    expect((await quotes.get(q.id))!.status).toBe('ready');
  });

  it('409 quote_revised on a stale token — a changed price can never be charged', async () => {
    const quotes = new InMemoryQuoteRepo();
    const app = createApp({ quotes });
    const q = await readyQuote(quotes);
    const res = await start(app, signQuotePayToken(q.id, q.revision + 1, SECRET));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('quote_revised');
  });

  it('409 already_paid once money has settled', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const app = createApp({ quotes, bookings, payments });
    const q = await readyQuote(quotes);
    const t = signQuotePayToken(q.id, q.revision, SECRET);
    const { bookingId } = await (await start(app, t)).json();
    const p = await payments.create({ bookingId, provider: 'payhere', orderId: 'x', amount: 21900, currency: 'USD', idempotencyKey: 'k1' });
    await payments.markSucceeded(p.id);
    const res = await start(app, t);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_paid');
  });

  it('409 quote_unavailable for a lost quote; 400 with named fields for bad customer input', async () => {
    const quotes = new InMemoryQuoteRepo();
    const app = createApp({ quotes });
    const q = await readyQuote(quotes);
    const t = signQuotePayToken(q.id, q.revision, SECRET);
    const bad = await start(app, t, { ...CUSTOMER, email: 'not-an-email' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).message).toContain('email');
    await quotes.patch(q.id, { status: 'lost', lostReason: 'x' });
    const res = await start(app, t);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('quote_unavailable');
  });
});

// The ops mint route and this public route agree end to end.
describe('mint → view round trip', () => {
  it('a minted URL opens payable', async () => {
    const quotes = new InMemoryQuoteRepo();
    const app = createApp({ quotes });
    const q = await readyQuote(quotes);
    const cookie = `ch_ops=${signSession({ email: 'f@x.com', exp: Date.now() + 60_000 }, 'sek')}`;
    const mint = await app.request(`/admin/quote/${q.id}/pay-link`, { method: 'POST', headers: { cookie } });
    const { url } = await mint.json();
    const t = new URL(url, 'http://x').searchParams.get('t')!;
    expect((await (await view(app, t)).json()).state).toBe('payable');
  });
});
