import { describe, it, expect } from 'vitest';
import {
  paymentVerdict, caseTimeline, caseGaps, normaliseCaseRef, LOG_START, DECLINES_START, DUPLICATE_CLOSE_ACTOR,
  type CaseEvidence, type CasePayment,
} from './paymentCase';
import { DUPLICATE_CLOSED_BY } from '../services/duplicateBookings';
import type { PaymentEvent } from '../db/paymentEventRepo';
import type { BookingCheckoutEvent } from '../db/bookingCheckoutEventRepo';
import type { Refund } from '../db/refundRepo';

// The ops payment lookup's judgement (spec 2026-09-26 §6-§8): one of nine payment situations, a
// merged timeline, and the gaps — all from recorded evidence. PayHere's stored status code decides
// card money; payments.status and booking.status never do.

const T = (hms: string) => new Date(`2026-09-26T${hms}Z`); // after both LOG_START and DECLINES_START
let seq = 0;

const evidence = (over: Partial<Omit<CaseEvidence, 'booking'>> & { booking?: Partial<CaseEvidence['booking']> } = {}): CaseEvidence => {
  const { booking, ...rest } = over;
  return {
    booking: {
      id: 'b1', reference: 'CH-AAAA2', status: 'payment_pending', createdAt: T('09:00:00'),
      cancelledAt: null, cancelledBy: null, cancellationReason: null, ...booking,
    },
    payments: [], notices: [], log: [], refunds: [], emails: [], unavailable: [],
    ...rest,
  };
};

const gateway = (over: Partial<CasePayment> = {}): CasePayment => ({
  id: 'p1', bookingId: 'b1', provider: 'payhere', orderId: 'CH-AAAA2', amount: 5000, currency: 'USD',
  idempotencyKey: 'checkout:b1', status: 'pending', attemptCount: 1, lastAttemptAt: T('09:01:00'),
  createdAt: T('09:01:00'), settledAt: null, settlementSource: null, settledBy: null, gatewayPaymentId: null,
  ...over,
});

const manual = (over: Partial<CasePayment> = {}): CasePayment => ({
  id: 'p2', bookingId: 'b1', provider: 'cash', orderId: 'CH-AAAA2-MANUAL', amount: 5000, currency: 'USD',
  idempotencyKey: 'manual-paid:b1', status: 'succeeded', attemptCount: 0, lastAttemptAt: null,
  createdAt: T('12:00:00'), settledAt: T('12:00:00'), settlementSource: 'manual', settledBy: 'f@x.com', gatewayPaymentId: 'SLIP-7',
  ...over,
});

const NORMALIZED: Record<string, PaymentEvent['normalizedStatus']> = { '2': 'succeeded', '0': 'pending', '-1': 'cancelled', '-2': 'failed', '-3': 'charged_back' };
const notice = (code: string, at: Date, over: Partial<PaymentEvent> & { message?: string } = {}): PaymentEvent => {
  const { message, ...rest } = over;
  const txn = rest.providerTxnId ?? (code === '2' ? '320048289427' : '0');
  return {
    id: `e${++seq}`, paymentId: 'p1', provider: 'payhere', providerTxnId: txn, providerStatusCode: code,
    normalizedStatus: NORMALIZED[code], amount: 5000, currency: 'USD', payloadSha256: 'a'.repeat(64),
    sanitizedPayload: { order_id: 'CH-AAAA2', payment_id: txn, status_code: code, method: 'VISA', ...(message ? { status_message: message } : {}) },
    receivedAt: at, ...rest,
  };
};

const log = (action: BookingCheckoutEvent['action'], outcome: BookingCheckoutEvent['outcome'], at: Date, over: Partial<BookingCheckoutEvent> = {}): BookingCheckoutEvent => ({
  id: `l${++seq}`, at, action, outcome, source: 'server', bookingId: 'b1', reference: 'CH-AAAA2', orderId: 'CH-AAAA2',
  channel: 'website', reason: null, httpStatus: null, attempt: null, ua: null, ...over,
});

