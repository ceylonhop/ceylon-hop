import type { Booking, BookingRepo, BookingStatusEvent } from '../db/bookingRepo';
import type {
  CustomerCommunication,
  CustomerCommunicationEvent,
  CustomerCommunicationRepo,
  CustomerCommunicationReconciliationFinding,
} from '../db/customerCommunicationRepo';
import type { PaymentRepo } from '../db/paymentRepo';

export const TRACKING_HISTORY_AVAILABLE_SINCE = {
  bookingTransitions: '2026-09-26T00:00:00.000Z',
  customerCommunications: '2026-09-26T00:00:00.000Z',
} as const;

export type BookingTrackingSource =
  | 'booking_status_events'
  | 'customer_communications'
  | 'customer_communication_events'
  | 'payments';

export type BookingTrackingItem =
  | {
      id: string;
      at: string;
      source: 'booking_transition';
      fromStatus: string;
      toStatus: string;
      transitionSource: string;
      actorType: string;
    }
  | {
      id: string;
      at: string;
      source: 'communication';
      communicationId: string;
      communicationKind: string;
      eventType: string;
      recipient: string;
      communicationSource: string;
      actorType: string;
    };

export interface BookingTrackingResponse {
  items: BookingTrackingItem[];
  nextCursor: string | null;
  historyAvailableSince: typeof TRACKING_HISTORY_AVAILABLE_SINCE;
  partialHistory: boolean;
  unavailableSources: BookingTrackingSource[];
}

interface Cursor {
  at: string;
  rank: number;
  id: string;
}

const rank = (item: BookingTrackingItem): number => item.source === 'communication' ? 1 : 0;

function compareNewestFirst(a: BookingTrackingItem, b: BookingTrackingItem): number {
  const byTime = b.at.localeCompare(a.at);
  if (byTime) return byTime;
  const byRank = rank(b) - rank(a);
  if (byRank) return byRank;
  return b.id.localeCompare(a.id);
}

function cursorFor(item: BookingTrackingItem): string {
  return Buffer.from(JSON.stringify({ at: item.at, rank: rank(item), id: item.id } satisfies Cursor))
    .toString('base64url');
}

function parseCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (
      typeof parsed.at !== 'string' ||
      Number.isNaN(Date.parse(parsed.at)) ||
      (parsed.rank !== 0 && parsed.rank !== 1) ||
      typeof parsed.id !== 'string' ||
      !parsed.id
    ) return null;
    return { at: parsed.at, rank: parsed.rank, id: parsed.id };
  } catch {
    return null;
  }
}

export function isValidBookingTrackingCursor(value: string): boolean {
  return parseCursor(value) !== null;
}

function afterCursor(item: BookingTrackingItem, cursor: Cursor): boolean {
  if (item.at !== cursor.at) return item.at < cursor.at;
  const itemRank = rank(item);
  if (itemRank !== cursor.rank) return itemRank < cursor.rank;
  return item.id < cursor.id;
}

export function maskRecipient(value: string): string {
  const at = value.lastIndexOf('@');
  if (at < 1) return value.length ? `${value[0]}***` : '***';
  return `${value[0]}***${value.slice(at)}`;
}

function transitionItem(event: BookingStatusEvent): BookingTrackingItem {
  return {
    id: event.id,
    at: event.occurredAt,
    source: 'booking_transition',
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    transitionSource: event.source,
    actorType: event.actorType,
  };
}

function communicationItem(
  communication: CustomerCommunication,
  event: CustomerCommunicationEvent,
): BookingTrackingItem {
  return {
    id: event.id,
    at: event.occurredAt.toISOString(),
    source: 'communication',
    communicationId: communication.id,
    communicationKind: communication.kind,
    eventType: event.eventType,
    recipient: maskRecipient(communication.recipient),
    communicationSource: communication.source,
    actorType: communication.actorType,
  };
}

