import { describe, it, expect } from 'vitest';
import { createApp as realCreateApp, type AppDeps } from '../app';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { quote as priceQuote } from '../quote/engine';
import { RATE_CARD } from '../quote/rateCard';
import { payLines, selectionAmountCents } from '../quote/paySelection';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { signQuotePayToken, verifyCheckoutToken } from '../lib/bookingToken';
import { signSession } from '../lib/opsAuth';
import { futureIsoDate } from '../testSupport/dates';
import { depositFor } from '../quote/extrasDeposit';

// The customer-facing half of pay links (spec §3–§5). Everything here is reachable by
// anyone holding the URL, so the two properties that matter most are pinned hard:
// margin can never appear on the wire, and no state ever lets the wrong amount be paid.

const SECRET = 'test-link-secret';
const AUTH = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };
type App = ReturnType<typeof realCreateApp>;
const createApp = (deps: AppDeps = {}): App =>
  realCreateApp({ auth: AUTH, adminApiKey: 'k', bookingLinkSecret: SECRET, ...deps });

const CUSTOMER = { firstName: 'Nimal', lastName: 'Perera', email: 'nimal@x.com', whatsapp: '+94770001111', country: 'LK' };

async function readyQuote(quotes: InMemoryQuoteRepo, opts: { product?: 'private' | 'chauffeur' | 'shared'; legs?: unknown[]; status?: 'ready' | 'sent'; marginCents?: number; contact?: string; totalCents?: number; resultExtra?: Record<string, unknown> } = {}) {
  const product = opts.product ?? 'private';
  // Written at SAVE, not patched on afterwards: `patch` deliberately exposes neither totalCents
  // nor result — a stored price is not something a status update may quietly move.
  const totalCents = opts.totalCents ?? 21900;
  const legs = opts.legs ?? [{ from: 'Colombo Airport (CMB)', to: 'Galle', distanceKm: 120, date: '2026-09-01', category: 'transfer' }];
  const q = await quotes.save({
    channel: 'ops', product, vehicle: 'car', customerName: 'Nimal Perera', customerContact: opts.contact ?? '+94 77 000 1111',
    totalCents, currency: 'USD', rateCardVersion: 'v1',
    marginCents: opts.marginCents ?? 4300,
    request: {
      tool: { vehicle: 'car', passengerCount: 2, luggageCount: 1, legs },
      engine: product === 'chauffeur'
        ? { product, vehicle: 'car', pax: 2, bags: 1, firstDate: '2026-09-01', lastDate: '2026-09-06', travelDays: [{ date: '2026-09-01', from: 'CMB', to: 'Galle', distanceKm: 120 }] }
        : { product, vehicle: 'car', pax: 2, bags: 1, legs: [{ from: 'CMB', to: 'Galle', distanceKm: 120 }] },
    },
    result: { totalCents, marginEstimateCents: 4300, lineItems: [{ label: 'x', amountCents: totalCents, meta: { hotZone: 'Ella +15%' } }], ...opts.resultExtra },
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

  // The add-ons the quote charged are named on the pay page (copy.addOns) and on the keepsake pass.
  it('names the quote’s add-ons on the pay page and on the paid pass', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const app = createApp({ quotes, bookings, payments });
    const q = await readyQuote(quotes, {
      resultExtra: { lineItems: [
        { label: 'CMB → Galle (car)', amountCents: 20900 },
        { label: 'Waiting fee — CMB → Galle', amountCents: 1000, meta: { kind: 'extra', code: 'waiting', legIndex: 0 } },
      ] },
    });
    const t = signQuotePayToken(q.id, q.revision, SECRET);
    expect((await (await view(app, t)).json()).copy.addOns).toEqual(['Waiting up to 3hrs']);

    await start(app, t);
    const booking = (await bookings.list())[0];
    const p = await payments.create({ bookingId: booking.id, provider: 'payhere', orderId: booking.reference, amount: 21900, currency: 'USD', idempotencyKey: `checkout:${booking.id}` });
    await payments.markSucceeded(p.id);
    const paid = await (await view(app, t)).json();
    expect(paid.state).toBe('paid');
    expect(paid.paid.addOns).toEqual(['Waiting up to 3hrs']);
  });
});

// The founder's negotiation, carried onto the pay page (owner, 2026-08-10): "show the discount
// amount, we are not going to pass any of that to PayHere — this is just to keep reminding
// customers they are getting a discount". So it is presentation ONLY: `totals` stays the single
// post-discount figure the gateway is handed, and these two extra strings sit above it.
describe('GET /quotes/pay/view — the discount a customer was given', () => {
  /**
   * A $208 trip discounted by $30. The stored total is 17800 because the engine prices WITH the
   * discount applied (#422) — that ordering is the whole reason these three numbers reconcile.
   */
  const discountedQuote = (quotes: InMemoryQuoteRepo, resultExtra: Record<string, unknown>) =>
    readyQuote(quotes, { totalCents: 17800, resultExtra });

  it('shows what the trip was, what came off, and what is actually paid', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await discountedQuote(quotes, { totalBeforeDiscountCents: 20800, discountCents: 3000 });
    const body = await (await view(createApp({ quotes }), signQuotePayToken(q.id, q.revision, SECRET))).json();
    expect(body.state).toBe('payable');
    expect(body.discount).toEqual({ totalBeforeUsd: '$208.00', discountUsd: '$30.00' });
    // The charge is untouched: the engine already priced with the discount applied, so the
    // number PayHere is handed is the same one it was handed before this block existed.
    expect(body.totals).toEqual({ cents: 17800, usd: '$178.00' });
  });

  it('derives the pre-discount total when the stored result predates the finishing reorder', async () => {
    // #422 renamed discountedSubtotalCents → totalBeforeDiscountCents. A quote discounted before
    // that deploy carries neither, and requiring the new field is exactly what made the breakdown
    // vanish on the customer quote page (#424) — the same trap, one page over.
    const quotes = new InMemoryQuoteRepo();
    const q = await discountedQuote(quotes, { discountCents: 3000 });
    const body = await (await view(createApp({ quotes }), signQuotePayToken(q.id, q.revision, SECRET))).json();
    expect(body.discount).toEqual({ totalBeforeUsd: '$208.00', discountUsd: '$30.00' });
  });

  it('says nothing at all when no discount was given', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await readyQuote(quotes);
    const body = await (await view(createApp({ quotes }), signQuotePayToken(q.id, q.revision, SECRET))).json();
    expect(body.discount).toBeUndefined();
  });

  it('a zero discount is not a discount', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await discountedQuote(quotes, { totalBeforeDiscountCents: 17800, discountCents: 0 });
    const body = await (await view(createApp({ quotes }), signQuotePayToken(q.id, q.revision, SECRET))).json();
    expect(body.discount).toBeUndefined();
  });

  it('stays off a SUBSET link, whose lines could not be reconciled with it', async () => {
    // The per-leg lines sum to the subtotal while the discount sits between subtotal and total,
    // so printing one over a subset would imply an allocation across the ticked legs that nobody
    // authorised — the same reasoning that keeps a subset link from being minted at all (#428).
    const quotes = new InMemoryQuoteRepo();
    const { token } = await partialQuote(quotes, { legIndexes: [0, 1], extraIndexes: [] }, 1, {
      totalBeforeDiscountCents: 20800, discountCents: 3000,
    });
    const body = await (await view(createApp({ quotes }), token)).json();
    expect(body.state).toBe('payable');
    expect(body.discount).toBeUndefined();
  });
});

