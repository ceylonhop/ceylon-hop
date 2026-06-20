import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakePaymentAdapter } from '../adapters/payments';
import { FakeEmailAdapter } from '../adapters/email';

const valid = {
  corridorId: 'cmb-ella',
  date: '2026-07-20',
  time: '07:30',
  seats: 2,
  customer: { name: 'Maya', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

async function postShared(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/bookings/shared', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /bookings/shared', () => {
  it('books a shared seat (201) priced seats × corridor price', async () => {
    const app = createApp();
    const res = await postShared(app, valid);
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.mode).toBe('shared');
    expect(b.total).toBe(7000); // 2 seats × 3500 (cmb-ella)
  });

  it('400 for an unknown corridor', async () => {
    const res = await postShared(createApp(), { ...valid, corridorId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('resolves the corridor from from/to (what the website sends)', async () => {
    const app = createApp();
    const { corridorId: _omit, ...byRoute } = valid;
    void _omit;
    const res = await postShared(app, { ...byRoute, from: 'Colombo Airport', to: 'Ella', seats: 1 });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.mode).toBe('shared');
    expect(b.input.corridorId).toBe('cmb-ella');
  });

  it('400 when from/to has no matching corridor', async () => {
    const app = createApp();
    const { corridorId: _o, ...byRoute } = valid;
    void _o;
    const res = await postShared(app, { ...byRoute, from: 'Nowhere', to: 'Elsewhere' });
    expect(res.status).toBe(400);
  });

  it('409 when the departure is sold out', async () => {
    const res = await postShared(createApp(), { ...valid, seats: 13 }); // capacity is 12
    expect(res.status).toBe(409);
  });

  it('flows through checkout → webhook → paid', async () => {
    const adapter = new FakePaymentAdapter();
    const email = new FakeEmailAdapter();
    const app = createApp({ adapter, email });

    const b = await (await postShared(app, valid)).json();
    await app.request(`/bookings/${b.id}/checkout`, { method: 'POST' });
    await app.request('/webhooks/payments', {
      method: 'POST',
      body: adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency }),
    });
    const paid = await (await app.request(`/bookings/${b.id}`)).json();
    expect(paid.status).toBe('paid');
    expect(email.sent).toHaveLength(1);
  });
});
