import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakePaymentAdapter } from '../adapters/payments';
import { FakeEmailAdapter } from '../adapters/email';

const valid = {
  stops: ['Colombo Airport', 'Sigiriya', 'Ella'],
  nights: [1, 2, 0],
  dates: ['2026-07-20', '2026-07-22'],
  pax: 2,
  vehicleType: 'van',
  serviceType: 'private',
  customer: { name: 'Maya', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

async function postTrip(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/bookings/trip', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /bookings/trip', () => {
  it('creates a trip draft (201) priced by quoteTrip', async () => {
    const app = createApp();
    const res = await postTrip(app, valid);
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.mode).toBe('trip');
    expect(b.status).toBe('draft');
    expect(b.total).toBe(12000); // 2 legs × (5000 + 1000 van)
    expect(b.input.stops).toHaveLength(3);
  });

  it('rejects an invalid trip (400)', async () => {
    const app = createApp();
    const res = await postTrip(app, { ...valid, stops: ['only one'] });
    expect(res.status).toBe(400);
  });

  it('flows through checkout → webhook → paid → email', async () => {
    const adapter = new FakePaymentAdapter();
    const email = new FakeEmailAdapter();
    const app = createApp({ adapter, email });

    const b = await (await postTrip(app, valid)).json();
    await app.request(`/bookings/${b.id}/checkout`, { method: 'POST' });
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    const wh = await app.request('/webhooks/payments', { method: 'POST', body });
    expect(wh.status).toBe(200);

    const paid = await (await app.request(`/bookings/${b.id}`)).json();
    expect(paid.status).toBe('paid');
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].html).toContain('Sigiriya'); // trip route line
  });
});
