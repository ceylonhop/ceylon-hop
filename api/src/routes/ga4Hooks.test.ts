import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakePaymentAdapter } from '../adapters/payments';
import { FakeGa4Adapter } from '../adapters/ga4';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryGa4EventLogRepo, InMemoryGaIdentityRepo } from '../db/ga4Repo';
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
