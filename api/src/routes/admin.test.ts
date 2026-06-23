import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { FakeEmailAdapter } from '../adapters/email';

const KEY = 'secret-key';
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

describe('GET /admin/bookings', () => {
  it('401 without a key', async () => {
    const app = createApp({ adminApiKey: KEY });
    expect((await app.request('/admin/bookings')).status).toBe(401);
  });

  it('401 with a wrong key', async () => {
    const app = createApp({ adminApiKey: KEY });
    const res = await app.request('/admin/bookings', { headers: { 'x-admin-key': 'nope' } });
    expect(res.status).toBe(401);
  });

  it('lists bookings with the key', async () => {
    const app = createApp({ adminApiKey: KEY });
    await book(app);
    const res = await app.request('/admin/bookings', { headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
  });
});

function makeApp() {
  const bookings = new InMemoryBookingRepo();
  const email = new FakeEmailAdapter();
  return { app: createApp({ adminApiKey: KEY, bookings, email }), bookings, email };
}

describe('POST /admin/bookings/:id/cancel', () => {
  it('cancels the booking, transitions it to cancelled, and emails the customer', async () => {
    const { app, bookings, email } = makeApp();
    const b = await book(app);
    const res = await app.request(`/admin/bookings/${b.id}/cancel`, { method: 'POST', headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('cancelled');
    expect((await bookings.get(b.id))!.status).toBe('cancelled');
    const sent = email.sent.filter((m) => /cancel/i.test(m.subject));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('maya@example.com');
  });

  it('401 without the admin key', async () => {
    const { app } = makeApp();
    const b = await book(app);
    expect((await app.request(`/admin/bookings/${b.id}/cancel`, { method: 'POST' })).status).toBe(401);
  });

  it('404 for an unknown booking', async () => {
    const { app } = makeApp();
    const res = await app.request('/admin/bookings/no-such/cancel', { method: 'POST', headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(404);
  });

  it('409 when the booking cannot be cancelled (already cancelled)', async () => {
    const { app, bookings } = makeApp();
    const b = await book(app);
    await bookings.setStatus(b.id, 'cancelled');
    const res = await app.request(`/admin/bookings/${b.id}/cancel`, { method: 'POST', headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(409);
  });
});

describe('POST /admin/jobs/notifications', () => {
  it('runs the scheduler and returns counts, sending a reminder for a booking due tomorrow', async () => {
    const { app, bookings, email } = makeApp();
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const b = await bookings.create({
      mode: 'single',
      input: { ...valid, vehicleType: 'car' as const, date: tomorrow, time: '09:00' },
      total: 5000,
      currency: 'USD',
    });
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    const res = await app.request('/admin/jobs/notifications', { method: 'POST', headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(200);
    expect((await res.json()).reminders).toBe(1);
    expect(email.sent.some((m) => /coming up/i.test(m.subject))).toBe(true);
  });

  it('401 without the admin key', async () => {
    const { app } = makeApp();
    expect((await app.request('/admin/jobs/notifications', { method: 'POST' })).status).toBe(401);
  });
});

describe('POST /admin/bookings/:id/refund', () => {
  it('refunds a paid booking, transitions it to refunded, and emails the customer', async () => {
    const { app, bookings, email } = makeApp();
    const b = await book(app);
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    const res = await app.request(`/admin/bookings/${b.id}/refund`, { method: 'POST', headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('refunded');
    expect((await bookings.get(b.id))!.status).toBe('refunded');
    expect(email.sent.filter((m) => /refund/i.test(m.subject))).toHaveLength(1);
  });

  it('409 when the booking cannot be refunded (still a draft)', async () => {
    const { app } = makeApp();
    const b = await book(app);
    const res = await app.request(`/admin/bookings/${b.id}/refund`, { method: 'POST', headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(409);
  });
});
