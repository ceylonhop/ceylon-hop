import { describe, it, expect, vi } from 'vitest';
import { FakeGa4Adapter } from '../../adapters/ga4';
import { FakeAlertAdapter } from '../../adapters/alerts';
import { InMemoryGa4EventLogRepo, InMemoryGaIdentityRepo } from '../../db/ga4Repo';
import { InMemoryBookingRepo, type Booking } from '../../db/bookingRepo';
import { InMemoryPaymentRepo, type Payment } from '../../db/paymentRepo';
import type { Refund } from '../../db/refundRepo';
import type { RideList, RideMember } from '../../domain/rideList';
import type { Ga4PurchaseName } from './ga4Hits';
import { SWEEP_BATCH, createGa4Reporter, parseGaIdentity } from './ga4Reporter';

const NOW = new Date('2026-10-29T08:00:00Z');
const customer = (email: string) => ({ firstName: 'E', lastName: 'L', email, phoneCountryCode: '+44', phoneNumber: '7700900000', country: 'United Kingdom' });
const booking = (email = 'emma@example.test', over: Partial<Booking> = {}) => ({
  id: 'b-1', reference: 'CH-TEST1', status: 'paid', mode: 'single', channel: 'website', currency: 'USD', total: 22900, amountDueNow: 22900,
  createdAt: '2026-10-28T10:00:00.000Z',
  input: { customer: customer(email), from: 'Colombo Airport (CMB)', to: 'Galle', date: '2026-11-08', time: '09:00', adults: 2, children: 0, bags: 2, vehicleType: 'car' },
  ...over,
}) as unknown as Booking;
const payment = { id: 'pay-1', bookingId: 'b-1', provider: 'payhere', orderId: 'CH-TEST1', amount: 22900, currency: 'USD', idempotencyKey: 'k', status: 'succeeded', attemptCount: 1, lastAttemptAt: null } as Payment;
const refundOf = (paymentId: string, id = 'r-1') => ({ id, bookingId: 'b-1', paymentId, provider: 'payhere', amountCents: 5000, currency: 'USD', status: 'succeeded', reason: 'changed plans' }) as unknown as Refund;
const txnOf = (hit: { events: { params: Record<string, unknown> }[] } | undefined) => hit?.events[0]?.params.transaction_id;

function setup(opts: { adapter?: FakeGa4Adapter | null; team?: string[]; eventName?: Ga4PurchaseName } = {}) {
  const adapter = opts.adapter === null ? undefined : (opts.adapter ?? new FakeGa4Adapter());
  const log = new InMemoryGa4EventLogRepo();
  const identities = new InMemoryGaIdentityRepo();
  const alerts = new FakeAlertAdapter();
  const payments = new InMemoryPaymentRepo();
  const reporter = createGa4Reporter({
    adapter, log, identities, bookings: new InMemoryBookingRepo(), payments, alerts,
    teamEmails: new Set(opts.team ?? ['roshenw@gmail.com']), eventName: opts.eventName ?? 'purchase_server', now: () => NOW,
  });
  return { reporter, adapter, log, identities, alerts, payments };
}

describe('parseGaIdentity', () => {
  it('keeps only well-formed ids; nothing to send is null', () => {
    expect(parseGaIdentity({ clientId: '1.2', sessionId: '1761724800', adConsent: 'granted' })).toEqual({ clientId: '1.2', sessionId: '1761724800', adConsent: 'granted' });
    expect(parseGaIdentity({ clientId: 'x.y', sessionId: '12', adConsent: 'maybe' })).toBeNull();
    expect(parseGaIdentity({ clientId: '1.2', adConsent: 'maybe' })).toEqual({ clientId: '1.2', sessionId: null, adConsent: 'unknown' });
    expect(parseGaIdentity(undefined)).toBeNull();
  });
});

