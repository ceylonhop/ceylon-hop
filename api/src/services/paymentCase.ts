import type { Booking, BookingRepo } from '../db/bookingRepo';
import type { QuoteRepo } from '../db/quoteRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { PaymentEvent, PaymentEventRepo } from '../db/paymentEventRepo';
import type { BookingCheckoutEvent, BookingCheckoutEventRepo } from '../db/bookingCheckoutEventRepo';
import type { Refund, RefundRepo } from '../db/refundRepo';
import type { NotificationLogRepo } from '../db/notificationLogRepo';
import type { BillingInput } from '../domain/singleTransfer';
import { toOpsRow } from './opsView';
import {
  caseGaps, caseTimeline, normaliseCaseRef, paymentVerdict,
  type CaseEvidence, type CasePayment, type CaseRow, type CaseSource, type GapCode, type Verdict,
} from '../domain/paymentCase';

// Loads one booking's payment evidence for the ops payment lookup (spec 2026-09-26) and hands it to
// the pure judgement in domain/paymentCase. Read-only. Each source loads on its own: one that fails
// (or is not wired) is named in `unavailable` and the verdict is withheld — the page says
// "incomplete" rather than drawing a confident answer from part of the evidence.

export interface PaymentCaseDeps {
  bookings: Pick<BookingRepo, 'get' | 'findByReference'>;
  payments: Pick<PaymentRepo, 'findByBookingId' | 'provenanceFor'>;
  paymentEvents?: Pick<PaymentEventRepo, 'listForReconciliation'>;
  checkoutEvents?: Pick<BookingCheckoutEventRepo, 'listByBookingId' | 'listByOrderId'>;
  refunds?: Pick<RefundRepo, 'list'>;
  notificationLog?: Pick<NotificationLogRepo, 'listByBookingId'>;
  quotes?: Pick<QuoteRepo, 'findByReference' | 'findByConvertedBookingId'>;
  teamEmails?: ReadonlySet<string>;
  // Whether the ops queue lists a booking in this status (routes/ops.ts QUEUE_STATUSES).
  inQueue?: (status: string) => boolean;
}

export interface CaseBooking {
  id: string;
  reference: string;
  status: string;
  mode: string;
  channel: 'website' | 'whatsapp';
  createdAt: string;
  route: string;
  travelDate: string | null;
  travelTime: string | null;
  pax: number;
  total: number;
  amountDueNow: number | null;
  currency: string;
  customer: { firstName: string; lastName: string; email: string; whatsapp: string; country: string };
  billing: BillingInput | null;
  termsAcceptedAt: string | null;
  cancellation: { reason: string | null; by: string | null; at: string | null } | null;
  isTest: boolean;
  inQueue: boolean;
}

export interface CaseResponse {
  ref: string;
  quote: { id: string; reference: string; status: string } | null;
  booking: CaseBooking | null;
  verdict: Verdict | null;
  timeline: CaseRow[];
  gaps: GapCode[];
  unavailable: CaseSource[];
}

export type PaymentCaseResult = { kind: 'bad_ref' } | { kind: 'not_found' } | { kind: 'found'; body: CaseResponse };

