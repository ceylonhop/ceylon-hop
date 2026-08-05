import { describe, it, expect } from 'vitest';
import { createApp as realCreateApp, type AppDeps } from '../app';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { quote as priceQuote } from '../quote/engine';
import { RATE_CARD } from '../quote/rateCard';
import { payLines, selectionAmountCents } from '../quote/paySelection';
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

  // OWNER-HIT IN PROD, 2026-08-02. Q-2J358 pointed at a CANCELLED booking, /start kept handing
  // that booking back, /bookings/:id/checkout correctly refused it (409 not_chargeable), and the
  // PayHere window never opened — the customer only saw "we couldn't start your payment".
  // Permanently: the resume consults convertedBookingId BEFORE the revision-scoped key, so even
  // a new quote revision returned the same dead booking.
  it('a CANCELLED booking must not brick the quote — start mints a fresh one', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const q = await readyQuote(quotes);
    const app = createApp({ quotes, bookings });
    const token = signQuotePayToken(q.id, q.revision, SECRET);

    const first = (await (await start(app, token)).json()).bookingId;
    await bookings.setStatus(first, 'cancelled');

    const second = (await (await start(app, token)).json()).bookingId;
    expect(second).not.toBe(first);                                   // not the dead one
    const fresh = await bookings.get(second);
    expect(fresh?.status).toBe('payment_pending');                    // chargeable again
    // …and the quote now points at the live booking, not the corpse.
    expect((await quotes.get(q.id))?.convertedBookingId).toBe(second);
  });

  it('a double tap after a cancellation still yields ONE booking, not two', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const q = await readyQuote(quotes);
    const app = createApp({ quotes, bookings });
    const token = signQuotePayToken(q.id, q.revision, SECRET);
    await bookings.setStatus((await (await start(app, token)).json()).bookingId, 'cancelled');
    const [a, b] = await Promise.all([start(app, token), start(app, token)]);
    expect((await a.json()).bookingId).toBe((await b.json()).bookingId);
  });

  it('a PAYMENT_PENDING booking is still resumed, not duplicated', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const q = await readyQuote(quotes);
    const app = createApp({ quotes, bookings });
    const token = signQuotePayToken(q.id, q.revision, SECRET);
    const first = (await (await start(app, token)).json()).bookingId;
    expect((await (await start(app, token)).json()).bookingId).toBe(first);
  });

  // A resumed booking used to keep the payer captured on the FIRST attempt forever. Everything
  // the gateway sees is read from the booking row, so a payer who mistyped their address, was
  // declined, and corrected it was re-sent the bad address — and since those fields feed the
  // issuer's 3DS risk decision, the retry was arguably worse off than the original attempt.
  it('resuming re-records the payer, so a corrected address is the one that gets charged', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const q = await readyQuote(quotes);
    const app = createApp({ quotes, bookings });
    const token = signQuotePayToken(q.id, q.revision, SECRET);

    const typo = { address: '1 A St', city: 'Colombo', country: 'Sri Lanka' };
    const first = (await (await start(app, token, CUSTOMER, typo)).json()).bookingId;

    const fixed = { address: '31 River Court, Apt 105', city: 'Jersey City', country: 'United States', postcode: '07310' };
    const corrected = { ...CUSTOMER, firstName: 'Roshen', lastName: 'Weliwatta', email: 'roshen@x.com' };
    const again = (await (await start(app, token, corrected, fixed)).json()).bookingId;

    expect(again).toBe(first); // still one booking — this is a resume, not a duplicate
    const b = await bookings.get(first);
    expect(b?.billing).toMatchObject(fixed);
    expect(b?.input.customer).toMatchObject({ firstName: 'Roshen', lastName: 'Weliwatta', email: 'roshen@x.com' });
  });

  // The acceptance must belong to whoever is actually paying. This bit REAL MONEY on 2026-08-02:
  // a stray /start created the booking, the owner then paid the link, and the row kept the first
  // submitter's identity AND their terms timestamp — so the one field whose entire purpose is
  // evidence of who agreed described a different person than the one who was charged.
  it('resuming re-records the terms acceptance, not just the payer', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const q = await readyQuote(quotes);
    const app = createApp({ quotes, bookings });
    const token = signQuotePayToken(q.id, q.revision, SECRET);

    const id = (await (await start(app, token)).json()).bookingId;
    const firstAccepted = (await bookings.get(id))?.termsAcceptedAt;
    expect(firstAccepted).toBeTruthy();

    await new Promise((r) => setTimeout(r, 5)); // so a NEW timestamp is distinguishable
    await start(app, token, { ...CUSTOMER, email: 'someone-else@x.com' });

    const after = await bookings.get(id);
    expect(after?.input.customer.email).toBe('someone-else@x.com');
    expect(after?.termsAcceptedAt).not.toBe(firstAccepted);
    expect(Date.parse(String(after?.termsAcceptedAt))).toBeGreaterThan(Date.parse(String(firstAccepted)));
  });

  it('a resume with no billing keeps what was already captured rather than blanking it', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const q = await readyQuote(quotes);
    const app = createApp({ quotes, bookings });
    const token = signQuotePayToken(q.id, q.revision, SECRET);
    const billing = { address: 'Prinsengracht 263', city: 'Amsterdam', country: 'Netherlands' };
    const id = (await (await start(app, token, CUSTOMER, billing)).json()).bookingId;
    await start(app, token); // no billing this time
    expect((await bookings.get(id))?.billing).toMatchObject(billing);
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

// ── Partial-leg links (spec 2026-08-04) ────────────────────────────────────────────────
const ENGINE3 = {
  product: 'private' as const, vehicle: 'car' as const, pax: 2, bags: 1,
  legs: [
    { from: 'Colombo', to: 'Kandy', distanceKm: 120 },
    { from: 'Kandy', to: 'Ella', distanceKm: 140 },
    { from: 'Ella', to: 'Galle', distanceKm: 200 },
  ],
};

// A REAL priced 3-leg quote plus a stored selection, minted through the repo the way the mint
// route does. payLines reads result.lineItems, so a hand-written result would test nothing.
async function partialQuote(
  quotes: InMemoryQuoteRepo,
  sel: { legIndexes: number[]; extraIndexes: number[] },
  seq = 1,
) {
  const result = priceQuote(ENGINE3, RATE_CARD);
  const q = await quotes.save({
    channel: 'ops', product: 'private', vehicle: 'car', customerName: 'Nimal Perera',
    customerContact: 'nimal@x.com', totalCents: result.totalCents, currency: 'USD',
    rateCardVersion: RATE_CARD.version, result,
    request: { tool: { vehicle: 'car', passengerCount: 2, luggageCount: 1, legs: [] }, engine: ENGINE3 },
  });
  await quotes.patch(q.id, { status: 'pending_review' });
  await quotes.patch(q.id, { status: 'ready' });
  const soldCents = selectionAmountCents(payLines(q), sel);
  const saved = (await quotes.patch(q.id, { payLinkSelection: sel, soldCents, payLinkSeq: seq }))!;
  return { quote: saved, soldCents, token: signQuotePayToken(saved.id, saved.revision, SECRET, seq) };
}

describe('GET /quotes/pay/view for a partial link', () => {
  it('shows the picked lines, the coverage and the sold total', async () => {
    const quotes = new InMemoryQuoteRepo();
    const { token, soldCents, quote: q } = await partialQuote(quotes, { legIndexes: [0, 1], extraIndexes: [] });
    const body = await (await view(createApp({ quotes }), token)).json();
    expect(body.state).toBe('payable');
    expect(body.totals.cents).toBe(soldCents);
    expect(body.totals.cents).toBeLessThan(q.totalCents);
    expect(body.coverage).toEqual({ soldLegs: 2, totalLegs: 3 });
    expect(body.lines).toHaveLength(2);
    expect(body.lines[0].label).toContain('Colombo');
    // Hand-picked projection: label + amount only, never the internal kind/index.
    expect(Object.keys(body.lines[0]).sort()).toEqual(['amountCents', 'label']);
  });

  it('leaks no margin, hot-zone or rate-card data', async () => {
    const quotes = new InMemoryQuoteRepo();
    const { token } = await partialQuote(quotes, { legIndexes: [0], extraIndexes: [] });
    const raw = await (await view(createApp({ quotes }), token)).text();
    expect(raw).not.toMatch(/margin|hotZone|rateCardJson/i);
  });

  it('a link whose seq is stale renders revised, and cannot be started', async () => {
    const quotes = new InMemoryQuoteRepo();
    const { token, quote: q } = await partialQuote(quotes, { legIndexes: [0], extraIndexes: [] }, 1);
    const app = createApp({ quotes, bookings: new InMemoryBookingRepo() });
    // Ops re-picks: seq moves to 2, the customer is still holding the seq-1 link.
    await quotes.patch(q.id, { payLinkSelection: { legIndexes: [1], extraIndexes: [] }, soldCents: 1000, payLinkSeq: 2 });
    expect((await (await view(app, token)).json()).state).toBe('revised');
    const res = await start(app, token);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('quote_revised');
  });

  it('a full-quote link is unchanged — no lines, no coverage', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await readyQuote(quotes);
    const body = await (await view(createApp({ quotes }), signQuotePayToken(q.id, q.revision, SECRET))).json();
    expect(body.state).toBe('payable');
    expect(body.lines).toBeUndefined();
    expect(body.coverage).toBeUndefined();
    expect(body.totals.cents).toBe(q.totalCents);
  });
});
