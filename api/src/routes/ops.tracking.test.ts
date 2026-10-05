import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import { InMemoryCustomerCommunicationRepo } from '../db/customerCommunicationRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { issueSessionCookie } from '../lib/opsMiddleware';

const auth = {
  opsUsers: 'f@x.com:founder,fin@x.com:finance,o@x.com:ops',
  googleClientId: 'cid', opsSessionSecret: 'sek',
};
const customer = {
  firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com',
  whatsapp: '+34600000000', country: 'Spain',
};
const draft: NewBooking = {
  mode: 'single',
  input: {
    from: 'Colombo', to: 'Kandy', vehicleType: 'car', adults: 1, children: 0, bags: 1,
    date: '2030-01-15', time: '09:00', customer,
  },
  total: 10000, amountDueNow: 10000, currency: 'USD',
};

async function cookie(email: string): Promise<string> {
  const app = new Hono();
  app.get('/', (c) => { issueSessionCookie(c, email, 'sek', Date.now()); return c.text('ok'); });
  return (await app.request('/')).headers.get('set-cookie')!.split(';')[0]!;
}

function setup() {
  const bookings = new InMemoryBookingRepo({ transitionTrackingEnabled: true });
  const communications = new InMemoryCustomerCommunicationRepo();
  const app = createApp({
    bookings,
    payments: new InMemoryPaymentRepo(),
    rideOps: new InMemoryRideOpsRepo(),
    customerCommunications: communications,
    communicationTrackingEnabled: true,
    auth,
  });
  return { app, bookings, communications };
}

describe('GET /admin/ops/bookings/:id/tracking', () => {
  it('requires booking-read access and remains read-only', async () => {
    const s = setup();
    const booking = await s.bookings.create(draft);
    expect((await s.app.request(`/admin/ops/bookings/${booking.id}/tracking`)).status).toBe(401);
    expect((await s.app.request(`/admin/ops/bookings/${booking.id}/tracking`, {
      headers: { cookie: await cookie('o@x.com') },
    })).status).toBe(200);
    expect((await s.app.request(`/admin/ops/bookings/${booking.id}/tracking`, {
      method: 'POST', headers: { cookie: await cookie('o@x.com') },
    })).status).toBe(404);
  });

  it('returns a deterministic page and an opaque cursor', async () => {
    const s = setup();
    const booking = await s.bookings.create(draft);
    await s.bookings.setStatus(booking.id, 'payment_pending', undefined, {
      source: 'website', actorType: 'customer', requestId: '11111111-1111-4111-8111-111111111111',
    });
    const communication = await s.communications.plan({
      bookingId: booking.id, kind: 'confirmation', channel: 'email',
      templateKey: 'booking-confirmation', templateVersion: '1', recipient: customer.email,
      source: 'payment_webhook', actorType: 'provider', actorId: null, requestId: null, runId: null,
      trackingKey: `${booking.id}:confirmation`, payloadSha256: 'a'.repeat(64),
    });
    await s.communications.recordEvent({
      communicationId: communication.id, eventType: 'planned', providerEventId: null,
      providerMessageId: null, reasonCode: null, detailJson: null, occurredAt: new Date(),
    });
    const first = await s.app.request(`/admin/ops/bookings/${booking.id}/tracking?limit=1`, {
      headers: { cookie: await cookie('f@x.com') },
    });
    expect(first.status).toBe(200);
    const page = await first.json();
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(page)).not.toContain(customer.email);
    const second = await s.app.request(
      `/admin/ops/bookings/${booking.id}/tracking?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
      { headers: { cookie: await cookie('f@x.com') } },
    );
    expect(second.status).toBe(200);
    expect((await second.json()).items).toHaveLength(1);
  });

  it('404s an unknown booking and validates the page size', async () => {
    const s = setup();
    const headers = { cookie: await cookie('f@x.com') };
    expect((await s.app.request('/admin/ops/bookings/00000000-0000-4000-8000-000000000000/tracking', { headers })).status).toBe(404);
    const booking = await s.bookings.create(draft);
    expect((await s.app.request(`/admin/ops/bookings/${booking.id}/tracking?limit=0`, { headers })).status).toBe(400);
    expect((await s.app.request(`/admin/ops/bookings/${booking.id}/tracking?limit=101`, { headers })).status).toBe(400);
    expect((await s.app.request(`/admin/ops/bookings/${booking.id}/tracking?cursor=not-a-cursor`, { headers })).status).toBe(400);
  });
});