const refund = (over: Partial<Refund> = {}): Refund => ({
  id: 'r1', bookingId: 'b1', paymentId: 'p1', provider: 'payhere', amountCents: 5000, currency: 'USD',
  status: 'manual_pending', reason: 'customer cancelled', gatewayRef: null, requestedBy: 'f@x.com', requestedAt: T('13:00:00'),
  confirmedBy: null, confirmedAt: null, providerMessage: null, apiAttemptedAt: null, createdAt: T('13:00:00'), updatedAt: T('13:00:00'),
  ...over,
});

// A typical paid-by-card story: two checkouts, a decline, then approval.
const paidByCard = () => evidence({
  booking: { status: 'paid' },
  payments: [gateway({ status: 'succeeded', settledAt: T('09:20:00'), settlementSource: 'webhook', gatewayPaymentId: '320048289427' })],
  log: [
    log('checkout', 'succeeded', T('09:01:00'), { attempt: 1 }),
    log('gateway', 'opened', T('09:01:05'), { source: 'client', ua: 'iPhone Safari' }),
    log('webhook', 'failed', T('09:05:00'), { httpStatus: 200 }),
    log('checkout', 'succeeded', T('09:15:00'), { attempt: 2 }),
    log('webhook', 'settled', T('09:20:00'), { httpStatus: 200 }),
  ],
  notices: [notice('-2', T('09:05:00'), { message: 'Insufficient funds' }), notice('2', T('09:20:00'), { message: 'Successfully completed' })],
});

describe('the duplicate-close actor', () => {
  it('is the one the settle path writes', () => {
    expect(DUPLICATE_CLOSE_ACTOR).toBe(DUPLICATE_CLOSED_BY);
  });
});

describe('normaliseCaseRef', () => {
  it('trims, upper-cases and drops the manual-payment suffix', () => {
    expect(normaliseCaseRef(' ch-ab12c-manual ')).toEqual({ kind: 'booking', ref: 'CH-AB12C' });
    expect(normaliseCaseRef('q-7f3kx')).toEqual({ kind: 'quote', ref: 'Q-7F3KX' });
  });
  it('refuses anything that is not a booking or quote reference', () => {
    for (const bad of ['', 'hello', 'CH-', 'X-AB12C', 'CH-AB 12C', 'CH-AB12C;drop']) expect(normaliseCaseRef(bad)).toBeNull();
  });
});

