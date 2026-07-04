import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createApp } from './app';
import { FakePaymentAdapter } from './adapters/payments';
import { FakeEmailAdapter } from './adapters/email';
import { InMemoryConciergeTaskRepo } from './db/conciergeTaskRepo';
import { issueSessionCookie } from './lib/opsMiddleware';

// /admin/bookings now requires a session with bookings:read — x-admin-key resolves to
// `system`, which per the capability matrix lacks bookings:read. Mint a founder cookie
// so the ops-side smoke assertion still exercises the real admin-bookings read path.
const opsAuth = { opsUsers: 'smoke@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'smoke-sek' };
async function founderCookie() {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, 'smoke@x.com', 'smoke-sek', Date.now()); return ctx.text('ok'); });
  const res = await c.request('/');
  return res.headers.get('set-cookie')!.split(';')[0];
}

// Standing end-to-end smoke for the whole stubbed pipeline. Re-run at every milestone
// gate (npm run smoke); it grows as new booking types and the real PayHere land.
const valid = {
  from: 'Colombo Airport',
  to: 'Ella',
  vehicleType: 'van',
  adults: 3,
  children: 1,
  bags: 4,
  customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

describe('E2E smoke: book → checkout → webhook → paid → ops', () => {
  it('runs the whole stubbed pipeline', async () => {
    const adapter = new FakePaymentAdapter();
    const email = new FakeEmailAdapter();
    const conciergeTasks = new InMemoryConciergeTaskRepo();
    const adminApiKey = 'smoke-key';
    const app = createApp({ adapter, email, conciergeTasks, adminApiKey, auth: opsAuth });

    const b = await (
      await app.request('/bookings/single', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(valid),
      })
    ).json();
    expect(b.status).toBe('draft');

    const checkout = await app.request(`/bookings/${b.id}/checkout`, { method: 'POST' });
    expect(checkout.status).toBe(200);

    const wh = await app.request('/webhooks/payments', {
      method: 'POST',
      body: adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency }),
    });
    expect(wh.status).toBe(200);

    const paid = await (await app.request(`/bookings/${b.id}`)).json();
    expect(paid.status).toBe('paid');
    expect(email.sent).toHaveLength(1);
    expect((await conciergeTasks.listByBooking(b.id)).filter((t) => t.type === 'confirm_pickup')).toHaveLength(1);

    const adminList = await (
      await app.request('/admin/bookings?status=paid', { headers: { cookie: await founderCookie() } })
    ).json();
    expect(adminList.some((x: { id: string }) => x.id === b.id)).toBe(true);
  });

  it('runs the whole pipeline for a multi-stop trip', async () => {
    const adapter = new FakePaymentAdapter();
    const email = new FakeEmailAdapter();
    const conciergeTasks = new InMemoryConciergeTaskRepo();
    const adminApiKey = 'smoke-key';
    const app = createApp({ adapter, email, conciergeTasks, adminApiKey, auth: opsAuth });

    const trip = {
      stops: ['Colombo Airport', 'Sigiriya', 'Ella'],
      nights: [1, 2, 0],
      dates: ['2026-07-20', '2026-07-22'],
      pax: 2,
      vehicleType: 'van',
      serviceType: 'private',
      customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
    };
    const b = await (
      await app.request('/bookings/trip', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(trip),
      })
    ).json();
    expect(b.mode).toBe('trip');

    await app.request(`/bookings/${b.id}/checkout`, { method: 'POST' });
    await app.request('/webhooks/payments', {
      method: 'POST',
      body: adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency }),
    });

    const paid = await (await app.request(`/bookings/${b.id}`)).json();
    expect(paid.status).toBe('paid');
    expect(email.sent).toHaveLength(1);
    expect((await conciergeTasks.listByBooking(b.id)).filter((t) => t.type === 'confirm_pickup')).toHaveLength(1);

    const adminList = await (
      await app.request('/admin/bookings?status=paid', { headers: { cookie: await founderCookie() } })
    ).json();
    expect(adminList.some((x: { id: string }) => x.id === b.id)).toBe(true);
  });

  it('runs the whole pipeline for a shared seat', async () => {
    const adapter = new FakePaymentAdapter();
    const email = new FakeEmailAdapter();
    const conciergeTasks = new InMemoryConciergeTaskRepo();
    const app = createApp({ adapter, email, conciergeTasks, adminApiKey: 'smoke-key' });

    const shared = {
      corridorId: 'hill-line',
      date: '2026-07-20',
      time: '08:00',
      seats: 2,
      customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
    };
    const b = await (
      await app.request('/bookings/shared', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(shared),
      })
    ).json();
    expect(b.mode).toBe('shared');

    await app.request(`/bookings/${b.id}/checkout`, { method: 'POST' });
    await app.request('/webhooks/payments', {
      method: 'POST',
      body: adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency }),
    });

    const paid = await (await app.request(`/bookings/${b.id}`)).json();
    expect(paid.status).toBe('paid');
    expect(email.sent).toHaveLength(1);
    expect((await conciergeTasks.listByBooking(b.id)).filter((t) => t.type === 'confirm_pickup')).toHaveLength(1);
  });
});
