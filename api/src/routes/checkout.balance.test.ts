import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryPromoCodeRepo } from '../db/promoCodeRepo';
import { signCheckoutToken, verifyPayReturnToken } from '../lib/bookingToken';
import { FakePaymentAdapter, type PaymentAdapter, type CreateCheckoutArgs } from '../adapters/payments';

// The balance of a deposit booking, paid on the same pay link (spec 2026-10-07 §5.3, rev. 2026-10-08).
// A second ordinary checkout: REF-B / checkout:<id>:balance, charging exactly what is still owed.

const SECRET = 'dev-booking-link-secret-change-me';
const TOTAL = 21900;
const DEPOSIT = 5000;
const BALANCE = TOTAL - DEPOSIT;
const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };

function spy() {
  const inner = new FakePaymentAdapter();
  const box: { seen: CreateCheckoutArgs | null } = { seen: null };
  const adapter: PaymentAdapter = {
    provider: inner.provider,
    createCheckout: (args) => { box.seen = args; return inner.createCheckout(args); },
    parseWebhook: (raw) => inner.parseWebhook(raw),
  };
  return { adapter, box };
}

async function world(opts: { status?: 'paid' | 'confirmed' | 'in_progress' | 'payment_pending' | 'cancelled'; depositSucceeded?: boolean } = {}) {
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const { adapter, box } = spy();
  const app = createApp({ bookings, payments, adapter, payBaseUrl: 'https://pay.example.com' });
  const created = await bookings.create({
    mode: 'single',
    input: { from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer },
    total: TOTAL, amountDueNow: DEPOSIT, currency: 'USD',
  });
  const dep = await payments.create({
    bookingId: created.id, provider: adapter.provider, orderId: `${created.reference}-D`, amount: DEPOSIT, currency: 'USD',
    idempotencyKey: `checkout:${created.id}:deposit`, purpose: 'deposit',
  });
  await bookings.setStatus(created.id, 'payment_pending');
  if (opts.depositSucceeded !== false) await payments.markSucceeded(dep.id);
  const status = opts.status ?? 'paid';
  if (status === 'cancelled') { await bookings.setStatus(created.id, 'paid'); await bookings.setStatus(created.id, 'cancelled'); }
  else if (status !== 'payment_pending') {
    await bookings.setStatus(created.id, 'paid');
    if (status !== 'paid') await bookings.setStatus(created.id, 'confirmed');
    if (status === 'in_progress') await bookings.setStatus(created.id, 'in_progress');
  }
  const b = { id: created.id, reference: created.reference, checkoutToken: signCheckoutToken(created.id, SECRET, Date.now()) };
  const balanceCheckout = (body: unknown = { purpose: 'balance', returnTo: 'pay-link' }) =>
    app.request(`/bookings/${b.id}/checkout`, {
      method: 'POST', headers: { authorization: `Bearer ${b.checkoutToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  return { bookings, payments, app, b, box, balanceCheckout };
}

describe('POST /bookings/:id/checkout — purpose: balance', () => {
  it('charges exactly the balance on REF-B with its own key and purpose', async () => {
    const w = await world();
    const res = await w.balanceCheckout();
    expect(res.status).toBe(200);
    const params = await res.json();
    expect(params.amount).toBe(BALANCE);
    expect(params.orderId).toBe(`${w.b.reference}-B`);
    const rows = await w.payments.findByBookingId(w.b.id);
    const bal = rows.find((p) => p.purpose === 'balance')!;
    expect(bal).toMatchObject({ amount: BALANCE, orderId: `${w.b.reference}-B`, idempotencyKey: `checkout:${w.b.id}:balance`, status: 'pending' });
    expect(rows).toHaveLength(2); // the deposit row is untouched
    // The booking is already secured: a balance attempt must not walk its status.
    expect((await w.bookings.get(w.b.id))!.status).toBe('paid');
  });

  it('twice is still one balance row (a retry reuses it)', async () => {
    const w = await world();
    await w.balanceCheckout();
    expect((await w.balanceCheckout()).status).toBe(200);
    const rows = await w.payments.findByBookingId(w.b.id);
    expect(rows.filter((p) => p.purpose === 'balance')).toHaveLength(1);
  });

  it.each(['confirmed', 'in_progress'] as const)('is open on a %s booking too', async (status) => {
    const w = await world({ status });
    expect((await w.balanceCheckout()).status).toBe(200);
  });

  it('the client cannot send an amount', async () => {
    const w = await world();
    const params = await (await w.balanceCheckout({ purpose: 'balance', returnTo: 'pay-link', amount: 100 })).json();
    expect(params.amount).toBe(BALANCE);
  });

  it('409 no_balance_due once the balance has been paid', async () => {
    const w = await world();
    await w.balanceCheckout();
    const bal = (await w.payments.findByBookingId(w.b.id)).find((p) => p.purpose === 'balance')!;
    await w.payments.markSucceeded(bal.id);
    const res = await w.balanceCheckout();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('no_balance_due');
  });

  it('409 no_balance_due while the deposit is still unpaid (payment_pending)', async () => {
    const w = await world({ status: 'payment_pending', depositSucceeded: false });
    const res = await w.balanceCheckout();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('no_balance_due');
    expect((await w.payments.findByBookingId(w.b.id)).filter((p) => p.purpose === 'balance')).toHaveLength(0);
  });

  it('409 no_balance_due on a cancelled booking', async () => {
    const w = await world({ status: 'cancelled' });
    const res = await w.balanceCheckout();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('no_balance_due');
  });

  it('409 no_balance_due on a FULL-paid booking (no deposit row)', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const app = createApp({ bookings, payments });
    const created = await bookings.create({
      mode: 'single',
      input: { from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer },
      total: TOTAL, amountDueNow: TOTAL, currency: 'USD',
    });
    const p = await payments.create({ bookingId: created.id, provider: 'fake', orderId: created.reference, amount: TOTAL, currency: 'USD', idempotencyKey: `checkout:${created.id}` });
    await bookings.setStatus(created.id, 'payment_pending');
    await payments.markSucceeded(p.id);
    await bookings.setStatus(created.id, 'paid');
    const res = await app.request(`/bookings/${created.id}/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${signCheckoutToken(created.id, SECRET, Date.now())}`, 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'balance', returnTo: 'pay-link' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('no_balance_due');
  });

  it('409 amount_mismatch when an existing balance row no longer matches what is owed', async () => {
    const w = await world();
    await w.payments.create({
      bookingId: w.b.id, provider: 'fake', orderId: `${w.b.reference}-B`, amount: 100, currency: 'USD',
      idempotencyKey: `checkout:${w.b.id}:balance`, purpose: 'balance',
    });
    const res = await w.balanceCheckout();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('amount_mismatch');
  });

  it('the pay-link return URL works for a booking whose quote is won, and names this booking', async () => {
    const w = await world();
    await w.balanceCheckout();
    expect(w.box.seen!.returnUrl).toMatch(/^https:\/\/pay\.example\.com\/pay\.html\?rt=/);
    expect(w.box.seen!.cancelUrl).toMatch(/&c=1$/);
    const rt = new URL(w.box.seen!.returnUrl!).searchParams.get('rt');
    expect(verifyPayReturnToken(rt ?? undefined, SECRET)).toBe(w.b.id);
  });

  it('a balance with no deposit-row-in-body (default lane) still behaves as before: a paid booking is not chargeable', async () => {
    const w = await world();
    const res = await w.app.request(`/bookings/${w.b.id}/checkout`, {
      method: 'POST', headers: { authorization: `Bearer ${w.b.checkoutToken}` },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('not_chargeable');
  });

  it('does not re-hold a promo code (it was honoured at the deposit)', async () => {
    const promoCodes = new InMemoryPromoCodeRepo();
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const start = new Date(Math.floor(Date.now() / 1000) * 1000);
    const clock = { now: start };
    const now = start;
    const app = createApp({ bookings, payments, promoCodes, promoCodesEnabled: true, promoNow: () => clock.now });
    const code = await promoCodes.create({
      code: 'SAVE10', method: 'percentage', value: 1000, startsAt: null,
      expiresAt: new Date(now.getTime() + 3_600_000), maxUses: 5, createdBy: 'f@x.com',
    }, now);
    const created = await bookings.create(
      {
        mode: 'single',
        input: { from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer },
        total: TOTAL, amountDueNow: DEPOSIT, currency: 'USD',
      },
      { promo: { code, now } },
    );
    expect(created.promoCodeId).toBe(code.id);
    const dep = await payments.create({ bookingId: created.id, provider: 'fake', orderId: `${created.reference}-D`, amount: DEPOSIT, currency: 'USD', idempotencyKey: `checkout:${created.id}:deposit`, purpose: 'deposit' });
    await bookings.setStatus(created.id, 'payment_pending');
    await payments.markSucceeded(dep.id);
    await bookings.setStatus(created.id, 'paid');
    // Days later the 2h hold has lapsed AND the code has expired. A re-hold would refuse
    // (promo_code_expired); the balance must not care.
    clock.now = new Date(now.getTime() + 3 * 3_600_000);
    const res = await app.request(`/bookings/${created.id}/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${signCheckoutToken(created.id, SECRET, Date.now())}`, 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'balance', returnTo: 'pay-link' }),
    });
    expect(res.status).toBe(200);
  });
});