export async function loadBookingTracking(
  deps: {
    bookings: Pick<BookingRepo, 'listStatusEvents'>;
    communications?: Pick<CustomerCommunicationRepo, 'listByBookingId' | 'listEvents'>;
  },
  booking: Booking,
  page: { limit: number; cursor?: string },
): Promise<BookingTrackingResponse> {
  const unavailableSources: BookingTrackingSource[] = [];
  let transitionItems: BookingTrackingItem[] = [];
  try {
    transitionItems = (await deps.bookings.listStatusEvents(booking.id)).map(transitionItem);
  } catch (error) {
    console.error(`[ops] booking tracking: booking_status_events unavailable for ${booking.reference}:`, error);
    unavailableSources.push('booking_status_events');
  }

  const communicationItems: BookingTrackingItem[] = [];
  if (!deps.communications) {
    unavailableSources.push('customer_communications');
  } else {
    let communications: CustomerCommunication[] = [];
    try {
      communications = await deps.communications.listByBookingId(booking.id);
    } catch (error) {
      console.error(`[ops] booking tracking: customer_communications unavailable for ${booking.reference}:`, error);
      unavailableSources.push('customer_communications');
    }
    if (!unavailableSources.includes('customer_communications')) {
      try {
        const eventLists = await Promise.all(
          communications.map((communication) => deps.communications!.listEvents(communication.id)),
        );
        for (let i = 0; i < communications.length; i += 1) {
          for (const event of eventLists[i] ?? []) communicationItems.push(communicationItem(communications[i]!, event));
        }
      } catch (error) {
        console.error(`[ops] booking tracking: customer_communication_events unavailable for ${booking.reference}:`, error);
        unavailableSources.push('customer_communication_events');
      }
    }
  }

  const cursor = parseCursor(page.cursor);
  const all = [...transitionItems, ...communicationItems].sort(compareNewestFirst);
  const eligible = cursor ? all.filter((item) => afterCursor(item, cursor)) : all;
  const limit = Math.max(1, Math.min(100, page.limit));
  const items = eligible.slice(0, limit);
  return {
    items,
    nextCursor: eligible.length > limit && items.length ? cursorFor(items[items.length - 1]!) : null,
    historyAvailableSince: TRACKING_HISTORY_AVAILABLE_SINCE,
    partialHistory:
      Object.values(TRACKING_HISTORY_AVAILABLE_SINCE)
        .some((since) => Date.parse(booking.createdAt) < Date.parse(since)) ||
      unavailableSources.length > 0,
    unavailableSources,
  };
}

export type BookingTrackingFinding =
  | {
      kind: 'booking_status_mismatch';
      bookingId: string;
      currentStatus: string;
      eventStatus: string;
    }
  | {
      kind: 'captured_payment_missing_transition';
      bookingId: string;
      paymentId: string;
    }
  | CustomerCommunicationReconciliationFinding;

export async function reconcileBookingTracking(
  now: Date,
  deps: {
    bookings: Pick<
      BookingRepo,
      'list' | 'listStatusEventMismatches' | 'listStatusEventsForBookingIds'
    >;
    payments: Pick<PaymentRepo, 'findByBookingIds' | 'provenanceFor'>;
    communications?: Pick<CustomerCommunicationRepo, 'listReconciliationFindings'>;
  },
): Promise<{ findings: BookingTrackingFinding[]; unavailableSources: BookingTrackingSource[] }> {
  const findings: BookingTrackingFinding[] = [];
  const unavailableSources: BookingTrackingSource[] = [];
  try {
    findings.push(...await deps.bookings.listStatusEventMismatches().then((rows) => rows.map((row) => ({
      kind: 'booking_status_mismatch' as const,
      bookingId: row.bookingId,
      currentStatus: row.currentStatus,
      eventStatus: row.eventStatus,
    }))));
  } catch (error) {
    console.error('booking tracking reconciliation failed: booking_status_events', error);
    unavailableSources.push('booking_status_events');
  }

  let captured: Array<{ id: string; bookingId: string }> | null = null;
  try {
    const bookings = await deps.bookings.list();
    const payments = await deps.payments.findByBookingIds(bookings.map((booking) => booking.id));
    // A balance never moves the booking — the deposit did (spec 2026-10-07).
    const withEvidence = await Promise.all(payments.filter((payment) => payment.status === 'succeeded' && payment.purpose !== 'balance').map(async (payment) => ({
      payment,
      evidence: await deps.payments.provenanceFor(payment.id),
    })));
    // Rows captured before the ledger went live are deliberately not backfilled and therefore
    // cannot be called inconsistent. A missing settlement timestamp is legacy/unknown too.
    captured = withEvidence
      .filter(({ evidence }) => evidence?.settledAt && evidence.settledAt >= new Date(TRACKING_HISTORY_AVAILABLE_SINCE.bookingTransitions))
      .map(({ payment }) => ({ id: payment.id, bookingId: payment.bookingId }));
  } catch (error) {
    console.error('booking tracking reconciliation failed: payments', error);
    unavailableSources.push('payments');
  }
  if (captured) {
    try {
      const events = await deps.bookings.listStatusEventsForBookingIds(
        [...new Set(captured.map((payment) => payment.bookingId))],
      );
      for (const payment of captured) {
        const hasTransition = events.some((event) =>
          event.bookingId === payment.bookingId &&
          event.toStatus === 'paid' &&
          event.relatedEntityType === 'payment' &&
          event.relatedEntityId === payment.id,
        );
        if (!hasTransition) findings.push({
          kind: 'captured_payment_missing_transition',
          bookingId: payment.bookingId,
          paymentId: payment.id,
        });
      }
    } catch (error) {
      console.error('booking tracking reconciliation failed: captured payment transitions', error);
      if (!unavailableSources.includes('booking_status_events')) unavailableSources.push('booking_status_events');
    }
  }

  if (!deps.communications) {
    unavailableSources.push('customer_communications');
  } else {
    try {
      const staleBefore = new Date(now.getTime() - 60_000);
      findings.push(...await deps.communications.listReconciliationFindings(staleBefore));
    } catch (error) {
      console.error('booking tracking reconciliation failed: customer_communications', error);
      unavailableSources.push('customer_communications');
    }
  }

  return { findings, unavailableSources };
}