describe('paymentVerdict — the nine situations', () => {
  it('1 paid: on checkout 2, after one decline notice, with PayHere’s id and card type', () => {
    expect(paymentVerdict(paidByCard())).toMatchObject({
      kind: 'paid', at: T('09:20:00').toISOString(), amount: 5000, currency: 'USD',
      checkouts: 2, declineNotices: 1, countsComplete: true,
      payhere: { code: '2', message: 'Successfully completed', method: 'VISA', paymentId: '320048289427' },
      warnings: [],
    });
  });

  it('2 paid by hand: method, who recorded it, their reference', () => {
    const v = paymentVerdict(evidence({ booking: { status: 'paid' }, payments: [manual()] }));
    expect(v).toMatchObject({ kind: 'paid_by_hand', at: T('12:00:00').toISOString(), amount: 5000,
      manual: { method: 'cash', settledBy: 'f@x.com', reference: 'SLIP-7' } });
  });

  it('2 paid by hand on an old row: who is "not recorded" (null)', () => {
    const v = paymentVerdict(evidence({ booking: { status: 'paid' }, payments: [manual({ settledBy: null, gatewayPaymentId: null })] }));
    expect(v?.manual).toEqual({ method: 'cash', settledBy: null, reference: null });
  });

  it('3 declined: PayHere’s latest answer to the latest checkout was -2, with its message', () => {
    const v = paymentVerdict(evidence({
      payments: [gateway({ status: 'failed' })],
      log: [log('checkout', 'succeeded', T('09:01:00')), log('webhook', 'failed', T('09:05:00'))],
      notices: [notice('-2', T('09:05:00'), { message: 'Do not honour' })],
    }));
    expect(v).toMatchObject({ kind: 'declined', at: T('09:05:00').toISOString(), checkouts: 1, declineNotices: 1,
      payhere: { code: '-2', message: 'Do not honour', method: 'VISA', paymentId: '0' } });
  });

  it('3 declined: -1 (cancelled on PayHere’s page) reads as declined too', () => {
    const v = paymentVerdict(evidence({
      payments: [gateway({ status: 'failed' })],
      log: [log('checkout', 'succeeded', T('09:01:00')), log('webhook', 'dismissed', T('09:03:00'))],
      notices: [notice('-1', T('09:03:00'))],
    }));
    expect(v).toMatchObject({ kind: 'declined', payhere: { code: '-1' } });
  });

  it('3 declined: repeated declines collapse to one stored row, but every notice is counted from the log', () => {
    const v = paymentVerdict(evidence({
      payments: [gateway({ status: 'failed' })],
      log: [
        log('checkout', 'succeeded', T('09:01:00')), log('webhook', 'failed', T('09:02:00')),
        log('checkout', 'succeeded', T('09:04:00')), log('webhook', 'failed', T('09:05:00')),
        log('checkout', 'succeeded', T('09:07:00')), log('webhook', 'failed', T('09:08:00')),
      ],
      notices: [notice('-2', T('09:02:00'), { message: 'Do not honour' })], // PayHere's payment_id "0" every time
    }));
    expect(v).toMatchObject({ kind: 'declined', at: T('09:08:00').toISOString(), checkouts: 3, declineNotices: 3,
      payhere: { code: '-2', message: 'Do not honour' } });
  });

  it('4 reached PayHere, no answer: the website reported opening PayHere and nothing came back', () => {
    const v = paymentVerdict(evidence({
      payments: [gateway()],
      log: [log('checkout', 'succeeded', T('09:01:00')), log('gateway', 'opened', T('09:01:05'), { source: 'client' })],
    }));
    expect(v).toMatchObject({ kind: 'reached_no_answer', at: T('09:01:05').toISOString() });
  });

  it('4 reached PayHere: a pay-link customer coming back from PayHere proves it without a gateway row', () => {
    const v = paymentVerdict(evidence({
      payments: [gateway()],
      log: [log('checkout', 'succeeded', T('09:01:00'), { channel: 'whatsapp' }), log('return', 'pending', T('09:06:00'))],
    }));
    expect(v?.kind).toBe('reached_no_answer');
  });

  it('4 reached PayHere: a code-0 (pending) notice is not a final answer', () => {
    const v = paymentVerdict(evidence({
      payments: [gateway({ status: 'failed' })], // today's settlement marks pending as failed; the code decides
      log: [log('checkout', 'succeeded', T('09:01:00')), log('webhook', 'pending', T('09:03:00'))],
      notices: [notice('0', T('09:03:00'))],
    }));
    expect(v?.kind).toBe('reached_no_answer');
  });

  it('a decline followed by a new checkout with nothing after is not "declined" any more', () => {
    const base = {
      payments: [gateway({ status: 'failed' })],
      notices: [notice('-2', T('09:05:00'))],
    };
    const quiet = paymentVerdict(evidence({ ...base, log: [
      log('checkout', 'succeeded', T('09:01:00')), log('webhook', 'failed', T('09:05:00')), log('checkout', 'succeeded', T('09:10:00')),
    ] }));
    expect(quiet).toMatchObject({ kind: 'checkout_no_trace', at: T('09:10:00').toISOString(), declineNotices: 1 });
    const cameBack = paymentVerdict(evidence({ ...base, log: [
      log('checkout', 'succeeded', T('09:01:00')), log('webhook', 'failed', T('09:05:00')),
      log('checkout', 'succeeded', T('09:10:00')), log('return', 'failed', T('09:12:00')), // stale "failed" from the earlier row
    ] }));
    expect(cameBack?.kind).toBe('reached_no_answer');
  });

  it('5 started checkout, nothing after', () => {
    const v = paymentVerdict(evidence({ payments: [gateway()], log: [log('checkout', 'succeeded', T('09:01:00'))] }));
    expect(v).toMatchObject({ kind: 'checkout_no_trace', at: T('09:01:00').toISOString(), checkouts: 1 });
  });

  it('5 a booking older than the checkout log with a pending payment row reads as a started checkout, counts incomplete', () => {
    const e = evidence({ booking: { createdAt: new Date('2026-09-10T08:00:00Z') }, payments: [gateway({ createdAt: new Date('2026-09-10T08:01:00Z') })] });
    const v = paymentVerdict(e);
    expect(v).toMatchObject({ kind: 'checkout_no_trace', at: '2026-09-10T08:01:00.000Z', checkouts: 0, countsComplete: false });
    expect(caseGaps(e, v)).toEqual(['no_checkout_log', 'declines_may_be_missing', 'no_gateway_report']);
  });

  it('6 never started checkout — even for a pay-link booking already moved to payment_pending', () => {
    const v = paymentVerdict(evidence({ booking: { status: 'payment_pending' } }));
    expect(v).toMatchObject({ kind: 'never_started', at: T('09:00:00').toISOString() });
    expect(paymentVerdict(evidence({ booking: { status: 'draft' }, log: [log('checkout', 'refused', T('09:01:00'), { reason: 'awaiting_price' })] }))?.kind)
      .toBe('never_started');
  });

  it('7 paid on another booking: parses the paying reference from the duplicate close', () => {
    const v = paymentVerdict(evidence({
      booking: { status: 'cancelled', cancelledAt: T('10:00:00'), cancelledBy: 'system:duplicate-close', cancellationReason: 'duplicate — paid on CH-L72HX' },
      payments: [gateway()], log: [log('checkout', 'succeeded', T('09:01:00'))],
    }));
    expect(v).toMatchObject({ kind: 'paid_elsewhere', paidOn: 'CH-L72HX', at: T('10:00:00').toISOString(), cancellation: null });
  });

  it('8 paid twice: two PayHere payments on one order', () => {
    const e = paidByCard();
    e.notices.push(notice('2', T('09:25:00'), { providerTxnId: '320048289999' }));
    expect(paymentVerdict(e)).toMatchObject({ kind: 'paid_twice', captures: [
      { via: 'payhere', id: '320048289427', method: 'VISA' }, { via: 'payhere', id: '320048289999', method: 'VISA' },
    ] });
  });

  it('8 paid twice: by card and by hand', () => {
    const e = paidByCard();
    e.payments.push(manual());
    expect(paymentVerdict(e)).toMatchObject({ kind: 'paid_twice', captures: [
      { via: 'payhere', id: '320048289427', method: 'VISA' }, { via: 'manual', id: 'SLIP-7', method: 'cash' },
    ] });
  });

  it('9 money went back: a refund, with what was refunded of what was captured', () => {
    const e = paidByCard();
    e.refunds.push(refund({ status: 'manual_confirmed', amountCents: 2000, gatewayRef: 'RF-1', confirmedBy: 'f@x.com', confirmedAt: T('14:00:00') }));
    expect(paymentVerdict(e)).toMatchObject({ kind: 'money_back', refund: { state: 'confirmed', refundedCents: 2000, capturedCents: 5000 } });
  });

  it('9 money went back: a chargeback on a paid booking', () => {
    const e = paidByCard();
    e.notices.push(notice('-3', T('15:00:00'), { providerTxnId: '320048289427' }));
    expect(paymentVerdict(e)).toMatchObject({ kind: 'money_back', chargebackAt: T('15:00:00').toISOString() });
  });

  it('refund states: processing beats requested beats confirmed; a cancelled request is no refund', () => {
    const e = paidByCard();
    e.refunds.push(refund({ id: 'r1', status: 'api_processing', apiAttemptedAt: T('13:01:00') }), refund({ id: 'r2', status: 'manual_pending' }));
    expect(paymentVerdict(e)?.refund?.state).toBe('processing');
    const cancelledOnly = paidByCard();
    cancelledOnly.refunds.push(refund({ status: 'cancelled' }));
    expect(paymentVerdict(cancelledOnly)).toMatchObject({ kind: 'paid', refund: null });
  });

  it('precedence: paid twice with a refund stays "paid twice" and carries the refund', () => {
    const e = paidByCard();
    e.notices.push(notice('2', T('09:25:00'), { providerTxnId: '320048289999' }));
    e.refunds.push(refund({ status: 'manual_pending' }));
    expect(paymentVerdict(e)).toMatchObject({ kind: 'paid_twice', refund: { state: 'requested' } });
  });

  it('a legacy-backfilled gateway row counts as card money even with no stored notice', () => {
    const v = paymentVerdict(evidence({ booking: { status: 'paid', createdAt: new Date('2026-07-01T08:00:00Z') },
      payments: [gateway({ status: 'succeeded', settlementSource: 'legacy_backfill', settledAt: new Date('2026-07-01T09:00:00Z'), gatewayPaymentId: 'OLD1' })] }));
    expect(v).toMatchObject({ kind: 'paid', at: '2026-07-01T09:00:00.000Z', payhere: { code: '2', paymentId: 'OLD1', message: null } });
  });

  it('never trusts payments.status for card money: a failed row with a success notice is paid', () => {
    const e = paidByCard();
    e.payments[0] = gateway({ status: 'failed' });
    expect(paymentVerdict(e)?.kind).toBe('paid');
  });

  it('adds the cancellation (who and why) whenever the booking is cancelled', () => {
    const v = paymentVerdict(evidence({ booking: { status: 'cancelled', cancelledAt: T('10:00:00'), cancelledBy: 'o@x.com', cancellationReason: 'customer asked' } }));
    expect(v).toMatchObject({ kind: 'never_started', cancellation: { by: 'o@x.com', reason: 'customer asked' } });
  });

  it('reads the fake gateway’s stored status word as the PayHere code it stands for', () => {
    const e = paidByCard();
    e.notices = e.notices.map((n) => ({ ...n, provider: 'fake', providerStatusCode: n.normalizedStatus }));
    expect(paymentVerdict(e)?.kind).toBe('paid');
    expect(caseTimeline(e).filter((r) => r.kind === 'notice').map((r) => r.kind === 'notice' && r.code)).toEqual(['-2', '2']);
  });

  it('gives no verdict when any source failed to load', () => {
    expect(paymentVerdict(evidence({ unavailable: ['refunds'] }))).toBeNull();
  });
});

