import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { FakeEmailAdapter } from '../adapters/email';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { issueSessionCookie } from '../lib/opsMiddleware';

const KEY = 'refund-test-key';
const auth = {
  opsUsers: 'founder@test:founder,finance@test:finance,ops@test:ops',
  googleClientId: 'cid',
  opsSessionSecret: 'refund-session-secret',
};

async function cookie(email: string) {
  const app = new Hono();
  app.get('/', (c) => {
    issueSessionCookie(c, email, auth.opsSessionSecret, Date.now());
    return c.text('ok');
  });
  return (await app.request('/')).headers.get('set-cookie')!.split(';')[0];
}

async function fixture() {
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const email = new FakeEmailAdapter();
  const app = createApp({ bookings, payments, email, adminApiKey: KEY, auth });
  const created = await app.request('/bookings/single', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: 'Colombo Airport',
      to: 'Ella',
      vehicleType: 'car',
      adults: 2,
      children: 0,
      bags: 1,
      customer: {
        firstName: 'Maya',
        lastName: 'Silva',
        email: 'maya@example.com',
        whatsapp: '+94770000000',
        country: 'Sri Lanka',
      },
    }),
  });
  const booking = await created.json();
  const payment = await payments.create({
    bookingId: booking.id,
    provider: 'payhere',
    orderId: booking.reference,
    amount: booking.total,
    currency: booking.currency,
    idempotencyKey: `refund-payment-${booking.id}`,
  });
  await payments.markSucceeded(payment.id);
  await bookings.setStatus(booking.id, 'payment_pending');
  await bookings.setStatus(booking.id, 'paid');
  return { app, bookings, payments, email, booking, payment };
}

const requestRefund = async (
  app: ReturnType<typeof createApp>,
  bookingId: string,
  amountCents: number,
  actor = 'finance@test',
) =>
  app.request(`/admin/bookings/${bookingId}/refunds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: await cookie(actor) },
    body: JSON.stringify({ amountCents, currency: 'USD', reason: 'Customer request' }),
  });

describe('manual refund ledger API', () => {
  it('allows founder/finance and denies ops, system, and anonymous callers', async () => {
    for (const actor of ['founder@test', 'finance@test']) {
      const { app, booking } = await fixture();
      expect((await requestRefund(app, booking.id, 100, actor)).status).toBe(201);
    }
    const { app, booking } = await fixture();
    expect((await requestRefund(app, booking.id, 100, 'ops@test')).status).toBe(403);
    expect(
      (
        await app.request(`/admin/bookings/${booking.id}/refunds`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-admin-key': KEY },
          body: JSON.stringify({ amountCents: 100, currency: 'USD', reason: 'x' }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/admin/bookings/${booking.id}/refunds`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amountCents: 100, currency: 'USD', reason: 'x' }),
        })
      ).status,
    ).toBe(401);
  });

  it('validates positive amount and matching captured currency', async () => {
    const { app, booking } = await fixture();
    expect((await requestRefund(app, booking.id, 0)).status).toBe(400);
    const mismatch = await app.request(`/admin/bookings/${booking.id}/refunds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await cookie('finance@test') },
      body: JSON.stringify({ amountCents: 100, currency: 'EUR', reason: 'x' }),
    });
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json()).error).toBe('currency_mismatch');
  });

  it('keeps a request pending without changing booking state or sending email', async () => {
    const { app, bookings, email, booking } = await fixture();
    const response = await requestRefund(app, booking.id, 100);
    const refund = await response.json();
    expect(refund).toMatchObject({
      status: 'manual_pending',
      requestedBy: 'finance@test',
      amountCents: 100,
    });
    expect((await bookings.get(booking.id))?.status).toBe('paid');
    expect(email.sent).toHaveLength(0);
  });

  it('confirms a partial refund with unique gateway evidence and emails the actual amount', async () => {
    const { app, bookings, email, booking } = await fixture();
    const refund = await (await requestRefund(app, booking.id, 100)).json();
    const confirmed = await app.request(
      `/admin/bookings/${booking.id}/refunds/${refund.id}/confirm`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: await cookie('founder@test') },
        body: JSON.stringify({ gatewayRef: 'PAYHERE-R-1' }),
      },
    );
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).refund).toMatchObject({
      status: 'manual_confirmed',
      confirmedBy: 'founder@test',
      gatewayRef: 'PAYHERE-R-1',
    });
    expect((await bookings.get(booking.id))?.status).toBe('paid');
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].text).toContain('$1.00');
    expect(email.sent[0].text).not.toContain(`$${(booking.total / 100).toFixed(2)}`);
  });

  it('fully confirmed refunds transition once and duplicate confirmation sends no second email', async () => {
    const { app, bookings, email, booking } = await fixture();
    const refund = await (await requestRefund(app, booking.id, booking.total)).json();
    const url = `/admin/bookings/${booking.id}/refunds/${refund.id}/confirm`;
    const options = {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await cookie('finance@test') },
      body: JSON.stringify({ gatewayRef: 'PAYHERE-FULL-1' }),
    };
    expect((await app.request(url, options)).status).toBe(200);
    expect((await bookings.get(booking.id))?.status).toBe('refunded');
    expect((await app.request(url, options)).status).toBe(409);
    expect(email.sent).toHaveLength(1);
  });

  it('rejects excessive and concurrent reservations safely', async () => {
    const { app, booking } = await fixture();
    const [a, b] = await Promise.all([
      requestRefund(app, booking.id, booking.total),
      requestRefund(app, booking.id, booking.total),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it('revalidates captured money at confirmation and rolls back if capture disappeared', async () => {
    const { app, payments, booking, payment } = await fixture();
    const refund = await (await requestRefund(app, booking.id, 100)).json();
    await payments.markFailed(payment.id);
    const response = await app.request(
      `/admin/bookings/${booking.id}/refunds/${refund.id}/confirm`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: await cookie('finance@test') },
        body: JSON.stringify({ gatewayRef: 'NO-LONGER-CAPTURED' }),
      },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('refund_exceeds_captured');
    const history = await app.request(`/admin/bookings/${booking.id}/refunds`, {
      headers: { cookie: await cookie('finance@test') },
    });
    expect((await history.json())[0]).toMatchObject({
      status: 'manual_pending',
      gatewayRef: null,
    });
  });

  it('requires a unique gateway reference and supports pending cancellation/history', async () => {
    const { app, booking } = await fixture();
    const first = await (await requestRefund(app, booking.id, 100)).json();
    const second = await (await requestRefund(app, booking.id, 100)).json();
    const headers = {
      'content-type': 'application/json',
      cookie: await cookie('finance@test'),
    };
    expect(
      (
        await app.request(`/admin/bookings/${booking.id}/refunds/${first.id}/confirm`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ gatewayRef: 'UNIQUE-REF' }),
        })
      ).status,
    ).toBe(200);
    const conflict = await app.request(
      `/admin/bookings/${booking.id}/refunds/${second.id}/confirm`,
      { method: 'POST', headers, body: JSON.stringify({ gatewayRef: 'UNIQUE-REF' }) },
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toBe('gateway_ref_conflict');
    expect(
      (
        await app.request(`/admin/bookings/${booking.id}/refunds/${second.id}/cancel`, {
          method: 'POST',
          headers: { cookie: await cookie('founder@test') },
        })
      ).status,
    ).toBe(200);
    const history = await app.request(`/admin/bookings/${booking.id}/refunds`, {
      headers: { cookie: await cookie('finance@test') },
    });
    expect((await history.json()).map((row: { status: string }) => row.status)).toEqual([
      'manual_confirmed',
      'cancelled',
    ]);
  });
});