describe('POST /quotes/pay/start — the booking is born at pay-commit', () => {
  it('creates one booking at the frozen total; the quote stays sent', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo({ transitionTrackingEnabled: true });
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
    expect(await bookings.listStatusEvents(bookingId)).toEqual([
      expect.objectContaining({
        source: 'quote_conversion', actorType: 'customer', actorId: CUSTOMER.email,
        relatedEntityType: 'quote', relatedEntityId: q.id, requestId: expect.any(String),
      }),
    ]);

    // The checkout token actually opens a checkout on the fake gateway.
    const co = await app.request(`/bookings/${bookingId}/checkout`, {
      method: 'POST', headers: { authorization: `Bearer ${checkoutToken}` },
    });
    expect(co.status).toBe(200);
    expect((await co.json()).amount).toBe(21900);
  });

  // CH-T74DT: the pay page shares CustomerInput with the website booker, so it refuses the same
  // impossible number — and /start already words the refusal per field, which pay.html shows.
  it('refuses an impossible WhatsApp number before any booking is born (CH-T74DT)', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ quotes, bookings });
    const q = await readyQuote(quotes);
    const t = signQuotePayToken(q.id, q.revision, SECRET);
    const res = await start(app, t, { ...CUSTOMER, whatsapp: '+94123134124123412312312312' });
    expect(res.status).toBe(400);
    const out = await res.json();
    expect(out.error).toBe('bad_request');
    expect(out.message).toContain('customer.whatsapp');
    expect((await quotes.get(q.id))?.convertedBookingId).toBeFalsy();
  });

  // GA4 item reports (spec 2026-10-03 D1-alt): the browser `purchase` must carry the same item
  // the server's purchase hit does, so pay.html is handed it here — the booking is born at /start.
  it('hands back the GA4 item for the browser purchase, on a fresh start and on a resume', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ quotes, bookings });
    const q = await readyQuote(quotes);
    const t = signQuotePayToken(q.id, q.revision, SECRET);
    const item = {
      item_id: 'Colombo Airport (CMB) → Galle', item_name: 'Colombo Airport (CMB) → Galle',
      item_category: 'private', item_category2: 'Airport & Negombo', item_category3: 'South coast',
      item_category4: 'transfer',
    };
    expect((await (await start(app, t)).json()).ga4Item).toEqual(item);
    expect((await (await start(app, t)).json()).ga4Item).toEqual(item);
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

// ── Deposit or full, chosen by the customer on the link (spec 2026-10-07 §5.2, rev. 2026-10-08) ──
const startPaying = (app: App, t: string, payment: unknown) =>
  startRaw(app, { t, customer: CUSTOMER, termsAccepted: true, payment });

// Deposits are for CHAUFFEUR trips only (owner, 2026-10-12): every deposit case below is built on one.
const CHAUFFEUR = { product: 'chauffeur' as const };

describe('GET /quotes/pay/view — the deposit option', () => {
  it('offers the deposit on an eligible whole-trip link; totals stay the trip total', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await readyQuote(quotes, CHAUFFEUR); // chauffeur, $219.00
    const body = await (await view(createApp({ quotes }), signQuotePayToken(q.id, q.revision, SECRET))).json();
    expect(body.deposit).toEqual({ cents: 5000, usd: '$50.00', balanceCents: 16900, balanceUsd: '$169.00' });
    expect(body.totals).toEqual({ cents: 21900, usd: '$219.00' });
  });

  it('offers it on a chauffeur trip too, at 10% above $500', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await readyQuote(quotes, { product: 'chauffeur', totalCents: 80000 });
    const body = await (await view(createApp({ quotes }), signQuotePayToken(q.id, q.revision, SECRET))).json();
    expect(body.deposit).toEqual({ cents: 8000, usd: '$80.00', balanceCents: 72000, balanceUsd: '$720.00' });
  });

  it('omits it below the $150 floor (the boundary is $150, not $149.99)', async () => {
    const quotes = new InMemoryQuoteRepo();
    const low = await readyQuote(quotes, { ...CHAUFFEUR, totalCents: 14999 });
    const lowBody = await (await view(createApp({ quotes }), signQuotePayToken(low.id, low.revision, SECRET))).json();
    expect(lowBody).not.toHaveProperty('deposit');
    const edge = await readyQuote(quotes, { ...CHAUFFEUR, totalCents: 15000 });
    const edgeBody = await (await view(createApp({ quotes }), signQuotePayToken(edge.id, edge.revision, SECRET))).json();
    expect(edgeBody.deposit).toMatchObject({ cents: 5000, balanceCents: 10000 });
  });

  it('omits it for a shared-product quote', async () => {
    const quotes = new InMemoryQuoteRepo();
    // A shared quote is not mintable as a pay link, but the helper must refuse it on its own.
    const q = await readyQuote(quotes, { product: 'shared' });
    const body = await (await view(createApp({ quotes }), signQuotePayToken(q.id, q.revision, SECRET))).json();
    expect(body.state).toBe('payable');
    expect(body).not.toHaveProperty('deposit');
  });

  // Owner, 2026-10-12 (testing on staging): "deposits are only allowed for chauffeur bookings" — a
  // $187 three-journey private quote was offering one.
  it('omits it on a private transfer, however much it costs — and refuses one that is asked for anyway', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ quotes, bookings });
    const q = await readyQuote(quotes, { product: 'private', totalCents: 60000 });
    const t = signQuotePayToken(q.id, q.revision, SECRET);
    const body = await (await view(app, t)).json();
    expect(body.state).toBe('payable');
    expect(body).not.toHaveProperty('deposit');
    const res = await startPaying(app, t, 'deposit');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('deposit_ineligible');
    // …and paying in full is untouched.
    const full = await (await startPaying(app, t, 'full')).json();
    expect((await bookings.get(full.bookingId))!.amountDueNow).toBe(60000);
  });

  it('omits it on a part-of-trip link, whatever the sold amount', async () => {
    const quotes = new InMemoryQuoteRepo();
    const { quote, token } = await partialQuote(quotes, { legIndexes: [0, 1], extraIndexes: [] });
    // Make the sold amount deposit-sized, so only the selection itself can rule the offer out.
    await quotes.patch(quote.id, { soldCents: 20000 });
    expect(quote.totalCents).toBeGreaterThanOrEqual(15000);
    const body = await (await view(createApp({ quotes }), token)).json();
    expect(body.state).toBe('payable');
    expect(body).not.toHaveProperty('deposit');
  });
});

