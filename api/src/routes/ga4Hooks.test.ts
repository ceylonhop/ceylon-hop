import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakePaymentAdapter } from '../adapters/payments';
import { FakeGa4Adapter } from '../adapters/ga4';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryGa4EventLogRepo, InMemoryGaIdentityRepo } from '../db/ga4Repo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { FakeEmailAdapter } from '../adapters/email';
import { issueSessionCookie } from '../lib/opsMiddleware';
import { Hono } from 'hono';
import { futureIsoDate } from '../testSupport/dates';

// Verbatim from webhooks.test.ts:19-29 (origin/main @ b43cd9ae) — a bookable single transfer.
const valid = {
  from: 'Colombo Airport (CMB)',
  to: 'Ella',
  date: futureIsoDate(30), // anchored to "now" so the past-date rule never expires it
  time: '09:00',
  vehicleType: 'car',
  adults: 2,
  children: 0,
  bags: 2,
  customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

function ga4App() {
  const adapter = new FakePaymentAdapter();
  const ga4Adapter = new FakeGa4Adapter();
  const gaIdentities = new InMemoryGaIdentityRepo();
  const bookings = new InMemoryBookingRepo();
  const app = createApp({ adapter, bookings, ga4Adapter, ga4Log: new InMemoryGa4EventLogRepo(), gaIdentities, ga4EventName: 'purchase_server' });
  return { app, adapter, ga4Adapter, gaIdentities, bookings };
}

async function bookAndCheckout(app: ReturnType<typeof createApp>, ga?: unknown) {
  const b = await (await app.request('/bookings/single', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid),
  })).json();
  await app.request(`/bookings/${b.id}/checkout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${b.checkoutToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(ga === undefined ? { returnTo: 'manage' } : { returnTo: 'manage', ga }),
  });
  return b;
}
const flush = () => new Promise((r) => setTimeout(r, 20)); // hooks are fire-and-forget

describe('server-side GA4 hooks', () => {
  it('checkout remembers the GA visitor; malformed ids are ignored and never fail the checkout', async () => {
    const { app, gaIdentities } = ga4App();
    const b = await bookAndCheckout(app, { clientId: '123.456', sessionId: '1761724800', adConsent: 'granted' });
    await flush();
    expect(await gaIdentities.get(b.id)).toEqual({ clientId: '123.456', sessionId: '1761724800', adConsent: 'granted' });
    const bad = await bookAndCheckout(app, { clientId: '<script>', sessionId: 'x' });
    await flush();
    expect(await gaIdentities.get(bad.id)).toBeNull();
  });

  it('a settled PayHere webhook reports exactly one purchase_server, joined to the visit', async () => {
    const { app, adapter, ga4Adapter } = ga4App();
    const b = await bookAndCheckout(app, { clientId: '123.456', sessionId: '1761724800' });
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    expect((await app.request('/webhooks/payments', { method: 'POST', body })).status).toBe(200);
    expect((await app.request('/webhooks/payments', { method: 'POST', body })).status).toBe(200); // PayHere retry
    await flush();
    expect(ga4Adapter.sent).toHaveLength(1);
    expect(ga4Adapter.sent[0]).toMatchObject({ client_id: '123.456', events: [{ name: 'purchase_server', params: { transaction_id: b.reference, value: b.total / 100 } }] });
  });

  it('a failed GA4 send never changes the webhook answer or the booking', async () => {
    const { app, adapter, ga4Adapter, bookings } = ga4App();
    ga4Adapter.failNext = 1;
    const b = await bookAndCheckout(app);
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    expect((await app.request('/webhooks/payments', { method: 'POST', body })).status).toBe(200);
    await flush();
    expect((await bookings.get(b.id))!.status).toBe('paid');
  });
});

// ---- Admin money paths: mark-paid (cash/bank), refunds, and the cron sweep ----
const KEY = 'secret-key';
const auth = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };

async function founderCookie() {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, 'f@x.com', 'sek', Date.now()); return ctx.text('ok'); });
  return (await c.request('/')).headers.get('set-cookie')!.split(';')[0];
}

function adminGa4App() {
  const ga4Adapter = new FakeGa4Adapter();
  const gaIdentities = new InMemoryGaIdentityRepo();
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const app = createApp({
    adminApiKey: KEY, auth, bookings, payments, rideOps: new InMemoryRideOpsRepo(), email: new FakeEmailAdapter(),
    ga4Adapter, ga4Log: new InMemoryGa4EventLogRepo(), gaIdentities, ga4EventName: 'purchase_server',
  });
  return { app, ga4Adapter, gaIdentities, bookings, payments };
}

/** An out-of-band booking awaiting cash/bank payment, with a remembered GA visitor. */
async function awaitingPayment(h: ReturnType<typeof adminGa4App>) {
  const b = await (await h.app.request('/bookings/single', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid),
  })).json();
  await h.bookings.setStatus(b.id, 'payment_pending');
  await h.gaIdentities.set(b.id, { clientId: '123.456', sessionId: '1761724800', adConsent: 'granted' });
  return b as { id: string; reference: string; total: number; amountDueNow?: number | null; currency: string };
}

const markPaid = async (h: ReturnType<typeof adminGa4App>, id: string) =>
  h.app.request(`/admin/bookings/${id}/mark-paid`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: await founderCookie() },
    body: JSON.stringify({ method: 'cash' }),
  });

describe('server-side GA4 hooks — admin money paths', () => {
  it('mark-paid sends exactly one purchase for the recorded amount; a repeat sends nothing more', async () => {
    const h = adminGa4App();
    const b = await awaitingPayment(h);
    expect((await markPaid(h, b.id)).status).toBe(200);
    await flush();
    expect(h.ga4Adapter.sent).toHaveLength(1);
    expect(h.ga4Adapter.sent[0]).toMatchObject({
      client_id: '123.456',
      events: [{ name: 'purchase_server', params: { transaction_id: b.reference, value: (b.amountDueNow ?? b.total) / 100 } }],
    });
    // The repair path (already recorded and paid) returns early and records nothing new.
    expect((await markPaid(h, b.id)).status).toBe(200);
    await flush();
    expect(h.ga4Adapter.sent).toHaveLength(1);
  });

  it('a confirmed refund sends one refund_server event (shadow mode) carrying the booking reference', async () => {
    const h = adminGa4App();
    const b = await awaitingPayment(h);
    await markPaid(h, b.id);
    const cookie = await founderCookie();
    const requested = await h.app.request(`/admin/bookings/${b.id}/refunds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ amountCents: b.total, currency: b.currency, reason: 'Customer cancelled' }),
    });
    expect(requested.status).toBe(201);
    const refund = await requested.json();
    await flush();
    expect(h.ga4Adapter.sent.filter((x) => x.events[0].name === 'refund_server')).toHaveLength(0); // requested, not confirmed
    const confirmed = await h.app.request(`/admin/bookings/${b.id}/refunds/${refund.id}/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ gatewayRef: 'GA4-REFUND-1' }),
    });
    expect(confirmed.status).toBe(200);
    await flush();
    const refunds = h.ga4Adapter.sent.filter((x) => x.events[0].name === 'refund_server');
    expect(refunds).toHaveLength(1);
    expect(refunds[0].events[0].params).toMatchObject({ transaction_id: b.reference, value: b.total / 100 });
  });

  it('a GA4 failure during mark-paid still answers 200 and the money is recorded', async () => {
    const h = adminGa4App();
    const b = await awaitingPayment(h);
    h.ga4Adapter.failNext = 1;
    const res = await markPaid(h, b.id);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('paid');
    await flush();
    expect((await h.bookings.get(b.id))!.status).toBe('paid');
    const rows = await h.payments.findByBookingId(b.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('succeeded');
    expect(h.ga4Adapter.sent).toHaveLength(0); // the one send failed; the sweep retries it
  });

  it('/jobs/notifications reports the GA4 sweep counts, and retries a failed send', async () => {
    const h = adminGa4App();
    const tick = async () => (await (await h.app.request('/admin/jobs/notifications', { method: 'POST', headers: { 'x-admin-key': KEY } })).json()).ga4;
    expect(await tick()).toEqual({ retried: 0, sent: 0, failed: 0 });
    const b = await awaitingPayment(h);
    h.ga4Adapter.failNext = 1;
    await markPaid(h, b.id);
    await flush();
    expect(h.ga4Adapter.sent).toHaveLength(0);
    expect(await tick()).toEqual({ retried: 1, sent: 1, failed: 0 });
    expect(h.ga4Adapter.sent).toHaveLength(1);
    expect(h.ga4Adapter.sent[0].events[0].params).toMatchObject({ transaction_id: b.reference });
  });
});
