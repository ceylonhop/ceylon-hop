import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

const valid = {
  from: 'Colombo Airport',
  to: 'Ella',
  vehicleType: 'car',
  adults: 2,
  children: 0,
  bags: 2,
  customer: { name: 'Maya', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

async function book(app: ReturnType<typeof createApp>) {
  const res = await app.request('/bookings/single', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(valid),
  });
  return res.json();
}

describe('POST /bookings/:id/checkout', () => {
  it('returns checkout params matching the booking and moves it to payment_pending', async () => {
    const app = createApp();
    const b = await book(app);
    const res = await app.request(`/bookings/${b.id}/checkout`, { method: 'POST' });
    expect(res.status).toBe(200);
    const params = await res.json();
    expect(params.amount).toBe(b.total);
    expect(params.orderId).toBe(b.reference);
    const after = await (await app.request(`/bookings/${b.id}`)).json();
    expect(after.status).toBe('payment_pending');
  });

  it('404 for an unknown booking', async () => {
    const app = createApp();
    const res = await app.request('/bookings/nope/checkout', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