describe('paymentVerdict — mismatch warnings', () => {
  it('money received while the booking still says unpaid', () => {
    const e = paidByCard();
    e.booking.status = 'payment_pending';
    expect(paymentVerdict(e)?.warnings).toEqual(['money_on_unpaid_booking']);
  });
  it('money that arrived after the booking was cancelled', () => {
    const e = paidByCard();
    Object.assign(e.booking, { status: 'cancelled', cancelledAt: T('09:10:00'), cancelledBy: 'o@x.com', cancellationReason: 'dup' });
    expect(paymentVerdict(e)?.warnings).toEqual(['money_after_cancel']);
  });
  it('a paid booking cancelled afterwards is the normal cancel-then-refund order, not a mismatch', () => {
    const e = paidByCard();
    Object.assign(e.booking, { status: 'cancelled', cancelledAt: T('11:00:00'), cancelledBy: 'o@x.com', cancellationReason: 'trip off' });
    expect(paymentVerdict(e)?.warnings).toEqual([]);
  });
  it('a booking that says paid with no payment recorded', () => {
    expect(paymentVerdict(evidence({ booking: { status: 'confirmed' } }))?.warnings).toEqual(['paid_status_without_payment']);
  });
});

describe('caseGaps', () => {
  it('names only the gaps that touch this booking', () => {
    const e = evidence();
    expect(caseGaps(e, paymentVerdict(e))).toEqual([]);
    const old = evidence({ booking: { createdAt: new Date(LOG_START.getTime() + 60_000) } });
    expect(caseGaps(old, paymentVerdict(old))).toEqual(['declines_may_be_missing']);
    expect(DECLINES_START.getTime()).toBeGreaterThan(LOG_START.getTime());
  });
  it('flags a cancellation nobody signed', () => {
    const e = evidence({ booking: { status: 'cancelled' } }); // the 24h shared-seat sweep writes no audit
    expect(caseGaps(e, paymentVerdict(e))).toContain('actor_not_recorded');
  });
});

