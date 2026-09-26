import type { BookingCheckoutEvent } from '../db/bookingCheckoutEventRepo';
import type { PaymentEvent } from '../db/paymentEventRepo';
import type { Payment, PaymentProvenance } from '../db/paymentRepo';
import type { Refund } from '../db/refundRepo';

// ============================================================================
// The ops payment lookup's judgement (spec docs/superpowers/specs/2026-09-26-ops-payment-lookup-
// design.md §6-§8; the response contract is fixed in the matching plan). Pure: the evidence comes
// in, a verdict, a timeline and the gaps go out.
//
// The source rule: card money is judged from PayHere's own stored status code
// (payment_events.provider_status_code: 2 paid, 0 pending, -1 cancelled, -2 declined, -3
// chargeback) and the checkout log's timing — never from payments.status, which has been
// re-interpreted as bugs were fixed (#784, #792, #785), and never from booking.status.
// ============================================================================

// When the evidence starts. Before LOG_START there is no checkout log (promote #774, migration
// 0055); before DECLINES_START every PayHere decline after the first (2 Aug) was dropped as a
// duplicate (promote #793, migration 0056). Merge times of the promotes.
export const LOG_START = new Date('2026-09-24T19:18:10Z');
export const DECLINES_START = new Date('2026-09-26T04:06:53Z');

// services/duplicateBookings.ts DUPLICATE_CLOSED_BY; restated so the domain stays pure (the test
// pins the two together). Its reason reads `duplicate — paid on CH-…`.
export const DUPLICATE_CLOSE_ACTOR = 'system:duplicate-close';
const PAID_ON = /paid on (CH-[A-Z0-9]+)/;

export type CaseSource = 'payments' | 'payment_events' | 'booking_checkout_event' | 'refunds' | 'notification_log';
export type VerdictKind =
  | 'paid' | 'paid_by_hand' | 'declined' | 'reached_no_answer' | 'checkout_no_trace' | 'never_started'
  | 'paid_elsewhere' | 'paid_twice' | 'money_back';
export type WarningCode = 'money_on_unpaid_booking' | 'money_after_cancel' | 'paid_status_without_payment';
export type GapCode = 'no_checkout_log' | 'declines_may_be_missing' | 'no_gateway_report' | 'actor_not_recorded';

export interface Verdict {
  kind: VerdictKind;
  at: string | null;
  amount: number | null;
  currency: string | null;
  checkouts: number;
  declineNotices: number;
  countsComplete: boolean;
  payhere: { code: string; message: string | null; method: string | null; paymentId: string | null } | null;
  manual: { method: string; settledBy: string | null; reference: string | null } | null;
  paidOn: string | null;
  captures: Array<{ via: 'payhere' | 'manual'; id: string | null; method: string | null }> | null;
  refund: { state: 'requested' | 'processing' | 'confirmed' | 'failed'; refundedCents: number; capturedCents: number } | null;
  chargebackAt: string | null;
  cancellation: { by: string | null; reason: string | null } | null;
  warnings: WarningCode[];
}

export type CaseRow =
  | { at: string; source: 'bookings'; kind: 'created' }
  | { at: string; source: 'bookings'; kind: 'cancelled'; by: string | null; reason: string | null; paidOn: string | null }
  | {
      at: string; source: 'booking_checkout_event'; kind: 'log'; action: string; outcome: string; reason: string | null;
      httpStatus: number | null; attempt: number | null; ua: string | null; client: boolean; orderMatchOnly: boolean;
    }
  | { at: string; source: 'payments'; kind: 'payment_created'; orderId: string; amount: number; currency: string }
  | {
      at: string; source: 'payments'; kind: 'payment_settled'; orderId: string; amount: number; currency: string;
      method: string; settlementSource: 'manual' | 'legacy_backfill'; settledBy: string | null; reference: string | null;
    }
  | {
      at: string; source: 'payment_events'; kind: 'notice'; code: string; message: string | null; method: string | null;
      paymentId: string; amount: number; currency: string; note: 'paid_again' | 'earlier_attempt' | null; repeats: number | null;
    }
  | { at: string; source: 'notification_log'; kind: 'email'; emailKind: string; deliveryTracked: boolean }
  | {
      at: string; source: 'refunds'; kind: 'refund'; step: 'requested' | 'sent' | 'confirmed' | 'failed' | 'cancelled';
      amount: number; currency: string; by: string | null; ref: string | null; message: string | null; reason: string | null;
    };