describe('Ga4Reporter', () => {
  it('reports a payment once, joined to the remembered visit', async () => {
    const { reporter, adapter, identities } = setup();
    await reporter.rememberVisitor('b-1', { clientId: '123.456', sessionId: '1761724800', adConsent: 'unknown' });
    expect(await identities.get('b-1')).toEqual({ clientId: '123.456', sessionId: '1761724800', adConsent: 'unknown' });
    await reporter.reportPayment(booking(), payment, NOW);
    await reporter.reportPayment(booking(), payment, NOW); // a replayed hook
    expect(adapter!.sent).toHaveLength(1);
    expect(adapter!.sent[0]).toMatchObject({ client_id: '123.456', events: [{ name: 'purchase_server' }] });
  });
  it('never reports a team test booking', async () => {
    const { reporter, adapter } = setup();
    await reporter.reportPayment(booking('Roshenw@Gmail.com'), payment, NOW);
    expect(adapter!.sent).toHaveLength(0);
  });
  it('without a secret it sends and claims nothing — but still remembers the visitor', async () => {
    const { reporter, log, identities } = setup({ adapter: null });
    await reporter.rememberVisitor('b-1', { clientId: '1.2' });
    await reporter.reportPayment(booking(), payment, NOW);
    expect(await identities.get('b-1')).not.toBeNull();
    expect(await log.listRetryable(new Date(0), new Date(NOW.getTime() + 3_600_000), 100)).toEqual([]);
  });
  it('a failed send is retried by the sweep with the SAME hit, and alerts once at 5 attempts', async () => {
    const adapter = new FakeGa4Adapter();
    adapter.failNext = 5;
    const { reporter, alerts } = setup({ adapter });
    await reporter.reportPayment(booking(), payment, NOW); // attempt 1 fails
    for (let i = 0; i < 4; i++) await reporter.sweep(); // attempts 2-5 fail
    expect(alerts.sent.filter((a) => a.kind === 'ga4_send_failed')).toHaveLength(1);
    const res = await reporter.sweep(); // attempt 6 succeeds
    expect(res).toEqual({ retried: 1, sent: 1, failed: 0 });
    expect(adapter.sent).toHaveLength(1);
  });
  it('one sweep retries at most SWEEP_BATCH events; the rest wait for the next sweep', async () => {
    const adapter = new FakeGa4Adapter();
    const total = SWEEP_BATCH + 3;
    adapter.failNext = total;
    const { reporter } = setup({ adapter });
    const list = { id: 'l1', code: 'EM-1', fromPlace: 'Ella', toPlace: 'Mirissa', date: '2026-11-08' } as RideList;
    for (let i = 0; i < total; i++) {
      await reporter.reportBoardCharge(list, { sub: `s${i}`, email: `a${i}@x.com`, country: 'Australia', seats: 1 } as RideMember, 2400, 'USD', NOW);
    }
    expect(adapter.sent).toHaveLength(0); // every first attempt failed
    expect(await reporter.sweep()).toEqual({ retried: SWEEP_BATCH, sent: SWEEP_BATCH, failed: 0 });
    expect(await reporter.sweep()).toEqual({ retried: 3, sent: 3, failed: 0 });
    expect(adapter.sent).toHaveLength(total);
  });
  it('reports a ride-board charge, skipping a team member', async () => {
    const { reporter, adapter } = setup();
    const list = { id: 'l1', code: 'EM-1', fromPlace: 'Ella', toPlace: 'Mirissa', date: '2026-11-08' } as RideList;
    await reporter.reportBoardCharge(list, { sub: 's1', email: 'a@x.com', country: 'Australia', seats: 1 } as RideMember, 2400, 'USD', NOW);
    await reporter.reportBoardCharge(list, { sub: 's2', email: 'roshenw@gmail.com', country: 'LK', seats: 1 } as RideMember, 2400, 'USD', NOW);
    expect(adapter!.sent).toHaveLength(1);
  });
});

describe('Ga4Reporter refunds reverse the purchase they were sent with', () => {
  // The deposit settles and is reported BEFORE the balance payment exists, as in production.
  async function depositThenBalance() {
    const s = setup();
    const mk = async (n: number, amount: number) => {
      const p = await s.payments.create({ bookingId: 'b-1', provider: 'payhere', orderId: `CH-TEST1-${n}`, amount, currency: 'USD', idempotencyKey: `k${n}` });
      return s.payments.markSucceeded(p.id);
    };
    const first = await mk(1, 17900);
    await s.reporter.reportPayment(booking(), first, NOW);
    const second = await mk(2, 5000);
    await s.reporter.reportPayment(booking(), second, NOW);
    return { ...s, first, second };
  }

  it("a second payment's refund carries that purchase's transaction_id", async () => {
    const { reporter, adapter, second } = await depositThenBalance();
    await reporter.reportRefund(booking(), refundOf(second.id));
    const [, secondPurchase, refund] = adapter!.sent;
    expect(txnOf(secondPurchase)).toBe(`CH-TEST1-${second.id.slice(0, 6)}`);
    expect(refund.events[0].name).toBe('refund_server'); // shadow mode: the purchase went out as purchase_server
    expect(txnOf(refund)).toBe(txnOf(secondPurchase));
  });
  it('after the switch-over (event name purchase) a refund goes out as the real refund', async () => {
    const { reporter, adapter } = setup({ eventName: 'purchase' });
    await reporter.reportPayment(booking(), payment, NOW);
    await reporter.reportRefund(booking(), refundOf(payment.id));
    expect(adapter!.sent.map((h) => h.events[0].name)).toEqual(['purchase', 'refund']);
  });
  it("a refund reuses its purchase's client_id when there is no stored identity", async () => {
    const { reporter, adapter } = setup();
    await reporter.reportPayment(booking(), payment, NOW);
    await reporter.reportRefund(booking(), refundOf(payment.id));
    const [purchase, refund] = adapter!.sent;
    expect(purchase.client_id).toMatch(/^srv\.[0-9a-f]{16}$/);
    expect(refund.client_id).toBe(purchase.client_id);
  });
  it('a stored identity still wins over the purchase client_id', async () => {
    const { reporter, adapter, identities } = setup();
    await reporter.reportPayment(booking(), payment, NOW); // sent with a synthetic id
    await identities.set('b-1', { clientId: '123.456', sessionId: null, adConsent: 'unknown' });
    await reporter.reportRefund(booking(), refundOf(payment.id));
    expect(adapter!.sent[1].client_id).toBe('123.456');
  });
  it('a refund with no purchase row uses the bare reference', async () => {
    const { reporter, adapter } = setup();
    await reporter.reportRefund(booking(), refundOf('pay-9'));
    expect(txnOf(adapter!.sent[0])).toBe('CH-TEST1');
  });
  it('a refund of the FIRST payment after a second payment exists uses the bare reference', async () => {
    const { reporter, adapter, first } = await depositThenBalance();
    await reporter.reportRefund(booking(), refundOf(first.id));
    expect(txnOf(adapter!.sent[0])).toBe('CH-TEST1');
    expect(txnOf(adapter!.sent[2])).toBe('CH-TEST1');
  });
  it('an unreadable stored payload falls back to the bare reference', async () => {
    const { reporter, adapter, log } = setup();
    await log.claim('purchase:pay-5', 'purchase', { nonsense: true }, NOW);
    await reporter.reportRefund(booking(), refundOf('pay-5'));
    expect(txnOf(adapter!.sent[0])).toBe('CH-TEST1');
  });
});

