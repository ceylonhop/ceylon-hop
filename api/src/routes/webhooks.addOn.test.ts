import { describe, it, expect } from 'vitest';
import { createApp, type AppDeps } from '../app';
import { FakePaymentAdapter } from '../adapters/payments';
import { FakeEmailAdapter } from '../adapters/email';
import { FakeAlertAdapter } from '../adapters/alerts';
import { FakeGa4Adapter } from '../adapters/ga4';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryAddOnRepo, type AddOnRequest } from '../db/addOnRepo';
import { InMemoryConciergeTaskRepo } from '../db/conciergeTaskRepo';
import { InMemoryNotificationLogRepo } from '../db/notificationLogRepo';
import { InMemoryGa4EventLogRepo, InMemoryGaIdentityRepo } from '../db/ga4Repo';
import { signCheckoutToken } from '../lib/bookingToken';

// What PayHere's notice for an add-on payment sets off (spec 2026-11-14 §6.4): a receipt to the
// customer and a "tell the driver" email to the team when it settles; a loud alert when the money
// arrived for an add-on nobody wants any more; and nothing at all when the card was declined.

const SECRET = 'dev-booking-link-secret-change-me';
const SITE = 'https://site.example.com';
const OPS = 'https://ops.example.com';
const customer = { firstName: 'Anna', lastName: 'Keller', email: 'anna@example.com', whatsapp: '+46700000000', country: 'Sweden' };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const TRAVEL = inDays(10);
const single = (): NewBooking => ({
  mode: 'single',
  input: { from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2, date: TRAVEL, time: '08:00', customer },
  total: 12100, amountDueNow: 12100, currency: 'USD',
});
const SIGHTSEEING = { code: 'sightseeing', label: 'Sightseeing stops (up to 3h) — Colombo Airport → Galle', amountCents: 1000 };
const SAFARI = { code: 'safari-wait', label: 'Wait for Safari — Colombo Airport → Galle', amountCents: 1900 };
const flush = () => new Promise((r) => setTimeout(r, 20)); // GA4 is fire-and-forget

async function world(over: AppDeps = {}) {
  const adapter = new FakePaymentAdapter();
  const email = new FakeEmailAdapter();
  const alerts = new FakeAlertAdapter();
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const addOns = new InMemoryAddOnRepo(bookings, payments);
  const conciergeTasks = new InMemoryConciergeTaskRepo();
  const notificationLog = new InMemoryNotificationLogRepo();
  const ga4Adapter = new FakeGa4Adapter();
  const app = createApp({
    adapter, email, alerts, bookings, payments, addOns, conciergeTasks, notificationLog,
    ga4Adapter, ga4Log: new InMemoryGa4EventLogRepo(), gaIdentities: new InMemoryGaIdentityRepo(), ga4EventName: 'purchase_server',
    bookingBaseUrl: SITE, opsBaseUrl: OPS, ...over,
  });

  // A paid private transfer, the way the trip's own webhook leaves it.
  const created = await bookings.create(single());
  const trip = await payments.create({
    bookingId: created.id, provider: adapter.provider, orderId: created.reference, amount: created.total, currency: 'USD',
    idempotencyKey: `checkout:${created.id}`,
  });
  await bookings.setStatus(created.id, 'payment_pending');
  await payments.markSucceeded(trip.id);
  await bookings.setStatus(created.id, 'paid');
  const b = { id: created.id, reference: created.reference };

  // Ops sends a request and the customer starts paying it, through the real checkout lane.
  const requested = async (lines = [SIGHTSEEING]): Promise<AddOnRequest> => {
    const [leg] = await addOns.listLegs(b.id);
    const request = await addOns.createRequest({
      bookingId: b.id, lines: lines.map((l) => ({ ...l, legId: leg.id })), currency: 'USD', rateCardVersion: 'card-v1',
      createdBy: 'ops@ceylonhop.com', now: new Date(), fullyRefundedPaymentIds: [],
    });
    const res = await app.request(`/bookings/${b.id}/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${signCheckoutToken(b.id, SECRET, Date.now())}`, 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'add_on', addOnRequestId: request.id, returnTo: 'manage' }),
    });
    expect(res.status).toBe(200);
    return request;
  };
  const notify = (request: AddOnRequest, status: 'succeeded' | 'failed' = 'succeeded') =>
    app.request('/webhooks/payments', {
      method: 'POST',
      body: adapter.simulateWebhook({ orderId: `${b.reference}-A${request.seq}`, amount: request.totalCents, currency: 'USD', status }),
    });
  const teamMails = () => alerts.sent.filter((a) => a.kind === 'add_on_paid');
  return { app, adapter, email, alerts, bookings, payments, addOns, conciergeTasks, notificationLog, ga4Adapter, b, requested, notify, teamMails };
}