export type CasePayment = Payment & PaymentProvenance;

export interface CaseEvidence {
  booking: {
    id: string; reference: string; status: string; createdAt: Date;
    cancelledAt: Date | null; cancelledBy: string | null; cancellationReason: string | null;
  };
  payments: CasePayment[];
  notices: PaymentEvent[];
  log: BookingCheckoutEvent[]; // by booking id ∪ by order id, deduped by id
  refunds: Refund[];
  emails: Array<{ kind: string; sentAt: Date }>;
  unavailable: CaseSource[];
}

const CASE_REF = /^(CH|Q)-[A-Z0-9]{3,12}$/;

// A pasted ref, as the lookup box receives it. Manual payments use `<ref>-MANUAL` as their order id.
export function normaliseCaseRef(raw: string): { kind: 'booking' | 'quote'; ref: string } | null {
  let ref = String(raw ?? '').trim().toUpperCase();
  if (ref.endsWith('-MANUAL')) ref = ref.slice(0, -'-MANUAL'.length);
  if (!CASE_REF.test(ref)) return null;
  return { kind: ref.startsWith('Q-') ? 'quote' : 'booking', ref };
}

const ms = (d: Date) => d.getTime();
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const byAt = (a: { at: Date }, b: { at: Date }) => ms(a.at) - ms(b.at);
const PAID_STATUSES = new Set(['paid', 'confirmed', 'in_progress', 'completed', 'no_show', 'refunded']);
const CONFIRMED_REFUND = new Set(['manual_confirmed', 'api_confirmed']);
const WEBHOOK_ANSWERS = new Set(['settled', 'failed', 'dismissed', 'pending']);

// Whether money arrived by hand is the row's own provenance, never its provider name
// (domain/paymentMethod.ts says why).
const isManual = (p: CasePayment) => p.settlementSource === 'manual';

interface Money {
  gateway: CasePayment | null;
  manual: CasePayment | null;
  gwNotices: PaymentEvent[]; // oldest first
  successes: PaymentEvent[];
  successIds: string[];
  cardPaid: boolean;
  cardPaidAt: Date | null;
  manualPaid: boolean;
  manualPaidAt: Date | null;
  chargeback: PaymentEvent | null;
}

function moneyOf(e: CaseEvidence): Money {
  const gateway = e.payments.find((p) => !isManual(p)) ?? null;
  const manual = e.payments.find(isManual) ?? null;
  const gwNotices = gateway
    ? e.notices.filter((n) => n.paymentId === gateway.id).sort((a, b) => ms(a.receivedAt) - ms(b.receivedAt))
    : [];
  const successes = gwNotices.filter((n) => codeOf(n) === '2');
  // Settled before notices were stored: the row itself is the only evidence there is.
  const legacy = !!gateway && gateway.status === 'succeeded' && gateway.settlementSource === 'legacy_backfill';
  const manualPaid = !!manual && manual.status === 'succeeded';
  return {
    gateway,
    manual,
    gwNotices,
    successes,
    successIds: [...new Set(successes.map((n) => n.providerTxnId))],
    cardPaid: successes.length > 0 || legacy,
    cardPaidAt: successes[0]?.receivedAt ?? (legacy ? gateway.settledAt : null),
    manualPaid,
    manualPaidAt: manualPaid ? manual.settledAt : null,
    chargeback: gwNotices.find((n) => codeOf(n) === '-3') ?? null,
  };
}

// PayHere's own status code. The fake gateway (tests, local dev) stores its status word in that
// column instead, so its events read as the PayHere code their parsed status stands for.
const CODE_FOR_STATUS: Record<string, string> = { succeeded: '2', pending: '0', cancelled: '-1', failed: '-2', charged_back: '-3' };
const codeOf = (n: PaymentEvent): string =>
  n.provider === 'payhere' ? n.providerStatusCode : (CODE_FOR_STATUS[n.normalizedStatus] ?? n.providerStatusCode);

const payhereOf = (n: PaymentEvent) => ({
  code: codeOf(n),
  message: n.sanitizedPayload.status_message ?? null,
  method: n.sanitizedPayload.method ?? null,
  paymentId: n.providerTxnId,
});

function isCancelled(b: CaseEvidence['booking']): boolean {
  return b.status === 'cancelled' || b.cancelledAt !== null;
}

