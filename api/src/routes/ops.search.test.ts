import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryCoordinatorRepo } from '../db/coordinatorRepo';

const auth = { opsSupportKey: 'sup', opsFounderKey: 'fou', opsSessionSecret: 'sek' };
const hdr = { 'x-admin-key': 'adminkey', 'content-type': 'application/json' };

describe('ops bookings search / filter / detail', () => {
  let app: ReturnType<typeof createApp>;
  let bookings: InMemoryBookingRepo;
  let payments: InMemoryPaymentRepo;
  let single: string;

  beforeEach(async () => {
    bookings = new InMemoryBookingRepo();
    payments = new InMemoryPaymentRepo();
    app = createApp({ bookings, payments, rideOps: new InMemoryRideOpsRepo(), coordinators: new InMemoryCoordinatorRepo(), auth, adminApiKey: 'adminkey' });

    single = (await bookings.create({
      mode: 'single', total: 12100, amountDueNow: 12100, currency: 'USD',
      input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1, date: '2026-06-22', time: '09:00',
        customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34', country: 'ES' } },
    })).id;
    await bookings.create({
      mode: 'shared', total: 4000, amountDueNow: 4000, currency: 'USD',
      input: { corridorId: 'cmb-galle', date: '2026-06-25', time: '08:00', seats: 2,
        customer: { firstName: 'Ana', lastName: 'Rocha', email: 'ana@example.com', whatsapp: '+1', country: 'PT' } },
    });

    // mark the single transfer paid
    const pay = await payments.create({ bookingId: single, provider: 'fake', orderId: 'O1', amount: 12100, currency: 'USD', idempotencyKey: 'k1' });
    await payments.markSucceeded(pay.id);
  });

  it('lists all bookings across modes', async () => {
    const rows = await (await app.request('/admin/ops/bookings', { headers: hdr })).json();
    expect(rows).toHaveLength(2);
    expect(rows.map((r: { mode: string }) => r.mode).sort()).toEqual(['shared', 'single']);
  });

  it('reflects payment status (paid vs unpaid)', async () => {
    const rows = await (await app.request('/admin/ops/bookings', { headers: hdr })).json();
    const byRef = Object.fromEntries(rows.map((r: { id: string; paymentStatus: string }) => [r.id, r.paymentStatus]));
    expect(byRef[single]).toBe('paid');
  });

  it('filters by mode', async () => {
    const rows = await (await app.request('/admin/ops/bookings?mode=shared', { headers: hdr })).json();
    expect(rows).toHaveLength(1);
    expect(rows[0].mode).toBe('shared');
  });

  it('searches by customer name and email', async () => {
    expect(await (await app.request('/admin/ops/bookings?q=rocha', { headers: hdr })).json()).toHaveLength(1);
    expect(await (await app.request('/admin/ops/bookings?q=maya@example', { headers: hdr })).json()).toHaveLength(1);
    expect(await (await app.request('/admin/ops/bookings?q=zzz', { headers: hdr })).json()).toHaveLength(0);
  });

  it('filters by travel date', async () => {
    const rows = await (await app.request('/admin/ops/bookings?date=2026-06-25', { headers: hdr })).json();
    expect(rows).toHaveLength(1);
    expect(rows[0].travelDate).toBe('2026-06-25');
  });

  it('returns booking detail with ops + payments', async () => {
    const res = await app.request(`/admin/ops/bookings/${single}`, { headers: hdr });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.booking.id).toBe(single);
    expect(body.ops.fulfilmentStatus).toBe('unassigned');
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0].status).toBe('succeeded');
  });

  it('404s for an unknown booking', async () => {
    const res = await app.request('/admin/ops/bookings/no-such-id', { headers: hdr });
    expect(res.status).toBe(404);
  });

  it('logout clears the session', async () => {
    const login = await app.request('/admin/ops/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'sup' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    expect((await app.request('/admin/ops/whoami', { headers: { cookie } })).status).toBe(200);
    const out = await app.request('/admin/ops/logout', { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(200);
  });
});