describe('POST /webhooks/payments: an add-on payment settles', () => {
  it('sends the customer one receipt for the add-on and leaves the booking as it was', async () => {
    const w = await world();
    const request = await w.requested();

    const res = await w.notify(request);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await w.addOns.get(request.id))?.status).toBe('paid');
    expect((await w.bookings.get(w.b.id))?.status).toBe('paid');
    expect(w.email.sent).toHaveLength(1);
    const m = w.email.sent[0];
    expect(m.to).toBe('anna@example.com');
    expect(m.subject).toBe(`Add-on confirmed: Sightseeing stops (up to 3h) — Colombo Airport → Galle · ${w.b.reference}`);
    expect(m.html).toContain('Sightseeing stops (up to 3h) — Colombo Airport → Galle');
    expect(m.html).toContain('$10.00');
    expect(m.html).toContain(`${SITE}/manage.html?t=`);
    // Its own ledger row per request: a booking can have several add-on receipts.
    expect(m.tracking).toMatchObject({ bookingId: w.b.id, kind: 'add_on_paid', trackingKey: `${w.b.id}:add_on_paid:${request.id}` });
    // Nothing the TRIP's settlement does runs again.
    expect(await w.conciergeTasks.list()).toHaveLength(0);
    expect(await w.notificationLog.wasSent(w.b.id, 'confirmation')).toBe(false);
    expect(w.alerts.sent.filter((a) => a.kind === 'booking_paid')).toHaveLength(0);
    expect(w.alerts.sent.filter((a) => a.severity === 'critical')).toHaveLength(0);
  });

  it('names several add-ons in one receipt', async () => {
    const w = await world();
    const request = await w.requested([SIGHTSEEING, SAFARI]);
    await w.notify(request);
    expect(w.email.sent).toHaveLength(1);
    const m = w.email.sent[0];
    expect(m.subject).toBe(`Add-ons confirmed · ${w.b.reference}`);
    expect(m.html).toContain('Sightseeing stops (up to 3h) — Colombo Airport → Galle');
    expect(m.html).toContain('Wait for Safari — Colombo Airport → Galle');
    expect(m.html).toContain('$29.00');
  });

  it('tells the team to tell the driver, under a subject that is not the "Paid:" filter anchor', async () => {
    const w = await world();
    const request = await w.requested();
    await w.notify(request);

    const mails = w.teamMails();
    expect(mails).toHaveLength(1);
    const alert = mails[0];
    expect(alert.severity).toBe('info');
    expect(alert.title).toBe(`Add-on paid, tell the driver: ${w.b.reference}`);
    const mail = alert.email!;
    expect(mail.subject).toBe(`Add-on paid, tell the driver: ${w.b.reference}`);
    expect(mail.subject.startsWith('Paid:')).toBe(false);
    for (const body of [mail.html, mail.text]) {
      expect(body).toContain('Anna Keller');
      expect(body).toContain('Tell the driver for this leg. Nothing was sent to the driver automatically.');
      expect(body).toContain('$10.00');
      expect(body).toContain(`${w.b.reference}-A1`);
      expect(body).toContain('ops@ceylonhop.com');
      expect(body).toContain('08:00');
    }
    expect(mail.text).toContain('Sightseeing stops (up to 3h) — Colombo Airport → Galle');
    expect(mail.text).toContain(`Open the booking: ${OPS}/ops?booking=${w.b.id}`);
    expect(mail.html).toContain(`${OPS}/ops?booking=${w.b.id}`);
  });

  it('a re-delivered notice sends no second receipt and no second team email', async () => {
    const w = await world();
    const request = await w.requested();
    await w.notify(request);
    const again = await w.notify(request);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, idempotent: true });
    expect(w.email.sent).toHaveLength(1);
    expect(w.teamMails()).toHaveLength(1);
  });

  it('reports the payment to GA4 as an add-on, under its own order id', async () => {
    const w = await world();
    const request = await w.requested();
    await w.notify(request);
    await flush();
    expect(w.ga4Adapter.sent).toHaveLength(1);
    expect(w.ga4Adapter.sent[0]).toMatchObject({
      events: [{ name: 'purchase_server', params: { transaction_id: `${w.b.reference}-A1`, value: 10, payment_type: 'add_on' } }],
    });
  });

  it('a receipt that fails to send never fails the webhook, is alerted, and the team is still told', async () => {
    const w = await world({ email: { send: async () => { throw new Error('provider down'); } } });
    const request = await w.requested();
    const res = await w.notify(request);
    expect(res.status).toBe(200);
    expect((await w.addOns.get(request.id))?.status).toBe('paid');
    const failed = w.alerts.sent.filter((a) => a.kind === 'confirmation_email_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].title).toContain(w.b.reference);
    expect(w.teamMails()).toHaveLength(1);
  });

  it('a team email that fails to send costs neither the receipt nor the webhook', async () => {
    const alerts = new FakeAlertAdapter();
    const send = alerts.send.bind(alerts);
    alerts.send = async (a) => {
      if (a.kind === 'add_on_paid') throw new Error('alert transport down');
      return send(a);
    };
    const w = await world({ alerts });
    const request = await w.requested();
    expect((await w.notify(request)).status).toBe(200);
    expect(w.email.sent).toHaveLength(1);
  });
});