describe('POST /quotes/pay/start — the customer’s choice', () => {
  it('payment:"deposit" writes amountDueNow = the deposit, total stays the trip total', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const q = await readyQuote(quotes, CHAUFFEUR);
    const res = await startPaying(createApp({ quotes, bookings }), signQuotePayToken(q.id, q.revision, SECRET), 'deposit');
    expect(res.status).toBe(201);
    const b = (await bookings.get((await res.json()).bookingId))!;
    expect(b.total).toBe(21900);
    expect(b.amountDueNow).toBe(5000);
  });

  it('payment:"full" and no payment key both charge the whole total (default lane unchanged)', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ quotes, bookings });
    const a = await readyQuote(quotes, CHAUFFEUR);
    const full = await startPaying(app, signQuotePayToken(a.id, a.revision, SECRET), 'full');
    expect((await bookings.get((await full.json()).bookingId))!.amountDueNow).toBe(21900);
    const b = await readyQuote(quotes, CHAUFFEUR);
    const bare = await start(app, signQuotePayToken(b.id, b.revision, SECRET));
    expect((await bookings.get((await bare.json()).bookingId))!.amountDueNow).toBe(21900);
  });

  it('refuses a deposit on an ineligible quote: 409 deposit_ineligible, no booking born', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const q = await readyQuote(quotes, { ...CHAUFFEUR, totalCents: 14999 });
    const res = await startPaying(createApp({ quotes, bookings }), signQuotePayToken(q.id, q.revision, SECRET), 'deposit');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'deposit_ineligible' });
    expect(await bookings.list()).toHaveLength(0);
  });

  it('refuses a deposit on a part-of-trip link', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const { token } = await partialQuote(quotes, { legIndexes: [0, 1], extraIndexes: [] });
    const res = await startPaying(createApp({ quotes, bookings }), token, 'deposit');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'deposit_ineligible' });
    expect(await bookings.list()).toHaveLength(0);
  });

  it('rejects an unknown payment value with 400', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await readyQuote(quotes, CHAUFFEUR);
    const res = await startPaying(createApp({ quotes }), signQuotePayToken(q.id, q.revision, SECRET), 'cash');
    expect(res.status).toBe(400);
  });

  it('a resumed start that switches the choice rewrites amountDueNow — same booking, both ways', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ quotes, bookings });
    const q = await readyQuote(quotes, CHAUFFEUR);
    const t = signQuotePayToken(q.id, q.revision, SECRET);
    const first = await (await startPaying(app, t, 'deposit')).json();
    expect((await bookings.get(first.bookingId))!.amountDueNow).toBe(5000);
    const second = await (await startPaying(app, t, 'full')).json();
    expect(second.bookingId).toBe(first.bookingId);
    expect((await bookings.get(first.bookingId))!.amountDueNow).toBe(21900);
    const third = await (await startPaying(app, t, 'deposit')).json();
    expect(third.bookingId).toBe(first.bookingId);
    expect((await bookings.get(first.bookingId))!.amountDueNow).toBe(5000);
  });

  it('a resumed start with no payment key puts a deposit booking back on full', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ quotes, bookings });
    const q = await readyQuote(quotes, CHAUFFEUR);
    const t = signQuotePayToken(q.id, q.revision, SECRET);
    const first = await (await startPaying(app, t, 'deposit')).json();
    await start(app, t); // an older cached pay.html: no `payment` at all
    expect((await bookings.get(first.bookingId))!.amountDueNow).toBe(21900);
  });

  // After a cancellation every later start resolves under the `:after:<cancelled id>` key, not the
  // base key — that replacement booking must follow the choice exactly as a first booking does.
  it('after a cancellation, the replacement booking follows a deposit → full switch (and charges REF)', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const app = createApp({ quotes, bookings, payments });
    const q = await readyQuote(quotes, CHAUFFEUR);
    const t = signQuotePayToken(q.id, q.revision, SECRET);
    await bookings.setStatus((await (await start(app, t)).json()).bookingId, 'cancelled');

    const b2 = await (await startPaying(app, t, 'deposit')).json();
    expect((await bookings.get(b2.bookingId))!.amountDueNow).toBe(5000);
    const again = await (await startPaying(app, t, 'full')).json();
    expect(again.bookingId).toBe(b2.bookingId);
    expect((await bookings.get(b2.bookingId))!.amountDueNow).toBe(21900);

    const co = await (await app.request(`/bookings/${b2.bookingId}/checkout`, {
      method: 'POST', headers: { authorization: `Bearer ${again.checkoutToken}` },
    })).json();
    expect(co.amount).toBe(21900);
    const [row] = await payments.findByBookingId(b2.bookingId);
    expect(row).toMatchObject({ amount: 21900, purpose: 'full', orderId: (await bookings.get(b2.bookingId))!.reference });
  });

  it('after a cancellation, the replacement booking follows a full → deposit switch', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ quotes, bookings });
    const q = await readyQuote(quotes, CHAUFFEUR);
    const t = signQuotePayToken(q.id, q.revision, SECRET);
    await bookings.setStatus((await (await start(app, t)).json()).bookingId, 'cancelled');

    const b2 = await (await startPaying(app, t, 'full')).json();
    expect((await bookings.get(b2.bookingId))!.amountDueNow).toBe(21900);
    const again = await (await startPaying(app, t, 'deposit')).json();
    expect(again.bookingId).toBe(b2.bookingId);
    expect((await bookings.get(b2.bookingId))!.amountDueNow).toBe(5000);
  });

  it('the replacement booking also takes the corrected payer details on a resume', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ quotes, bookings });
    const q = await readyQuote(quotes, CHAUFFEUR);
    const t = signQuotePayToken(q.id, q.revision, SECRET);
    await bookings.setStatus((await (await start(app, t)).json()).bookingId, 'cancelled');
    const b2 = await (await start(app, t)).json();
    await start(app, t, { ...CUSTOMER, firstName: 'Corrected' });
    expect((await bookings.get(b2.bookingId))!.input.customer.firstName).toBe('Corrected');
  });

  it('a resume refused as ineligible leaves the booking exactly as it was', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ quotes, bookings });
    const { token } = await partialQuote(quotes, { legIndexes: [0, 1], extraIndexes: [] });
    const first = await (await start(app, token)).json();
    const res = await startPaying(app, token, 'deposit');
    expect(res.status).toBe(409);
    const b = (await bookings.get(first.bookingId))!;
    expect(b.amountDueNow).toBe(b.total);
  });
});