export async function loadPaymentCase(deps: PaymentCaseDeps, rawRef: string): Promise<PaymentCaseResult> {
  const parsed = normaliseCaseRef(rawRef);
  if (!parsed) return { kind: 'bad_ref' };

  let quote: CaseResponse['quote'] = null;
  let booking: Booking | null;
  if (parsed.kind === 'quote') {
    const q = deps.quotes ? await deps.quotes.findByReference(parsed.ref) : null;
    if (!q) return { kind: 'not_found' };
    quote = { id: q.id, reference: q.reference, status: q.status };
    booking = q.convertedBookingId ? await deps.bookings.get(q.convertedBookingId) : null;
    if (!booking) {
      return { kind: 'found', body: { ref: parsed.ref, quote, booking: null, verdict: null, timeline: [], gaps: [], unavailable: [] } };
    }
  } else {
    booking = await deps.bookings.findByReference(parsed.ref);
    if (!booking) return { kind: 'not_found' };
  }
  const b = booking;

  const unavailable: CaseSource[] = [];
  const load = async <T>(source: CaseSource, fn: (() => Promise<T>) | null, fallback: T): Promise<T> => {
    if (!fn) {
      unavailable.push(source);
      return fallback;
    }
    try {
      return await fn();
    } catch (err) {
      console.error(`[ops] payment lookup: ${source} unavailable for ${b.reference}:`, err);
      unavailable.push(source);
      return fallback;
    }
  };

  const { paymentEvents, checkoutEvents, refunds, notificationLog } = deps;
  const [paid, log, refundRows, emails, fromQuote] = await Promise.all([
    // Payments, then each row's provenance and PayHere notices. The notices hang off the rows, so
    // if the rows cannot be read the notices cannot either.
    load('payments', async () => {
      const rows = await deps.payments.findByBookingId(b.id);
      return Promise.all(rows.map(async (p): Promise<CasePayment> => {
        const prov = await deps.payments.provenanceFor(p.id);
        return { ...p, createdAt: null, settledAt: null, settlementSource: null, settledBy: null, gatewayPaymentId: null, ...prov };
      }));
    }, null as CasePayment[] | null),
    load('booking_checkout_event', checkoutEvents ? async () => {
      const [byBooking, byOrder] = await Promise.all([
        checkoutEvents.listByBookingId(b.id),
        checkoutEvents.listByOrderId ? checkoutEvents.listByOrderId(b.reference) : Promise.resolve([] as BookingCheckoutEvent[]),
      ]);
      const seen = new Set(byBooking.map((r) => r.id));
      return [...byBooking, ...byOrder.filter((r) => !seen.has(r.id))];
    } : null, [] as BookingCheckoutEvent[]),
    load('refunds', refunds ? () => refunds.list(b.id) : null, [] as Refund[]),
    load('notification_log', notificationLog ? () => notificationLog.listByBookingId(b.id) : null, [] as Array<{ kind: string; sentAt: Date }>),
    quote || !deps.quotes ? Promise.resolve(null) : deps.quotes.findByConvertedBookingId(b.id).catch(() => null),
  ]);
  if (fromQuote) quote = { id: fromQuote.id, reference: fromQuote.reference, status: fromQuote.status };

  let notices: PaymentEvent[] = [];
  if (paid === null) unavailable.push('payment_events');
  else {
    notices = await load(
      'payment_events',
      paymentEvents ? async () => (await Promise.all(paid.map((p) => paymentEvents.listForReconciliation(p.id)))).flat() : null,
      [] as PaymentEvent[],
    );
  }

  const cancelled = b.status === 'cancelled' || !!b.cancelledAt;
  const evidence: CaseEvidence = {
    booking: {
      id: b.id, reference: b.reference, status: b.status, createdAt: new Date(b.createdAt),
      cancelledAt: b.cancelledAt ? new Date(b.cancelledAt) : null,
      cancelledBy: b.cancelledBy ?? null, cancellationReason: b.cancellationReason ?? null,
    },
    payments: paid ?? [],
    notices,
    log,
    refunds: refundRows,
    emails,
    unavailable,
  };
  const verdict = paymentVerdict(evidence);

  const row = toOpsRow(b, { paid: (paid ?? []).some((p) => p.status === 'succeeded'), teamEmails: deps.teamEmails });
  const c = b.input.customer;
  return {
    kind: 'found',
    body: {
      ref: parsed.ref,
      quote,
      booking: {
        id: b.id, reference: b.reference, status: b.status, mode: b.mode, channel: b.channel, createdAt: b.createdAt,
        route: row.route, travelDate: row.travelDate, travelTime: row.travelTime, pax: row.pax,
        total: b.total, amountDueNow: b.amountDueNow ?? null, currency: b.currency,
        customer: { firstName: c.firstName, lastName: c.lastName ?? '', email: c.email, whatsapp: c.whatsapp, country: c.country },
        billing: b.billing ?? null,
        termsAcceptedAt: b.termsAcceptedAt ?? null,
        cancellation: cancelled ? { reason: b.cancellationReason ?? null, by: b.cancelledBy ?? null, at: b.cancelledAt ?? null } : null,
        isTest: row.isTest,
        inQueue: deps.inQueue ? deps.inQueue(b.status) : false,
      },
      verdict,
      timeline: caseTimeline(evidence),
      gaps: caseGaps(evidence, verdict),
      unavailable,
    },
  };
}
