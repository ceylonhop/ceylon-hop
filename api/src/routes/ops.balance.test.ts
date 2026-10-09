import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { issueSessionCookie } from '../lib/opsMiddleware';
import { signQuotePayToken, verifyQuotePayToken } from '../lib/bookingToken';

// Ops sees the open balance of a deposit booking and can copy the pay link to resend it (spec
// 2026-10-07 §5.4, rev. 2026-10-08): paid-so-far and balance on every row, and — while the balance
// is open — the converted quote's pay link, the very URL the customer already holds.

const SECRET = 'test-link-secret';
const auth = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };

async function hdr() {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, 'f@x.com', 'sek', Date.now()); return ctx.text('ok'); });
  const res = await c.request('/');
  return { cookie: res.headers.get('set-cookie')!.split(';')[0], 'content-type': 'application/json' };
}

async function world(opts: { withQuote?: boolean } = {}) {
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const quotes = new InMemoryQuoteRepo();
  const app = createApp({
    bookings, payments, quotes, rideOps: new InMemoryRideOpsRepo(), auth, adminApiKey: 'k',
    bookingLinkSecret: SECRET, payBaseUrl: 'https://pay.example',
  });
  const b = await bookings.create({
    mode: 'single', total: 21900, amountDueNow: 5000, currency: 'USD',
    input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1, date: '2026-06-22', time: '09:00',
      customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' } },
  });
  await bookings.setStatus(b.id, 'payment_pending');
  const dep = await payments.create({ bookingId: b.id, provider: 'payhere', orderId: `${b.reference}-D`, amount: 5000, currency: 'USD', idempotencyKey: `checkout:${b.id}:deposit`, purpose: 'deposit' });
  await payments.markSucceeded(dep.id);
  await bookings.setStatus(b.id, 'paid');
  let quote = null;
  if (opts.withQuote !== false) {
    quote = await quotes.save({
      channel: 'ops', product: 'private', vehicle: 'car', customerName: 'Maya', customerContact: '+34600', totalCents: 21900,
      currency: 'USD', rateCardVersion: 'v1', marginCents: 4300, request: { engine: { product: 'private' } }, result: { totalCents: 21900 },
    });
    await quotes.patch(quote.id, { convertedBookingId: b.id });
    quote = (await quotes.get(quote.id))!;
  }
  const settleBalance = async () => {
    const bal = await payments.create({ bookingId: b.id, provider: 'payhere', orderId: `${b.reference}-B`, amount: 16900, currency: 'USD', idempotencyKey: `checkout:${b.id}:balance`, purpose: 'balance' });
    await payments.markSucceeded(bal.id);
  };
  const detail = async () => (await (await app.request(`/admin/ops/bookings/${b.id}`, { headers: await hdr() })).json());
  const list = async () => (await (await app.request('/admin/ops/bookings', { headers: await hdr() })).json());
  return { b, quote, settleBalance, detail, list };
}

describe('ops list — paid so far and balance', () => {
  it('a deposit booking carries paidCents and balanceCents', async () => {
    const w = await world();
    const [row] = await w.list();
    expect(row).toMatchObject({ paymentStatus: 'paid', amount: 21900, paidCents: 5000, balanceCents: 16900 });
  });

  it('once the balance lands the row reads fully paid, balance 0', async () => {
    const w = await world();
    await w.settleBalance();
    const [row] = await w.list();
    expect(row).toMatchObject({ paidCents: 21900, balanceCents: 0 });
  });
});

describe('ops booking detail — balancePayLink', () => {
  it('is the source quote’s own pay URL while the balance is open', async () => {
    const w = await world();
    const { balancePayLink } = await w.detail();
    const expected = `https://pay.example/p?t=${signQuotePayToken(w.quote!.id, w.quote!.revision, SECRET, w.quote!.payLinkSeq)}`;
    expect(balancePayLink).toBe(expected);
    // …and it is a token the customer-facing route accepts for that very quote.
    const t = new URL(balancePayLink).searchParams.get('t');
    expect(verifyQuotePayToken(t ?? undefined, SECRET)).toMatchObject({ quoteId: w.quote!.id });
  });

  it('is null once the balance has been paid', async () => {
    const w = await world();
    await w.settleBalance();
    expect((await w.detail()).balancePayLink).toBeNull();
  });

  it('is null for a booking with no source quote', async () => {
    const w = await world({ withQuote: false });
    expect((await w.detail()).balancePayLink).toBeNull();
  });

  it('is null for a fully paid booking (no deposit row)', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const quotes = new InMemoryQuoteRepo();
    const app = createApp({ bookings, payments, quotes, rideOps: new InMemoryRideOpsRepo(), auth, adminApiKey: 'k', bookingLinkSecret: SECRET, payBaseUrl: 'https://pay.example' });
    const b = await bookings.create({
      mode: 'single', total: 21900, amountDueNow: 21900, currency: 'USD',
      input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1, date: '2026-06-22', time: '09:00',
        customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' } },
    });
    await bookings.setStatus(b.id, 'payment_pending');
    const p = await payments.create({ bookingId: b.id, provider: 'payhere', orderId: b.reference, amount: 21900, currency: 'USD', idempotencyKey: `checkout:${b.id}` });
    await payments.markSucceeded(p.id);
    await bookings.setStatus(b.id, 'paid');
    const q = await quotes.save({ channel: 'ops', product: 'private', vehicle: 'car', customerName: 'M', customerContact: 'x', totalCents: 21900, currency: 'USD', rateCardVersion: 'v1', marginCents: 1, request: {}, result: {} });
    await quotes.patch(q.id, { convertedBookingId: b.id });
    const res = await app.request(`/admin/ops/bookings/${b.id}`, { headers: await hdr() });
    expect((await res.json()).balancePayLink).toBeNull();
  });
});