function refundOf(e: CaseEvidence, m: Money): Verdict['refund'] {
  const live = e.refunds.filter((r) => r.status !== 'cancelled');
  if (!live.length) return null;
  const state = live.some((r) => r.status === 'api_processing') ? 'processing'
    : live.some((r) => r.status === 'manual_pending') ? 'requested'
      : live.some((r) => CONFIRMED_REFUND.has(r.status)) ? 'confirmed'
        : 'failed';
  return {
    state,
    refundedCents: live.filter((r) => CONFIRMED_REFUND.has(r.status)).reduce((s, r) => s + r.amountCents, 0),
    capturedCents: (m.cardPaid && m.gateway ? m.gateway.amount : 0) + (m.manualPaid && m.manual ? m.manual.amount : 0),
  };
}

function warningsOf(e: CaseEvidence, m: Money): WarningCode[] {
  const moneyIn = m.cardPaid || m.manualPaid;
  const captures = [m.cardPaidAt, m.manualPaidAt].filter((d): d is Date => d !== null);
  const firstCapture = captures.length ? new Date(Math.min(...captures.map(ms))) : null;
  const w: WarningCode[] = [];
  const { status, cancelledAt } = e.booking;
  if (moneyIn && (status === 'draft' || status === 'payment_pending')) w.push('money_on_unpaid_booking');
  if (moneyIn && cancelledAt && firstCapture && ms(firstCapture) > ms(cancelledAt)) w.push('money_after_cancel');
  if (!moneyIn && PAID_STATUSES.has(status)) w.push('paid_status_without_payment');
  return w;
}

export function paymentVerdict(e: CaseEvidence): Verdict | null {
  if (e.unavailable.length) return null;
  const m = moneyOf(e);
  const log = [...e.log].sort(byAt);
  const checkouts = log.filter((r) => r.action === 'checkout' && r.outcome === 'succeeded');
  // A decline notice is a failed webhook with no reason: charged_back and stale_attempt carry one.
  const declines = log.filter((r) => r.action === 'webhook' && r.outcome === 'failed' && !r.reason);
  const b = e.booking;
  const base: Verdict = {
    kind: 'never_started',
    at: null,
    amount: m.gateway?.amount ?? m.manual?.amount ?? null,
    currency: m.gateway?.currency ?? m.manual?.currency ?? null,
    checkouts: checkouts.length,
    declineNotices: declines.length,
    countsComplete: ms(b.createdAt) >= ms(LOG_START),
    payhere: null,
    manual: null,
    paidOn: null,
    captures: null,
    refund: refundOf(e, m),
    chargebackAt: iso(m.chargeback?.receivedAt),
    cancellation: isCancelled(b) && b.cancelledBy !== DUPLICATE_CLOSE_ACTOR ? { by: b.cancelledBy, reason: b.cancellationReason } : null,
    warnings: warningsOf(e, m),
  };

  if (m.successIds.length >= 2 || (m.cardPaid && m.manualPaid)) {
    const captures: NonNullable<Verdict['captures']> = m.successIds.map((id) => ({
      via: 'payhere' as const, id, method: m.successes.find((n) => n.providerTxnId === id)?.sanitizedPayload.method ?? null,
    }));
    if (m.cardPaid && !m.successIds.length) captures.push({ via: 'payhere', id: m.gateway?.gatewayPaymentId ?? null, method: null });
    if (m.manualPaid) captures.push({ via: 'manual', id: m.manual?.gatewayPaymentId ?? null, method: m.manual?.provider ?? null });
    const times = [m.cardPaidAt, m.manualPaidAt].filter((d): d is Date => d !== null);
    return { ...base, kind: 'paid_twice', at: times.length ? iso(new Date(Math.min(...times.map(ms)))) : null, captures };
  }
  if (m.chargeback || base.refund) {
    return { ...base, kind: 'money_back', at: iso(m.chargeback?.receivedAt ?? m.cardPaidAt ?? m.manualPaidAt) };
  }
  if (m.cardPaid) {
    const at = m.cardPaidAt;
    const before = (d: Date) => at === null || ms(d) < ms(at);
    const first = m.successes[0];
    return {
      ...base,
      kind: 'paid',
      at: iso(at),
      checkouts: checkouts.filter((r) => before(r.at)).length,
      declineNotices: declines.filter((r) => before(r.at)).length,
      payhere: first ? payhereOf(first) : { code: '2', message: null, method: null, paymentId: m.gateway?.gatewayPaymentId ?? null },
    };
  }
  if (m.manualPaid && m.manual) {
    return {
      ...base,
      kind: 'paid_by_hand',
      at: iso(m.manualPaidAt),
      manual: { method: m.manual.provider, settledBy: m.manual.settledBy, reference: m.manual.gatewayPaymentId },
    };
  }
  if (b.cancelledBy === DUPLICATE_CLOSE_ACTOR) {
    return { ...base, kind: 'paid_elsewhere', at: iso(b.cancelledAt), paidOn: PAID_ON.exec(b.cancellationReason ?? '')?.[1] ?? null };
  }

  // Unpaid: judged against the latest checkout. Each repeated decline is logged, while its stored
  // notice may be collapsed into an earlier one (PayHere sends payment id "0" on every decline),
  // so the log carries the timing and the notices carry PayHere's words.
  const lastCheckout = checkouts.at(-1)?.at ?? null;
  const after = (d: Date) => lastCheckout === null || ms(d) > ms(lastCheckout);
  const LOG_CODE: Record<string, string> = { failed: '-2', dismissed: '-1', pending: '0' };
  const answers = [
    ...log
      .filter((r) => r.action === 'webhook' && after(r.at) && !r.reason && LOG_CODE[r.outcome])
      .map((r) => ({ at: r.at, code: LOG_CODE[r.outcome] })),
    ...m.gwNotices.filter((n) => after(n.receivedAt) && codeOf(n) !== '2').map((n) => ({ at: n.receivedAt, code: codeOf(n) })),
  ].sort(byAt);
  const last = answers.at(-1);
  if (last && (last.code === '-2' || last.code === '-1')) {
    const stored = [...m.gwNotices].reverse().find((n) => codeOf(n) === last.code);
    return {
      ...base,
      kind: 'declined',
      at: iso(last.at),
      payhere: stored ? payhereOf(stored) : { code: last.code, message: null, method: null, paymentId: null },
    };
  }
  const reachedAt = [
    ...log.filter((r) => after(r.at) && ((r.action === 'gateway' && r.outcome === 'opened') || r.action === 'return')).map((r) => r.at),
    ...(last && last.code === '0' ? [last.at] : []),
  ].sort((x, y) => ms(x) - ms(y));
  if (reachedAt.length) return { ...base, kind: 'reached_no_answer', at: iso(reachedAt[0]) };
  if (m.gateway || lastCheckout) {
    return { ...base, kind: 'checkout_no_trace', at: iso(lastCheckout ?? m.gateway?.createdAt ?? null) };
  }
  return { ...base, kind: 'never_started', at: iso(b.createdAt) };
}

