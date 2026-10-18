import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryRefundRepo } from '../db/refundRepo';
import { issueSessionCookie } from '../lib/opsMiddleware';

const auth = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };

async function hdr() {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, 'f@x.com', 'sek', Date.now()); return ctx.text('ok'); });
  return { cookie: (await c.request('/')).headers.get('set-cookie')!.split(';')[0] };
}

describe('ops list — refund waiting for approval (spec 2026-10-17 §4)', () => {
  it('carries the sum of pending requests, and 0 when there are none', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const refunds = new InMemoryRefundRepo(bookings, payments);
    const app = createApp({ bookings, payments, refunds, rideOps: new InMemoryRideOpsRepo(), auth, adminApiKey: 'k' });
    const make = async () => {
      const b = await bookings.create({
        mode: 'single', total: 10000, amountDueNow: 10000, currency: 'USD',
        input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1, date: '2030-06-22', time: '09:00',
          customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' } },
      });
      await bookings.setStatus(b.id, 'payment_pending');
      const p = await payments.create({ bookingId: b.id, provider: 'payhere', orderId: b.reference, amount: 10000, currency: 'USD', idempotencyKey: `checkout:${b.id}` });
      await payments.markSucceeded(p.id);
      await bookings.setStatus(b.id, 'paid');
      return b;
    };
    const waiting = await make();
    const quiet = await make();
    await refunds.request({ bookingId: waiting.id, amountCents: 2550, currency: 'USD', reason: 'Dropped a leg', requestedBy: 'ops@test' });

    const rows = await (await app.request('/admin/ops/bookings', { headers: await hdr() })).json();
    const byId = new Map(rows.map((r: { id: string }) => [r.id, r]));
    expect(byId.get(waiting.id)).toMatchObject({ refundWaitingCents: 2550 });
    expect(byId.get(quiet.id)).toMatchObject({ refundWaitingCents: 0 });
  });
});