describe('caseTimeline', () => {
  it('merges every source oldest first, and leaves out webhook rows the notices already show', () => {
    const e = paidByCard();
    e.emails.push({ kind: 'payment_failed', sentAt: T('09:05:01') }, { kind: 'confirmation', sentAt: T('09:20:01') });
    const rows = caseTimeline(e);
    expect(rows.map((r) => `${r.source}:${r.kind}${'action' in r ? ':' + r.action : ''}${'code' in r ? ':' + r.code : ''}`)).toEqual([
      'bookings:created',
      'booking_checkout_event:log:checkout',
      'payments:payment_created',
      'booking_checkout_event:log:gateway',
      'payment_events:notice:-2',
      'notification_log:email',
      'booking_checkout_event:log:checkout',
      'payment_events:notice:2',
      'notification_log:email',
    ]);
    expect(rows.find((r) => r.kind === 'email' && r.emailKind === 'payment_failed')).toMatchObject({ deliveryTracked: false });
    expect(rows.find((r) => r.kind === 'email' && r.emailKind === 'confirmation')).toMatchObject({ deliveryTracked: true });
    expect(rows.find((r) => r.kind === 'log' && r.action === 'gateway')).toMatchObject({ client: true, ua: 'iPhone Safari', orderMatchOnly: false });
  });

  it('shows the booking’s creation once: the log’s create row (it carries the device) replaces the bare one', () => {
    const withCreate = evidence({ log: [log('create', 'succeeded', T('09:00:00'), { httpStatus: 201, ua: 'iPhone Safari' })] });
    const created = caseTimeline(withCreate).filter((r) => r.kind === 'created' || (r.kind === 'log' && r.action === 'create'));
    expect(created).toEqual([expect.objectContaining({ kind: 'log', action: 'create', ua: 'iPhone Safari' })]);
    // A pay-link or ops-made booking has no create row: the booking's own timestamp stands in.
    expect(caseTimeline(evidence()).map((r) => r.kind)).toEqual(['created']);
  });

  it('lists the webhook rows when the notices could not be loaded', () => {
    const e = paidByCard();
    e.notices = [];
    e.unavailable = ['payment_events'];
    expect(caseTimeline(e).filter((r) => r.kind === 'log' && r.action === 'webhook')).toHaveLength(2);
  });

  it('keeps refused notifies, marked when they only claimed this order', () => {
    const e = evidence({ log: [log('webhook', 'refused', T('09:30:00'), { bookingId: null, reason: 'signature_mismatch', httpStatus: 401 })] });
    expect(caseTimeline(e).find((r) => r.kind === 'log')).toMatchObject({ action: 'webhook', outcome: 'refused', reason: 'signature_mismatch', orderMatchOnly: true, ua: null });
  });

  it('labels a second capture "paid again" and a late decline for an earlier attempt "earlier attempt"', () => {
    const e = paidByCard();
    e.notices.push(notice('2', T('09:25:00'), { providerTxnId: '320048289999' }), notice('-2', T('09:30:00'), { providerTxnId: '0' }));
    const notes = caseTimeline(e).filter((r) => r.kind === 'notice').map((r) => r.kind === 'notice' && r.note);
    expect(notes).toEqual([null, null, 'paid_again', 'earlier_attempt']);
  });

  it('puts the log’s decline count on the one stored decline row', () => {
    const e = evidence({
      payments: [gateway({ status: 'failed' })],
      log: [log('webhook', 'failed', T('09:02:00')), log('webhook', 'failed', T('09:05:00')), log('webhook', 'failed', T('09:08:00'))],
      notices: [notice('-2', T('09:02:00'))],
    });
    expect(caseTimeline(e).find((r) => r.kind === 'notice')).toMatchObject({ code: '-2', repeats: 3 });
  });

  it('shows a manual payment as settled by hand, a cancellation, and each refund step', () => {
    const e = evidence({
      booking: { status: 'refunded', cancelledAt: T('13:30:00'), cancelledBy: 'o@x.com', cancellationReason: 'trip off' },
      payments: [manual()],
      refunds: [refund({ status: 'manual_confirmed', gatewayRef: 'BANK-9', confirmedBy: 'f@x.com', confirmedAt: T('14:00:00') })],
    });
    const rows = caseTimeline(e);
    expect(rows.find((r) => r.kind === 'payment_settled')).toMatchObject({ method: 'cash', settlementSource: 'manual', settledBy: 'f@x.com', reference: 'SLIP-7' });
    expect(rows.some((r) => r.kind === 'payment_created')).toBe(false);
    expect(rows.find((r) => r.kind === 'cancelled')).toMatchObject({ by: 'o@x.com', reason: 'trip off', paidOn: null });
    expect(rows.filter((r) => r.kind === 'refund').map((r) => r.kind === 'refund' && r.step)).toEqual(['requested', 'confirmed']);
  });
});