// ── The balance, on the same pay link (spec 2026-10-07 §5.3, rev. 2026-10-08) ──
const payBalance = (app: App, t: string) =>
  app.request('/quotes/pay/balance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t }) });

// A quote whose customer paid the deposit on its link: booking `paid`, a succeeded `deposit` row,
// the quote claimed `won` (settlement does that), and the link still in the customer's hands.
async function depositPaid(opts: { balanceStatus?: 'succeeded' | 'pending' } = {}) {
  const quotes = new InMemoryQuoteRepo();
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const app = createApp({ quotes, bookings, payments });
  const q = await readyQuote(quotes, CHAUFFEUR);
  const t = signQuotePayToken(q.id, q.revision, SECRET);
  const { bookingId } = await (await startPaying(app, t, 'deposit')).json();
  const booking = (await bookings.get(bookingId))!;
  const dep = await payments.create({ bookingId, provider: 'payhere', orderId: `${booking.reference}-D`, amount: 5000, currency: 'USD', idempotencyKey: `checkout:${bookingId}:deposit`, purpose: 'deposit' });
  await payments.markSucceeded(dep.id);
  const rec = payments.getForSettlement(dep.id)!;
  payments.putForSettlement({ ...rec, settledAt: new Date('2026-10-05T08:00:00Z') });
  await bookings.setStatus(bookingId, 'paid');
  await quotes.patch(q.id, { status: 'won' });
  if (opts.balanceStatus) {
    const bal = await payments.create({ bookingId, provider: 'payhere', orderId: `${booking.reference}-B`, amount: 16900, currency: 'USD', idempotencyKey: `checkout:${bookingId}:balance`, purpose: 'balance' });
    if (opts.balanceStatus === 'succeeded') await payments.markSucceeded(bal.id);
  }
  return { quotes, bookings, payments, app, q, t, bookingId, booking };
}

describe('GET /quotes/pay/view — the balance state', () => {
  it('a paid deposit reopens as the balance state, with the paid/balance figures', async () => {
    const { app, t } = await depositPaid();
    const body = await (await view(app, t)).json();
    expect(body.state).toBe('balance');
    expect(body.balance).toMatchObject({
      title: 'Six days across Sri Lanka', totalUsd: '$219.00', paidUsd: '$50.00',
      paidOn: '2026-10-05', balanceCents: 16900, balanceUsd: '$169.00',
    });
  });

  // Owner, 2026-10-12: the screen a customer lands on after paying a deposit must read as
  // "you're booked", not as an invoice — so it needs the trip, the booking reference and a name,
  // and which product it is (a chauffeur trip's balance is "due on your arrival day").
  it('carries what the "you\'re booked" screen shows: reference, first name and the trip copy', async () => {
    const { app, t, booking } = await depositPaid();
    const { balance } = await (await view(app, t)).json();
    expect(balance.reference).toBe(booking.reference);
    expect(balance.firstName).toBe('Nimal');
    expect(balance.copy).toMatchObject({ product: 'chauffeur', title: 'Six days across Sri Lanka' });
    expect(Array.isArray(balance.copy.facts)).toBe(true);
  });

  it('shows the balance whatever the token\'s revision or seq (checked before them, like paid)', async () => {
    const { app, quotes, q } = await depositPaid();
    await quotes.patch(q.id, { status: 'won' });
    const stale = signQuotePayToken(q.id, q.revision + 7, SECRET, 3);
    expect((await (await view(app, stale)).json()).state).toBe('balance');
  });

  it('once the balance lands the link shows the paid keepsake', async () => {
    const { app, t } = await depositPaid({ balanceStatus: 'succeeded' });
    const body = await (await view(app, t)).json();
    expect(body.state).toBe('paid');
    expect(body).not.toHaveProperty('balance');
    // The keepsake states what the trip cost in total, not just the first payment ($50 deposit).
    expect(body.paid.amountUsd).toBe('$219.00');
  });

  it('a pending (unfinished) balance attempt still reads as balance', async () => {
    const { app, t } = await depositPaid({ balanceStatus: 'pending' });
    expect((await (await view(app, t)).json()).state).toBe('balance');
  });

  it('a fully-paid booking is paid, unchanged', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const app = createApp({ quotes, bookings, payments });
    const q = await readyQuote(quotes, CHAUFFEUR);
    const t = signQuotePayToken(q.id, q.revision, SECRET);
    const { bookingId } = await (await start(app, t)).json();
    const p = await payments.create({ bookingId, provider: 'payhere', orderId: 'x', amount: 21900, currency: 'USD', idempotencyKey: 'k' });
    await payments.markSucceeded(p.id);
    await bookings.setStatus(bookingId, 'paid');
    expect((await (await view(app, t)).json()).state).toBe('paid');
  });

  it('a cancelled deposit booking is not a balance state', async () => {
    const { app, t, bookings, bookingId } = await depositPaid();
    await bookings.setStatus(bookingId, 'cancelled');
    expect((await (await view(app, t)).json()).state).toBe('paid');
  });

  it('a deposit still pending (not succeeded) is not a balance state', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const app = createApp({ quotes, bookings, payments });
    const q = await readyQuote(quotes, CHAUFFEUR);
    const t = signQuotePayToken(q.id, q.revision, SECRET);
    const { bookingId } = await (await startPaying(app, t, 'deposit')).json();
    await payments.create({ bookingId, provider: 'payhere', orderId: 'x-D', amount: 5000, currency: 'USD', idempotencyKey: 'kd', purpose: 'deposit' });
    expect((await (await view(app, t)).json()).state).toBe('payable');
  });
});

