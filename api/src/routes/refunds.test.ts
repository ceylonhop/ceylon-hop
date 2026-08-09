import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { FakeEmailAdapter } from '../adapters/email';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { FakePaymentAdapter, type PaymentAdapter } from '../adapters/payments';
import { FakeAlertAdapter } from '../adapters/alerts';
import { futureIsoDate } from '../testSupport/dates';
import { InMemoryRefundRepo } from '../db/refundRepo';
import { InMemoryNotificationLogRepo } from '../db/notificationLogRepo';
import { runWatchdog } from '../services/watchdog';
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
  actor = 'founder@test',
) =>
  app.request(`/admin/bookings/${bookingId}/refunds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: await cookie(actor) },
    body: JSON.stringify({ amountCents, currency: 'USD', reason: 'Customer request' }),
  });

describe('manual refund ledger API', () => {
  // payments:reverse (owner, 2026-08-02): giving money back is the founder's alone. Finance
  // keeps payments:act — it still records money and reads refund history — but can no longer
  // start a refund. The finance assertion below is the one that matters: it used to be 201.
  // Owner rule 2026-08-02: ops may reverse within 24h of taking the booking (or while the trip
  // is >24h out). These fixture bookings are seconds old, so ops IS allowed — finance never is,
  // because it has no bookings:operate.
  it('allows the founder and a fresh-booking ops agent, and denies finance, system and anonymous', async () => {
    const founder = await fixture();
    expect((await requestRefund(founder.app, founder.booking.id, 100, 'founder@test')).status).toBe(201);

    const fin = await fixture();
    expect((await requestRefund(fin.app, fin.booking.id, 100, 'finance@test')).status).toBe(403);

    // …but finance can still READ the ledger, or it could not reconcile the books.
    expect(
      (
        await fin.app.request(`/admin/bookings/${fin.booking.id}/refunds`, {
          headers: { cookie: await cookie('founder@test') },
        })
      ).status,
    ).toBe(200);

    const { app, booking } = await fixture();
    expect((await requestRefund(app, booking.id, 100, 'ops@test')).status).toBe(201);
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
      headers: { 'content-type': 'application/json', cookie: await cookie('founder@test') },
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
      requestedBy: 'founder@test',
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
      headers: { 'content-type': 'application/json', cookie: await cookie('founder@test') },
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
        headers: { 'content-type': 'application/json', cookie: await cookie('founder@test') },
        body: JSON.stringify({ gatewayRef: 'NO-LONGER-CAPTURED' }),
      },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('refund_exceeds_captured');
    const history = await app.request(`/admin/bookings/${booking.id}/refunds`, {
      headers: { cookie: await cookie('founder@test') },
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
      cookie: await cookie('founder@test'),
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
      headers: { cookie: await cookie('founder@test') },
    });
    expect((await history.json()).map((row: { status: string }) => row.status)).toEqual([
      'manual_confirmed',
      'cancelled',
    ]);
  });
});

// ── API refunds (PayHere Refund API) ────────────────────────────────────────────────────────
// Every rule below is one rule wearing different clothes: PayHere's Refund API has no
// idempotency key, so any answer short of definite must leave the money spoken for and a human
// holding the problem. A bug here refunds a customer twice.
describe('refunding through the gateway API', () => {
  const GATEWAY_PAYMENT_ID = '320048263209';

  // A booking whose money actually settled through the gateway — the only kind refundable by
  // API, since a manual settlement's reference is a bank slip, not a PayHere payment id.
  async function apiFixture(refund?: PaymentAdapter['refund']) {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const email = new FakeEmailAdapter();
    const alerts = new FakeAlertAdapter();
    const adapter = new FakePaymentAdapter();
    if (refund) (adapter as PaymentAdapter).refund = refund;
    const app = createApp({ bookings, payments, email, alerts, adapter, adminApiKey: KEY, auth });
    const booking = await (
      await app.request('/bookings/single', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          from: 'Colombo Airport (CMB)', to: 'Ella',
          date: futureIsoDate(30), time: '09:00',
          vehicleType: 'car', adults: 2, children: 0, bags: 1,
          customer: {
            firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com',
            whatsapp: '+94770000000', country: 'Sri Lanka',
          },
        }),
      })
    ).json();
    await app.request(`/bookings/${booking.id}/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${booking.checkoutToken}` },
    });
    // Settle through the real webhook so gatewayPaymentId + settlementSource are written the
    // way production writes them, rather than being poked into the row.
    await app.request('/webhooks/payments', {
      method: 'POST',
      body: adapter.simulateWebhook({
        orderId: booking.reference, amount: booking.total, currency: booking.currency,
        providerTxnId: GATEWAY_PAYMENT_ID,
      }),
    });
    return { app, bookings, payments, email, alerts, booking };
  }

  const execute = async (app: ReturnType<typeof createApp>, bookingId: string, refundId: string) =>
    app.request(`/admin/bookings/${bookingId}/refunds/${refundId}/execute`, {
      method: 'POST', headers: { cookie: await cookie('founder@test') },
    });

  const pending = async (f: { app: ReturnType<typeof createApp>; booking: { id: string } }, cents = 100) =>
    (await requestRefund(f.app, f.booking.id, cents)).json();

  const ledger = async (f: { app: ReturnType<typeof createApp>; booking: { id: string } }) =>
    (await f.app.request(`/admin/bookings/${f.booking.id}/refunds`, {
      headers: { cookie: await cookie('founder@test') },
    })).json();

  it('409s when no adapter can refund, rather than pretending', async () => {
    const f = await apiFixture();
    const res = await execute(f.app, f.booking.id, (await pending(f)).id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('refund_api_unavailable');
  });

  it('records the gateway reference and flips a fully refunded booking', async () => {
    let n = 0;
    const f = await apiFixture(async () => ({ outcome: 'succeeded', gatewayRef: `5600340102${(n += 1)}` }));
    const refund = await pending(f, 100);
    const full = await pending(f, (await f.bookings.get(f.booking.id))!.total - 100);
    expect((await execute(f.app, f.booking.id, refund.id)).status).toBe(200);
    const res = await execute(f.app, f.booking.id, full.id);
    expect(res.status).toBe(200);
    const rows = await ledger(f);
    expect(rows.every((r: { status: string }) => r.status === 'api_confirmed')).toBe(true);
    expect((await f.bookings.get(f.booking.id))!.status).toBe('refunded');
  });

  // Two refunds cannot share one PayHere refund number. Worth pinning: a gateway that echoed a
  // stale reference would otherwise let one real refund be recorded against two rows.
  it('refuses to record two refunds under the same gateway reference', async () => {
    const f = await apiFixture(async () => ({ outcome: 'succeeded', gatewayRef: 'same-ref' }));
    expect((await execute(f.app, f.booking.id, (await pending(f, 100)).id)).status).toBe(200);
    const second = await execute(f.app, f.booking.id, (await pending(f, 100)).id);
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe('gateway_ref_conflict');
  });

  it('passes the amount and the ops agent’s reason through to the gateway', async () => {
    const seen: unknown[] = [];
    const f = await apiFixture(async (args) => {
      seen.push(args);
      return { outcome: 'succeeded', gatewayRef: '1' };
    });
    await execute(f.app, f.booking.id, (await pending(f, 250)).id);
    expect(seen[0]).toMatchObject({
      gatewayPaymentId: GATEWAY_PAYMENT_ID, amountCents: 250, description: 'Customer request',
      isFullRefund: false,
    });
  });

  // A decline is a DEFINITE answer that the money did not move, so it must release the reserve —
  // otherwise a failed attempt would permanently shrink what the customer can be refunded.
  it('frees the money again when the gateway declines', async () => {
    const f = await apiFixture(async () => ({ outcome: 'failed', providerMessage: 'Error processing refund' }));
    const refund = await pending(f, 100);
    const res = await execute(f.app, f.booking.id, refund.id);
    expect(res.status).toBe(409);
    expect((await ledger(f)).find((r: { id: string }) => r.id === refund.id)).toMatchObject({
      status: 'api_failed', providerMessage: 'Error processing refund',
    });
    const total = (await f.bookings.get(f.booking.id))!.total;
    expect((await requestRefund(f.app, f.booking.id, total)).status).toBe(201);
  });

  // ── the case the whole design exists for ──────────────────────────────────────────────────

  it('leaves an unknown outcome mid-flight, alerts, and refuses to say it failed', async () => {
    const f = await apiFixture(async () => ({ outcome: 'unknown', providerMessage: 'transport: aborted' }));
    const refund = await pending(f, 100);
    const res = await execute(f.app, f.booking.id, refund.id);
    expect(res.status).toBe(202);
    expect((await res.json()).error).toBe('refund_outcome_unknown');
    const row = (await ledger(f)).find((r: { id: string }) => r.id === refund.id);
    expect(row.status).toBe('api_processing');
    expect(row.apiAttemptedAt).toBeTruthy();
    const alert = f.alerts.sent.find((a) => a.kind === 'refund_api_indeterminate');
    expect(alert?.severity).toBe('critical');
    expect(alert?.body).toContain('Do NOT retry');
  });

  it('never calls the gateway twice for one refund', async () => {
    let calls = 0;
    const f = await apiFixture(async () => {
      calls += 1;
      return { outcome: 'unknown', providerMessage: 'timeout' };
    });
    const refund = await pending(f, 100);
    await execute(f.app, f.booking.id, refund.id);
    const second = await execute(f.app, f.booking.id, refund.id);
    expect(calls).toBe(1);                       // the row is already claimed
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe('refund_not_pending');
  });

  it('will not let a mid-flight refund be cancelled — the money may already be gone', async () => {
    const f = await apiFixture(async () => ({ outcome: 'unknown', providerMessage: 'timeout' }));
    const refund = await pending(f, 100);
    await execute(f.app, f.booking.id, refund.id);
    const res = await f.app.request(
      `/admin/bookings/${f.booking.id}/refunds/${refund.id}/cancel`,
      { method: 'POST', headers: { cookie: await cookie('founder@test') } },
    );
    expect(res.status).toBe(409);
    expect((await ledger(f)).find((r: { id: string }) => r.id === refund.id).status).toBe('api_processing');
  });

  // The reconcile path: a human reads PayHere's dashboard and pastes the reference in. It stays
  // api_confirmed, because that is how the money actually moved.
  it('lets a human resolve a mid-flight refund with the reference from PayHere', async () => {
    const f = await apiFixture(async () => ({ outcome: 'unknown', providerMessage: 'timeout' }));
    const refund = await pending(f, 100);
    await execute(f.app, f.booking.id, refund.id);
    const res = await f.app.request(
      `/admin/bookings/${f.booking.id}/refunds/${refund.id}/confirm`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: await cookie('founder@test') },
        body: JSON.stringify({ gatewayRef: '560034010257' }),
      },
    );
    expect(res.status).toBe(200);
    expect((await ledger(f)).find((r: { id: string }) => r.id === refund.id)).toMatchObject({
      status: 'api_confirmed', gatewayRef: '560034010257', confirmedBy: 'founder@test',
    });
  });

  it('refuses to refund cash by API — a bank slip is not a PayHere payment id', async () => {
    const f = await fixture();                    // settled via markSucceeded, not the gateway
    const app = f.app;
    const refund = await (await requestRefund(app, f.booking.id, 100)).json();
    const res = await app.request(
      `/admin/bookings/${f.booking.id}/refunds/${refund.id}/execute`,
      { method: 'POST', headers: { cookie: await cookie('founder@test') } },
    );
    expect([409]).toContain(res.status);
  });

  it('an adapter that throws is unknown, not failed', async () => {
    const f = await apiFixture(async () => {
      throw new Error('socket hang up');
    });
    const refund = await pending(f, 100);
    expect((await execute(f.app, f.booking.id, refund.id)).status).toBe(202);
    expect((await ledger(f)).find((r: { id: string }) => r.id === refund.id).status).toBe('api_processing');
  });
});

// A row left in api_processing clears only when a human resolves it, so this alert is the
// entire mechanism by which anyone finds out that money may have moved unrecorded.
describe('the watchdog sweep for refunds stuck mid-call', () => {
  it('pages on a refund that never resolved, and says not to retry', async () => {
    const f = await fixture();
    const refunds = new InMemoryRefundRepo(f.bookings, f.payments);
    const alerts = new FakeAlertAdapter();
    const refund = await refunds.request({
      bookingId: f.booking.id, amountCents: 100, currency: 'USD',
      reason: 'Customer cancelled', requestedBy: 'founder@test',
    });
    // Put it in the mid-call state the route leaves behind, and age it past the window.
    const rows = (refunds as unknown as { rows: Map<string, unknown> }).rows;
    rows.set(refund.id, {
      ...refund, status: 'api_processing', apiAttemptedAt: new Date(Date.now() - 3600_000),
    });

    const result = await runWatchdog(new Date(), {
      bookings: f.bookings, log: new InMemoryNotificationLogRepo(), alerts, refunds,
    });
    expect(result.stuckRefunds).toBe(1);
    const alert = alerts.sent.find((a) => a.kind === 'refund_stuck_processing');
    expect(alert?.severity).toBe('critical');
    expect(alert?.body).toContain('Do NOT retry');
    expect(alert?.dedupeKey).toBe(refund.id);
  });

  it('says nothing about a refund that only just went out', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const refunds = new InMemoryRefundRepo(bookings, payments);
    const alerts = new FakeAlertAdapter();
    const result = await runWatchdog(new Date(), {
      bookings, log: new InMemoryNotificationLogRepo(), alerts, refunds,
    });
    expect(result.stuckRefunds).toBe(0);
    expect(alerts.sent.filter((a) => a.kind === 'refund_stuck_processing')).toHaveLength(0);
  });
});