describe('Ga4Reporter never breaks a money path', () => {
  it('swallows and alerts a storage failure, with the message only', async () => {
    const { reporter, log, alerts } = setup();
    log.claim = async () => { throw Object.assign(new Error('db_down'), { cause: { secret: 'API-SECRET-XYZ' } }); };
    await expect(reporter.reportPayment(booking(), payment, NOW)).resolves.toBeUndefined();
    await expect(reporter.reportRefund(booking(), refundOf('pay-1'))).resolves.toBeUndefined();
    await expect(reporter.sweep()).resolves.toEqual({ retried: 0, sent: 0, failed: 0 });
    expect(alerts.sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(alerts.sent)).not.toContain('API-SECRET-XYZ');
    expect(JSON.stringify(alerts.sent)).toContain('db_down');
  });
  it('names the lost event: two bookings failing before the claim give two distinct alerts', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { reporter, log, alerts } = setup();
      log.claim = async () => { throw Object.assign(new Error('db_down'), { cause: { secret: 'API-SECRET-XYZ' } }); };
      await reporter.reportPayment(booking('a@example.test', { id: 'b-1', reference: 'CH-AAAA1' }), { ...payment, id: 'pay-a' }, NOW);
      await reporter.reportPayment(booking('b@example.test', { id: 'b-2', reference: 'CH-BBBB2' }), { ...payment, id: 'pay-b', bookingId: 'b-2' }, NOW);
      const errs = alerts.sent.filter((a) => a.kind === 'ga4_report_error');
      expect(errs).toHaveLength(2);
      expect(errs[0].dedupeKey).not.toBe(errs[1].dedupeKey);
      expect(errs[0].dedupeKey).toContain('CH-AAAA1');
      expect(errs[1].dedupeKey).toContain('CH-BBBB2');
      expect(errs[0].dedupeKey).toContain('purchase:pay-a');
      expect(errs[0].title + errs[0].body).toContain('CH-AAAA1');
      // The console fallback carries the message string, the key and the reference: no error object.
      expect(spy).toHaveBeenCalledTimes(2);
      for (const call of spy.mock.calls) {
        expect(call).toHaveLength(1);
        expect(typeof call[0]).toBe('string');
        expect(call[0]).toContain('db_down');
        expect(call[0]).not.toContain('API-SECRET-XYZ');
      }
      expect(spy.mock.calls[0][0]).toContain('CH-AAAA1');
    } finally {
      spy.mockRestore();
    }
  });
  it('names a lost board charge by its list code, never the member id', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { reporter, log, alerts } = setup();
      log.claim = async () => { throw new Error('db_down'); };
      const list = { id: 'l1', code: 'EM-1', fromPlace: 'Ella', toPlace: 'Mirissa', date: '2026-11-08' } as RideList;
      await reporter.reportBoardCharge(list, { sub: 'google-sub-777', email: 'a@x.com', country: 'AU', seats: 1 } as RideMember, 2400, 'USD', NOW);
      expect(alerts.sent[0].dedupeKey).toContain('EM-1');
      expect(JSON.stringify([alerts.sent, spy.mock.calls])).not.toContain('google-sub-777');
    } finally {
      spy.mockRestore();
    }
  });
  it('swallows a failing identity store and a failing alert channel', async () => {
    const { reporter, identities, alerts } = setup();
    identities.set = async () => { throw new Error('id_store_down'); };
    alerts.send = async () => { throw new Error('alerts_down'); };
    await expect(reporter.rememberVisitor('b-1', { clientId: '1.2' })).resolves.toBeUndefined();
  });
});