describe('POST /quotes/pay/balance', () => {
  it('hands back the booking and a checkout token while the balance is open', async () => {
    const { app, t, bookingId } = await depositPaid();
    const res = await payBalance(app, t);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bookingId).toBe(bookingId);
    expect(verifyCheckoutToken(body.checkoutToken, bookingId, SECRET, Date.now())).toBe(true);
  });

  it('409 no_balance_due once the balance has been paid', async () => {
    const { app, t } = await depositPaid({ balanceStatus: 'succeeded' });
    const res = await payBalance(app, t);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('no_balance_due');
  });

  it('409 no_balance_due on a full-paid, a cancelled and a not-yet-paid booking', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const app = createApp({ quotes, bookings, payments });
    const q = await readyQuote(quotes, CHAUFFEUR);
    const t = signQuotePayToken(q.id, q.revision, SECRET);
    // not yet paid: only a started booking
    const { bookingId } = await (await start(app, t)).json();
    expect((await payBalance(app, t)).status).toBe(409);
    // full-paid
    const p = await payments.create({ bookingId, provider: 'payhere', orderId: 'x', amount: 21900, currency: 'USD', idempotencyKey: 'k' });
    await payments.markSucceeded(p.id);
    await bookings.setStatus(bookingId, 'paid');
    const full = await payBalance(app, t);
    expect(full.status).toBe(409);
    expect((await full.json()).error).toBe('no_balance_due');
    // cancelled deposit booking
    const dp = await depositPaid();
    await dp.bookings.setStatus(dp.bookingId, 'cancelled');
    expect((await payBalance(dp.app, dp.t)).status).toBe(409);
  });

  it('a garbage token gets the same soft refusal /start gives (409 quote_unavailable)', async () => {
    const { app } = await depositPaid();
    const res = await payBalance(app, 'garbage');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('quote_unavailable');
  });

  it('a missing body is a 400, not a crash', async () => {
    const { app } = await depositPaid();
    const res = await app.request('/quotes/pay/balance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(400);
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
  // Merged into the stored result. The one caller that uses it needs a subset link over a
  // DISCOUNTED quote, which cannot be built by patching — see readyQuote.
  resultExtra: Record<string, unknown> = {},
) {
  const result = { ...priceQuote(ENGINE3, RATE_CARD), ...resultExtra };
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

describe('POST /quotes/pay/start for a partial link', () => {
  it('creates a booking over the sold legs, at the sold amount', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const { token, soldCents } = await partialQuote(quotes, { legIndexes: [0, 1], extraIndexes: [] });
    const res = await start(createApp({ quotes, bookings }), token);
    expect(res.status).toBe(201);
    const booking = (await bookings.get((await res.json()).bookingId))!;
    expect(booking.total).toBe(soldCents);
    expect(booking.amountDueNow).toBe(soldCents);
    expect(booking.mode).toBe('trip');
    if (booking.mode === 'trip') expect(booking.input.stops).toEqual(['Colombo', 'Kandy', 'Ella']);
  });

  // THE bug this task exists to prevent (spec §9). Selection A leaves a payment_pending booking
  // AND stamps convertedBookingId; ops re-picks; the new link must not resume A's booking and
  // charge A's amount.
  it('does not resume a booking minted under a different selection', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ quotes, bookings });
    const a = await partialQuote(quotes, { legIndexes: [0, 1], extraIndexes: [] }, 1);
    const first = await (await start(app, a.token)).json();

    // Ops re-picks — one cheaper leg — and sends the new link.
    const q = (await quotes.get(a.quote.id))!;
    const selB = { legIndexes: [2], extraIndexes: [] };
    const soldB = selectionAmountCents(payLines(q), selB);
    await quotes.patch(q.id, { payLinkSelection: selB, soldCents: soldB, payLinkSeq: 2 });
    const tokenB = signQuotePayToken(q.id, q.revision, SECRET, 2);

    const second = await (await start(app, tokenB)).json();
    expect(second.bookingId).not.toBe(first.bookingId);
    const b = (await bookings.get(second.bookingId))!;
    expect(b.total).toBe(soldB);
    expect(b.total).not.toBe(a.soldCents);
    if (b.mode === 'single') expect(b.input.from).toBe('Ella');
  });

  it('a double tap on the SAME link still yields one booking', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ quotes, bookings });
    const { token } = await partialQuote(quotes, { legIndexes: [0], extraIndexes: [] });
    const a = await (await start(app, token)).json();
    const b = await (await start(app, token)).json();
    expect(b.bookingId).toBe(a.bookingId);
  });
});

