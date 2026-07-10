import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { isoToday } from '../domain/dateRules';

// Dates safely in the future (past-date rejection floors bookings at today, Asia/Colombo).
const SOON = isoToday('Asia/Colombo', new Date(Date.now() + 30 * 86_400_000));
const SOON2 = isoToday('Asia/Colombo', new Date(Date.now() + 32 * 86_400_000));

const valid = {
  from: 'Colombo Airport',
  to: 'Ella',
  vehicleType: 'car',
  adults: 2,
  children: 0,
  bags: 2,
  customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
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
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ bookings });
    const b = await book(app);
    const res = await app.request(`/bookings/${b.id}/checkout`, { method: 'POST' });
    expect(res.status).toBe(200);
    const params = await res.json();
    expect(params.amount).toBe(b.total);
    expect(params.orderId).toBe(b.reference);
    const after = await bookings.get(b.id);
    expect(after!.status).toBe('payment_pending');
  });

  it('404 for an unknown booking', async () => {
    const app = createApp();
    const res = await app.request('/bookings/nope/checkout', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('POST /bookings/:id/checkout — due now amount', () => {
  const chauffeur = {
    stops: ['Colombo Airport (CMB)', 'Kandy', 'Ella'],
    nights: [1, 2, 0],
    dates: [SOON, SOON2],
    pax: 2,
    vehicleType: 'car',
    serviceType: 'chauffeur',
    customer: valid.customer,
  };

  it('charges the full amount for a chauffeur trip', async () => {
    const app = createApp();
    const b = await (
      await app.request('/bookings/trip', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chauffeur),
      })
    ).json();
    expect(b.total).toBe(19370); // engine: 3×2700 + round(322×35)
    const res = await app.request(`/bookings/${b.id}/checkout`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).amount).toBe(19370);
  });

  it('falls back to the full total for legacy rows without amountDueNow', async () => {
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ bookings });
    const b = await book(app);
    // simulate a pre-GL-3 row: amount_due_now is null in the DB
    (await bookings.get(b.id))!.amountDueNow = null;
    const res = await app.request(`/bookings/${b.id}/checkout`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).amount).toBe(b.total);
  });
});