export function caseGaps(e: CaseEvidence, verdict: Verdict | null): GapCode[] {
  const gaps: GapCode[] = [];
  if (ms(e.booking.createdAt) < ms(LOG_START)) gaps.push('no_checkout_log');
  if (ms(e.booking.createdAt) < ms(DECLINES_START)) gaps.push('declines_may_be_missing');
  if (verdict?.kind === 'checkout_no_trace') gaps.push('no_gateway_report');
  if (isCancelled(e.booking) && !e.booking.cancelledBy) gaps.push('actor_not_recorded');
  return gaps;
}

export function caseTimeline(e: CaseEvidence): CaseRow[] {
  const rows: Array<{ t: number; row: CaseRow }> = [];
  const push = (d: Date, row: CaseRow) => rows.push({ t: ms(d), row });
  const b = e.booking;
  const m = moneyOf(e);

  // Once: the log's own create row says the same thing and carries the device. Pay-link and
  // ops-made bookings log no create, so the booking's timestamp stands in for them.
  if (!e.log.some((r) => r.action === 'create' && r.outcome === 'succeeded' && r.bookingId === b.id)) {
    push(b.createdAt, { at: b.createdAt.toISOString(), source: 'bookings', kind: 'created' });
  }
  if (b.cancelledAt) {
    const auto = b.cancelledBy === DUPLICATE_CLOSE_ACTOR;
    push(b.cancelledAt, {
      at: b.cancelledAt.toISOString(), source: 'bookings', kind: 'cancelled', by: b.cancelledBy, reason: b.cancellationReason,
      paidOn: auto ? PAID_ON.exec(b.cancellationReason ?? '')?.[1] ?? null : null,
    });
  }

  // PayHere's answers are shown from payment_events, which carries their words; the webhook log
  // rows for the same notices come back only when those could not be loaded.
  const noticesMissing = e.unavailable.includes('payment_events');
  for (const r of e.log) {
    if (r.action === 'webhook' && WEBHOOK_ANSWERS.has(r.outcome) && !noticesMissing) continue;
    push(r.at, {
      at: r.at.toISOString(), source: 'booking_checkout_event', kind: 'log', action: r.action, outcome: r.outcome,
      reason: r.reason, httpStatus: r.httpStatus, attempt: r.attempt,
      // The customer's device on every row their browser caused; a webhook's is PayHere's server.
      ua: r.action === 'webhook' ? null : r.ua,
      client: r.source === 'client',
      // A rejected notify's order id is untrusted: it only claims to be for this booking.
      orderMatchOnly: r.bookingId !== b.id,
    });
  }

  for (const p of e.payments) {
    if (!isManual(p) && p.createdAt) {
      push(p.createdAt, { at: p.createdAt.toISOString(), source: 'payments', kind: 'payment_created', orderId: p.orderId, amount: p.amount, currency: p.currency });
    }
    if (p.status === 'succeeded' && p.settledAt && (p.settlementSource === 'manual' || p.settlementSource === 'legacy_backfill')) {
      push(p.settledAt, {
        at: p.settledAt.toISOString(), source: 'payments', kind: 'payment_settled', orderId: p.orderId, amount: p.amount,
        currency: p.currency, method: p.provider, settlementSource: p.settlementSource, settledBy: p.settledBy,
        reference: p.settlementSource === 'manual' ? p.gatewayPaymentId : null,
      });
    }
  }

  const firstSuccess = m.successes[0] ?? null;
  const loggedDeclines = e.log.filter((r) => r.action === 'webhook' && r.outcome === 'failed' && !r.reason).length;
  const storedDeclines = e.notices.filter((n) => codeOf(n) === '-2').length;
  for (const n of [...e.notices].sort((a, x) => ms(a.receivedAt) - ms(x.receivedAt))) {
    const code = codeOf(n);
    let note: 'paid_again' | 'earlier_attempt' | null = null;
    if (firstSuccess && n.providerTxnId !== firstSuccess.providerTxnId) {
      if (code === '2') note = 'paid_again';
      else if (code !== '-3' && ms(n.receivedAt) > ms(firstSuccess.receivedAt)) note = 'earlier_attempt';
    }
    push(n.receivedAt, {
      at: n.receivedAt.toISOString(), source: 'payment_events', kind: 'notice', code,
      message: n.sanitizedPayload.status_message ?? null, method: n.sanitizedPayload.method ?? null,
      paymentId: n.providerTxnId, amount: n.amount, currency: n.currency, note,
      repeats: code === '-2' && storedDeclines === 1 && loggedDeclines > 1 ? loggedDeclines : null,
    });
  }

  for (const em of e.emails) {
    // These two rows are written whether or not the send worked (webhooks.ts).
    push(em.sentAt, {
      at: em.sentAt.toISOString(), source: 'notification_log', kind: 'email', emailKind: em.kind,
      deliveryTracked: em.kind !== 'payment_failed' && em.kind !== 'deposit_received',
    });
  }

  for (const r of e.refunds) {
    const base = { source: 'refunds' as const, kind: 'refund' as const, amount: r.amountCents, currency: r.currency };
    push(r.requestedAt, { ...base, at: r.requestedAt.toISOString(), step: 'requested', by: r.requestedBy, ref: null, message: null, reason: r.reason });
    if (r.apiAttemptedAt) push(r.apiAttemptedAt, { ...base, at: r.apiAttemptedAt.toISOString(), step: 'sent', by: null, ref: null, message: null, reason: null });
    if (r.confirmedAt) push(r.confirmedAt, { ...base, at: r.confirmedAt.toISOString(), step: 'confirmed', by: r.confirmedBy, ref: r.gatewayRef, message: r.providerMessage, reason: null });
    if (r.status === 'api_failed') push(r.updatedAt, { ...base, at: r.updatedAt.toISOString(), step: 'failed', by: null, ref: null, message: r.providerMessage, reason: null });
    if (r.status === 'cancelled') push(r.updatedAt, { ...base, at: r.updatedAt.toISOString(), step: 'cancelled', by: null, ref: null, message: null, reason: null });
  }

  // Stable: rows at the same instant keep the order they were gathered in.
  return rows.sort((a, x) => a.t - x.t).map((r) => r.row);
}