// Four live bookings were recorded under the owner's name because a pay link was opened in a
// staff browser and Chrome autofilled the empty surname and email boxes (spec 2026-08-08).
describe('a visitor cannot become the customer', () => {
  const staffAuth = { opsUsers: 'f@x.com:founder,roshen@ceylonhop.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };
  const appWithStaff = (deps: AppDeps = {}) =>
    realCreateApp({ auth: staffAuth, adminApiKey: 'k', bookingLinkSecret: SECRET, ...deps });

  it('refuses a staff email on someone else’s quote', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const q = await readyQuote(quotes); // contact is the customer's phone
    const res = await start(
      appWithStaff({ quotes, bookings }),
      signQuotePayToken(q.id, q.revision, SECRET),
      { ...CUSTOMER, email: 'roshen@ceylonhop.com' },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('staff_email_not_customer');
    // …and nothing was created in their name.
    expect((await quotes.get(q.id))!.convertedBookingId).toBeNull();
  });

  it('lets a staff member pay their OWN quote', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    // Built with the staff address as the quote's OWN contact. It cannot be set afterwards:
    // customerContact is not patchable, and the in-memory get() returns a copy.
    const q = await readyQuote(quotes, { contact: 'roshen@ceylonhop.com' });
    const res = await start(
      appWithStaff({ quotes, bookings }),
      signQuotePayToken(q.id, q.revision, SECRET),
      { ...CUSTOMER, email: 'roshen@ceylonhop.com' },
    );
    expect(res.status).toBe(201);
  });

  it('leaves an ordinary customer completely alone', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const q = await readyQuote(quotes);
    const res = await start(appWithStaff({ quotes, bookings }), signQuotePayToken(q.id, q.revision, SECRET));
    expect(res.status).toBe(201);
  });

  it('accepts a customer who gives no surname — the box that invited the autofill', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const q = await readyQuote(quotes);
    // Built explicitly rather than destructured — a discarded `lastName` binding is an
    // unused-var lint error, and this states the point of the test more plainly anyway.
    const noSurname = {
      firstName: CUSTOMER.firstName, email: CUSTOMER.email,
      whatsapp: CUSTOMER.whatsapp, country: CUSTOMER.country,
    };
    const res = await start(appWithStaff({ quotes, bookings }), signQuotePayToken(q.id, q.revision, SECRET), noSurname as never);
    expect(res.status).toBe(201);
  });
});