describe('POST /webhooks/payments: money for an add-on nobody wants any more', () => {
  it('a request ops cancelled: a critical alert naming the order and the amount, and no receipt', async () => {
    const w = await world();
    const request = await w.requested();
    await w.addOns.cancel(request.id, { by: 'ops@ceylonhop.com', reason: 'changed their mind', now: new Date(), inFlightAfter: new Date(Date.now() + 60_000) });

    const res = await w.notify(request);
    await flush();

    expect(res.status).toBe(200);
    const orphaned = w.alerts.sent.filter((a) => a.kind === 'add_on_orphaned');
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].severity).toBe('critical');
    expect(orphaned[0].title).toContain(`${w.b.reference}-A1`);
    expect(orphaned[0].body).toContain(`${w.b.reference}-A1`);
    expect(orphaned[0].body).toContain('$10.00');
    expect(orphaned[0].body.toLowerCase()).toContain('refund');
    expect(orphaned[0].body).toContain('cancelled');
    expect(w.email.sent).toHaveLength(0);
    expect(w.teamMails()).toHaveLength(0);
    expect(w.ga4Adapter.sent).toHaveLength(0);
    // The money is recorded, so the refund tool can reach it.
    expect((await w.payments.findByOrderId(`${w.b.reference}-A1`))?.status).toBe('succeeded');
    expect((await w.addOns.get(request.id))?.status).toBe('cancelled');
  });

  it('a booking that was cancelled: the same alert, and no receipt', async () => {
    const w = await world();
    const request = await w.requested();
    await w.bookings.setStatus(w.b.id, 'cancelled');

    expect((await w.notify(request)).status).toBe(200);

    const orphaned = w.alerts.sent.filter((a) => a.kind === 'add_on_orphaned');
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].severity).toBe('critical');
    expect(orphaned[0].body).toContain(`${w.b.reference}-A1`);
    expect(orphaned[0].body).toContain('$10.00');
    expect(orphaned[0].body.toLowerCase()).toContain('refund');
    expect(w.email.sent).toHaveLength(0);
    expect(w.teamMails()).toHaveLength(0);
    // Not the trip's "settled in an unexpected state" story.
    expect(w.alerts.sent.filter((a) => a.kind === 'paid_in_unexpected_status')).toHaveLength(0);
    expect((await w.addOns.get(request.id))?.status).toBe('open');
    expect((await w.bookings.get(w.b.id))?.status).toBe('cancelled');
  });
});

describe('POST /webhooks/payments: an add-on card is declined', () => {
  it('sends nothing to the customer and no rescue to the team; the request stays open to pay', async () => {
    const w = await world();
    const request = await w.requested();

    const res = await w.notify(request, 'failed');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'failed' });
    expect(w.email.sent).toHaveLength(0);
    expect(w.alerts.sent).toHaveLength(0);
    expect(await w.notificationLog.wasSent(w.b.id, 'payment_failed')).toBe(false);
    expect((await w.addOns.get(request.id))?.status).toBe('open');
    expect((await w.bookings.get(w.b.id))?.status).toBe('paid');
    expect((await w.payments.findByOrderId(`${w.b.reference}-A1`))?.status).toBe('failed');
  });

  // The trip's "payment failed" email and rescue alert are keyed on the booking being unpaid. An
  // add-on row must skip them whatever state the booking is in.
  it('skips the trip’s failed-payment email and rescue even on a booking that is awaiting payment', async () => {
    const w = await world();
    const unpaid = await w.bookings.create(single());
    await w.bookings.setStatus(unpaid.id, 'payment_pending');
    await w.payments.create({
      bookingId: unpaid.id, provider: w.adapter.provider, orderId: `${unpaid.reference}-A1`, amount: 1000, currency: 'USD',
      idempotencyKey: `checkout:${unpaid.id}:addon:r1`, purpose: 'add_on',
    });

    const res = await w.app.request('/webhooks/payments', {
      method: 'POST',
      body: w.adapter.simulateWebhook({ orderId: `${unpaid.reference}-A1`, amount: 1000, currency: 'USD', status: 'failed' }),
    });

    expect(res.status).toBe(200);
    expect(w.email.sent).toHaveLength(0);
    expect(w.alerts.sent.filter((a) => a.kind === 'payment_rescue')).toHaveLength(0);
    expect(await w.notificationLog.wasSent(unpaid.id, 'payment_failed')).toBe(false);
  });

  it('a later approval on the same order still settles and sends the receipt', async () => {
    const w = await world();
    const request = await w.requested();
    await w.notify(request, 'failed');
    const res = await w.app.request('/webhooks/payments', {
      method: 'POST',
      body: w.adapter.simulateWebhook({ orderId: `${w.b.reference}-A1`, amount: 1000, currency: 'USD', providerTxnId: 'txn_second_try' }),
    });
    expect(res.status).toBe(200);
    expect((await w.addOns.get(request.id))?.status).toBe('paid');
    expect(w.email.sent).toHaveLength(1);
    expect(w.teamMails()).toHaveLength(1);
  });
});