// ── A pay link sold as the CHAUFFEUR option of a "both" quote (spec PR #964, PR 2: readers) ──
// Dormant until the mint (PR 3) writes `{ service: 'chauffeur' }`; these seed it directly onto a
// quote that /save really froze an alternative for, so the readers are tested against the shape the
// mint will produce. The row itself stays the point-to-point quote throughout.
describe('a link sold as the chauffeur option of a "both" quote', () => {
  const BOTH_BODY = {
    firstName: 'Nimal', vehicle: 'car', passengerCount: 2, luggageCount: 1, requestedService: 'both',
    legs: [
      { category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 115, date: futureIsoDate(30) },
      { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: futureIsoDate(32) },
    ],
  };
  const FOUNDER = `ch_ops=${signSession({ email: 'f@x.com', exp: Date.now() + 600_000 }, 'sek')}`;

  type AltResult = { totalCents: number };
  async function bothQuote(opts: { link?: boolean; soldCents?: number } = {}) {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const app = createApp({ quotes, bookings, payments });
    const res = await app.request('/admin/quote/save', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: FOUNDER }, body: JSON.stringify(BOTH_BODY),
    });
    expect([200, 201]).toContain(res.status);
    const { id } = await res.json();
    for (const s of ['pending_review', 'ready', 'sent'] as const) await quotes.patch(id, { status: s });
    const stored = (await quotes.get(id))!;
    const altTotal = ((stored.result as { alt: { result: AltResult } }).alt).result.totalCents;
    if (opts.link !== false) {
      // What the mint will write: the service selection, the alt total frozen as soldCents, a new seq.
      await quotes.patch(id, { payLinkSelection: { service: 'chauffeur' }, soldCents: opts.soldCents ?? altTotal, payLinkSeq: 1 });
    }
    const q = (await quotes.get(id))!;
    return { quotes, bookings, payments, app, q, altTotal, pointTotal: q.totalCents, t: signQuotePayToken(id, q.revision, SECRET, q.payLinkSeq) };
  }

  it('/view shows the chauffeur product at the frozen alt total, with the deposit offer — and no margin', async () => {
    const { app, t, altTotal, pointTotal } = await bothQuote();
    expect(altTotal).toBeGreaterThanOrEqual(15000); // guard: above the deposit floor
    expect(altTotal).not.toBe(pointTotal); // guard: the two options really differ
    const res = await view(app, t);
    const raw = await res.text();
    const body = JSON.parse(raw);
    expect(body.state).toBe('payable');
    expect(body.copy.product).toBe('chauffeur');
    expect(body.totals.cents).toBe(altTotal);
    expect(body.deposit).toMatchObject({ cents: depositFor('chauffeur', altTotal), balanceCents: altTotal - depositFor('chauffeur', altTotal) });
    expect(body).not.toHaveProperty('lines'); // not a part-of-trip link
    expect(body).not.toHaveProperty('coverage');
    expect(raw).not.toMatch(/margin|hotZone|"alt"|rateCard/i);
  });

  it('/start creates a chauffeur trip booking at the alt total', async () => {
    const { app, bookings, quotes, q, t, altTotal } = await bothQuote();
    const res = await start(app, t);
    expect(res.status).toBe(201);
    const b = (await bookings.get((await res.json()).bookingId))!;
    expect(b.mode).toBe('trip');
    expect((b as { input: { serviceType: string } }).input.serviceType).toBe('chauffeur');
    expect(b.total).toBe(altTotal);
    expect(b.amountDueNow).toBe(altTotal);
    expect((await quotes.get(q.id))!.convertedBookingId).toBe(b.id);
  });

  it('/start honours payment:"deposit" at the chauffeur deposit', async () => {
    const { app, bookings, t, altTotal } = await bothQuote();
    const res = await startPaying(app, t, 'deposit');
    expect(res.status).toBe(201);
    const b = (await bookings.get((await res.json()).bookingId))!;
    expect(b.total).toBe(altTotal);
    expect(b.amountDueNow).toBe(depositFor('chauffeur', altTotal));
  });

  it('a dangling selection (no alt behind it) is unavailable on /view and 409 on /start', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ quotes, bookings });
    const q = await readyQuote(quotes); // a plain private quote: nothing was ever frozen for it
    await quotes.patch(q.id, { payLinkSelection: { service: 'chauffeur' }, soldCents: 30000, payLinkSeq: 1 });
    const t = signQuotePayToken(q.id, q.revision, SECRET, 1);
    expect(await (await view(app, t)).json()).toEqual({ state: 'unavailable' });
    const res = await start(app, t);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('quote_unavailable');
    expect(await bookings.list()).toHaveLength(0);
  });

  it('a soldCents that is not the alt total is unavailable on /view and 409 on /start', async () => {
    const { app, bookings, t } = await bothQuote({ soldCents: 12345 });
    expect(await (await view(app, t)).json()).toEqual({ state: 'unavailable' });
    const res = await start(app, t);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('quote_unavailable');
    expect(await bookings.list()).toHaveLength(0);
  });

  it('after a deposit, the balance and paid states speak chauffeur and /balance still works', async () => {
    const { app, quotes, bookings, payments, q, t, altTotal } = await bothQuote();
    const { bookingId } = await (await startPaying(app, t, 'deposit')).json();
    const booking = (await bookings.get(bookingId))!;
    const dep = depositFor('chauffeur', altTotal);
    const p = await payments.create({ bookingId, provider: 'payhere', orderId: `${booking.reference}-D`, amount: dep, currency: 'USD', idempotencyKey: `checkout:${bookingId}:deposit`, purpose: 'deposit' });
    await payments.markSucceeded(p.id);
    await bookings.setStatus(bookingId, 'paid');
    await quotes.patch(q.id, { status: 'won' });

    const bal = await (await view(app, t)).json();
    expect(bal.state).toBe('balance');
    expect(bal.balance.copy.product).toBe('chauffeur');
    expect(bal.balance.totalUsd).toBe(`$${(altTotal / 100).toFixed(2)}`);
    expect((await payBalance(app, t)).status).toBe(200);

    // …and once the balance lands, the keepsake is headed by the chauffeur title, not the legs.
    const b2 = await payments.create({ bookingId, provider: 'payhere', orderId: `${booking.reference}-B`, amount: altTotal - dep, currency: 'USD', idempotencyKey: `checkout:${bookingId}:balance`, purpose: 'balance' });
    await payments.markSucceeded(b2.id);
    const paid = await (await view(app, t)).json();
    expect(paid.state).toBe('paid');
    expect(paid.paid.title).toBe(bal.balance.copy.title);
    expect(paid.paid.amountUsd).toBe(`$${(altTotal / 100).toFixed(2)}`);
  });

  // ── "As sold" follows the BOOKING once one exists, not the quote's current selection ──
  type Ctx = Awaited<ReturnType<typeof bothQuote>>;
  const settle = async (c: Ctx, bookingId: string, amount: number, purpose?: 'deposit' | 'balance') => {
    const booking = (await c.bookings.get(bookingId))!;
    const p = await c.payments.create({ bookingId, provider: 'payhere', orderId: `${booking.reference}-${purpose ?? 'F'}`, amount, currency: 'USD', idempotencyKey: `checkout:${bookingId}:${purpose ?? 'full'}`, ...(purpose ? { purpose } : {}) });
    await c.payments.markSucceeded(p.id);
    if (booking.status !== 'paid') await c.bookings.setStatus(bookingId, 'paid');
    await c.quotes.patch(c.q.id, { status: 'won' });
  };
  const switchLink = (c: Ctx, to: 'chauffeur' | 'point') =>
    c.quotes.patch(c.q.id, to === 'chauffeur'
      ? { payLinkSelection: { service: 'chauffeur' }, soldCents: c.altTotal, payLinkSeq: 7 }
      : { payLinkSelection: null, soldCents: null, payLinkSeq: 8 });
  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  it('a PRIVATE booking paid after the link was switched to chauffeur is still described as private', async () => {
    const c = await bothQuote({ link: false });
    const { bookingId } = await (await start(c.app, c.t)).json(); // started on the point-to-point link
    expect((await c.bookings.get(bookingId))!.total).toBe(c.pointTotal);
    await switchLink(c, 'chauffeur'); // the agent switches the link; the customer pays the first booking anyway
    await settle(c, bookingId, c.pointTotal);
    const body = await (await view(c.app, c.t)).json();
    expect(body.state).toBe('paid');
    expect(body.paid.amountUsd).toBe(usd(c.pointTotal));
    expect(body.paid.title).not.toMatch(/across Sri Lanka/);
    // the same screen with a plain point-to-point quote, for comparison
    const plain = await bothQuote({ link: false });
    const pb = await (await start(plain.app, plain.t)).json();
    await settle(plain, pb.bookingId, plain.pointTotal);
    expect(body.paid.title).toBe((await (await view(plain.app, plain.t)).json()).paid.title);
  });

  it('a CHAUFFEUR booking paid after the link was switched back to point-to-point is still chauffeur (balance intact)', async () => {
    const c = await bothQuote();
    const { bookingId } = await (await startPaying(c.app, c.t, 'deposit')).json();
    await switchLink(c, 'point');
    const dep = depositFor('chauffeur', c.altTotal);
    await settle(c, bookingId, dep, 'deposit');
    const bal = await (await view(c.app, c.t)).json();
    expect(bal.state).toBe('balance');
    expect(bal.balance.copy.product).toBe('chauffeur');
    expect(bal.balance.totalUsd).toBe(usd(c.altTotal));
    expect(bal.balance.balanceCents).toBe(c.altTotal - dep);
    expect((await payBalance(c.app, c.t)).status).toBe(200);
    await settle(c, bookingId, c.altTotal - dep, 'balance');
    const paid = await (await view(c.app, c.t)).json();
    expect(paid.state).toBe('paid');
    expect(paid.paid.title).toBe(bal.balance.copy.title);
    expect(paid.paid.amountUsd).toBe(usd(c.altTotal));
  });

  // A paid customer is never a dead end: whatever happens to the selection afterwards, the balance
  // screen and the balance payment stay reachable.
  it('a deposit payer whose selection later stops validating still sees the balance and can pay it', async () => {
    const c = await bothQuote();
    const { bookingId } = await (await startPaying(c.app, c.t, 'deposit')).json();
    await settle(c, bookingId, depositFor('chauffeur', c.altTotal), 'deposit');
    await c.quotes.patch(c.q.id, { soldCents: 999 }); // no projection validates any more
    const bal = await (await view(c.app, c.t)).json();
    expect(bal.state).toBe('balance');
    expect(bal.balance.copy.product).toBe('chauffeur'); // the booking itself is chauffeur and the alt is still there
    expect(bal.balance.totalUsd).toBe(usd(c.altTotal));
    expect((await payBalance(c.app, c.t)).status).toBe(200);
  });

  it('a paid customer with no valid projection at all gets the paid screen (primary copy), not unavailable', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const app = createApp({ quotes, bookings, payments });
    const q = await readyQuote(quotes); // a plain private quote: no alt anywhere
    const t0 = signQuotePayToken(q.id, q.revision, SECRET);
    const { bookingId } = await (await start(app, t0)).json();
    await quotes.patch(q.id, { payLinkSelection: { service: 'chauffeur' }, soldCents: 30000, payLinkSeq: 1 }); // dangling
    const booking = (await bookings.get(bookingId))!;
    const p = await payments.create({ bookingId, provider: 'payhere', orderId: booking.reference, amount: 21900, currency: 'USD', idempotencyKey: 'k' });
    await payments.markSucceeded(p.id);
    await bookings.setStatus(bookingId, 'paid');
    const body = await (await view(app, t0)).json();
    expect(body.state).toBe('paid');
    expect(body.paid.amountUsd).toBe('$219.00');
  });

  // Strict: only { service: 'chauffeur' } is a service selection. Anything else that is not a leg
  // selection fails closed instead of being sold as something.
  // The keepsake's figure is the booking's own total; the quote's current figures can have moved
  // (re-saved, re-priced) since the booking was made. With no succeeded payment row (a quote marked
  // booked onto an existing booking) the fallback must still be the booking, never the quote.
  it('the paid keepsake shows the BOOKING total when there is no payment row, not the quote\'s', async () => {
    const c = await bothQuote({ link: false });
    const total = 23100; // neither the point-to-point nor the frozen chauffeur total
    expect([c.pointTotal, c.altTotal]).not.toContain(total); // guard
    const booking = await c.bookings.create({
      mode: 'trip', total, amountDueNow: total, currency: 'USD',
      input: {
        stops: ['Colombo', 'Kandy', 'Ella'], nights: [1, 1, 0], dates: [futureIsoDate(30), futureIsoDate(32)], pax: 2,
        vehicleType: 'car', serviceType: 'chauffeur', days: 3, driverNights: 2,
        customer: { firstName: 'Nimal', lastName: 'Perera', email: 'nimal@x.com', whatsapp: '+94770001111', country: 'LK' },
      },
    });
    await c.quotes.patch(c.q.id, { convertedBookingId: booking.id, status: 'won' });
    const body = await (await view(c.app, c.t)).json();
    expect(body.state).toBe('paid');
    expect(body.paid.amountUsd).toBe('$231.00');
  });

  it('a stored { service: "private" } is not sold as chauffeur — the link is unavailable', async () => {
    const c = await bothQuote({ link: false });
    await c.quotes.patch(c.q.id, { payLinkSelection: { service: 'private' } as never, soldCents: c.altTotal, payLinkSeq: 1 });
    const t = signQuotePayToken(c.q.id, c.q.revision, SECRET, 1);
    expect(await (await view(c.app, t)).json()).toEqual({ state: 'unavailable' });
    expect((await start(c.app, t)).status).toBe(409);
    expect(await c.bookings.list()).toHaveLength(0);
  });

  it('a double tap on a chauffeur link resumes the SAME booking', async () => {
    const { app, t, bookings } = await bothQuote();
    const first = await start(app, t);
    const second = await start(app, t);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await second.json()).bookingId).toBe((await first.json()).bookingId);
    expect(await bookings.list()).toHaveLength(1);
  });

  it('a cancelled chauffeur booking is replaced by ONE fresh chauffeur booking at the alt total', async () => {
    const { app, t, bookings, altTotal } = await bothQuote();
    const { bookingId } = await (await start(app, t)).json();
    await bookings.setStatus(bookingId, 'cancelled');
    const again = await start(app, t);
    expect(again.status).toBe(201);
    const fresh = (await bookings.get((await again.json()).bookingId))!;
    expect(fresh.id).not.toBe(bookingId);
    expect(fresh.total).toBe(altTotal);
    expect((fresh as { input: { serviceType: string } }).input.serviceType).toBe('chauffeur');
    const third = await start(app, t); // …and a further tap resumes that replacement
    expect((await third.json()).bookingId).toBe(fresh.id);
  });

  it('a chauffeur link under $150 offers no deposit and refuses one that is asked for', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ quotes, bookings });
    const q = await readyQuote(quotes); // private row…
    // …replaced by a both-quote carrying a cheap (but well-formed) frozen chauffeur alternative.
    const engine = { product: 'chauffeur', vehicle: 'car', pax: 2, bags: 1, firstDate: '2026-09-01', lastDate: '2026-09-02',
      travelDays: [{ date: '2026-09-01', from: 'CMB', to: 'Galle', distanceKm: 120 }] };
    const alt = { product: 'chauffeur', engine, result: { product: 'chauffeur', currency: 'USD', lineItems: [], subtotalCents: 14000, totalCents: 14000, depositCents: 4200, amountDueNowCents: 4200, rateCardVersion: 'v1', warnings: [] } };
    const cheap = await quotes.save({
      channel: 'ops', product: 'private', vehicle: 'car', customerName: 'Nimal Perera', customerContact: '+94 77 000 1111',
      totalCents: 21900, currency: 'USD', rateCardVersion: 'v1', requestedService: 'both',
      request: (await quotes.get(q.id))!.request, result: { totalCents: 21900, lineItems: [], alt },
    });
    for (const st of ['pending_review', 'ready', 'sent'] as const) await quotes.patch(cheap.id, { status: st });
    await quotes.patch(cheap.id, { payLinkSelection: { service: 'chauffeur' }, soldCents: 14000, payLinkSeq: 1 });
    const t = signQuotePayToken(cheap.id, cheap.revision, SECRET, 1);
    const body = await (await view(app, t)).json();
    expect(body.state).toBe('payable');
    expect(body.copy.product).toBe('chauffeur');
    expect(body.totals.cents).toBe(14000);
    expect(body).not.toHaveProperty('deposit');
    const res = await startPaying(app, t, 'deposit');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('deposit_ineligible');
    expect(await bookings.list()).toHaveLength(0);
  });

  it('a "both" quote with NO service selection is untouched: point-to-point copy and total, no deposit', async () => {
    const { app, t, pointTotal } = await bothQuote({ link: false });
    const body = await (await view(app, t)).json();
    expect(body.state).toBe('payable');
    expect(body.copy.product).not.toBe('chauffeur');
    expect(body.totals.cents).toBe(pointTotal);
    expect(body).not.toHaveProperty('deposit');
  });
});
