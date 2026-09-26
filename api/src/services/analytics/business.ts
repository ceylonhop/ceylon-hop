import type { AnalyticsRange, CurrencyMap, Delta, Snapshot } from './funnel';
import { colomboBucketKey, nextBucketKey } from './time';

export interface AnalyticsBookingRow {
  id: string;
  reference: string;
  channel: string;
  mode: string;
  status: string;
  totalCents: number;
  amountDueNowCents: number;
  currency: string;
  createdAt: Date;
  travelDate: string | null;
  fulfilmentStatus: string | null;
}

export interface AnalyticsPaymentRow {
  id: string;
  bookingId: string;
  status: 'pending' | 'succeeded' | 'failed';
  amountCents: number;
  currency: string;
  createdAt: Date;
  settledAt: Date | null;
  attemptCount: number;
  lastAttemptAt: Date | null;
}

export interface AnalyticsRefundRow {
  bookingId: string;
  amountCents: number;
  currency: string;
  confirmedAt: Date;
}

export interface AnalyticsCheckoutEventRow {
  bookingId: string | null;
  at: Date;
  action: string;
  outcome: string;
}

export interface AnalyticsRideMemberRow {
  seats: number;
  status: string;
}

export interface AnalyticsRideListRow {
  id: string;
  code: string;
  from: string;
  to: string;
  status: string;
  date: string;
  cutoffAt: Date;
  minSeats: number;
  capacity: number;
  seatPriceCents: number;
  createdAt: Date;
  members: AnalyticsRideMemberRow[];
}

export interface AnalyticsExcludedCounts {
  teamBookings: number;
  teamQuoteContacts: number;
  seedRideLists: number;
  teamRideMembers: number;
}

export interface BusinessAnalyticsData {
  bookings: AnalyticsBookingRow[];
  payments: AnalyticsPaymentRow[];
  refunds: AnalyticsRefundRow[];
  checkoutEvents: AnalyticsCheckoutEventRow[];
  rideLists: AnalyticsRideListRow[];
  excluded: AnalyticsExcludedCounts;
  truncated: boolean;
}

export interface PaymentFunnel {
  started: number;
  gatewayOpened: number;
  paid: number;
  failed: number;
  dismissed: number;
  abandoned: number;
  successRatePct: number | null;
}

export interface OperationsAttention {
  kind: 'payment' | 'fulfilment';
  bookingId: string;
  reference: string;
  travelDate: string | null;
  label: string;
  amountCents: number;
  currency: string;
}

export interface BusinessAnalyticsReport {
  range: { from: string; to: string; bucket: 'day' | 'week' };
  updatedAt: string;
  tiles: {
    paidBookings: Delta;
    grossCollected: CurrencyMap;
    refunded: CurrencyMap;
    netCollected: CurrencyMap;
    paymentSuccessPct: { value: number | null; prev: number | null };
    revenueAtRisk: Snapshot;
    upcomingNeedsAttention: number;
  };
  paymentFunnel: PaymentFunnel;
  series: Array<{ bucketStart: string; paidBookings: number; netCollectedCents: CurrencyMap }>;
  operations: {
    upcoming7: number;
    upcoming28: number;
    needsAttention: OperationsAttention[];
    rideBoard: {
      activeLists: number;
      confirmedLists: number;
      gatheringLists: number;
      committedSeats: number;
      seatsNeeded: number;
    };
  };
  excluded: AnalyticsExcludedCounts;
  truncated: boolean;
}

const DAY_MS = 86_400_000;
const inRange = (at: Date | null, from: Date, to: Date): boolean =>
  !!at && at.getTime() >= from.getTime() && at.getTime() <= to.getTime();
const add = (map: CurrencyMap, currency: string, cents: number): void => {
  map[currency] = (map[currency] ?? 0) + cents;
};

function paymentFunnel(
  data: BusinessAnalyticsData,
  from: Date,
  to: Date,
): PaymentFunnel {
  const websiteBookingIds = new Set(
    data.bookings.filter((b) => b.channel === 'website').map((b) => b.id),
  );
  const started = new Set(
    data.checkoutEvents
      .filter((e) => e.bookingId && websiteBookingIds.has(e.bookingId) && e.action === 'checkout' && e.outcome === 'succeeded' && inRange(e.at, from, to))
      .map((e) => e.bookingId as string),
  );
  const hasEvent = (id: string, action: string, outcomes: string[]) =>
    data.checkoutEvents.some((e) => e.bookingId === id && e.action === action && outcomes.includes(e.outcome));
  const hasPaid = (id: string) => data.payments.some((p) => p.bookingId === id && p.status === 'succeeded');
  let gatewayOpened = 0, paid = 0, failed = 0, dismissed = 0, abandoned = 0;
  for (const id of started) {
    if (hasEvent(id, 'gateway', ['opened'])) gatewayOpened += 1;
    if (hasPaid(id) || hasEvent(id, 'webhook', ['settled'])) paid += 1;
    else if (hasEvent(id, 'webhook', ['failed'])) failed += 1;
    else if (hasEvent(id, 'webhook', ['dismissed']) || hasEvent(id, 'gateway', ['dismissed'])) dismissed += 1;
    else abandoned += 1;
  }
  return {
    started: started.size,
    gatewayOpened,
    paid,
    failed,
    dismissed,
    abandoned,
    successRatePct: started.size ? Math.round((paid / started.size) * 100) : null,
  };
}

function dateOnlyAtColombo(d: Date): string {
  return new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function computeBusinessAnalytics(data: BusinessAnalyticsData, q: AnalyticsRange): BusinessAnalyticsReport {
  const { from, to, now, bucket } = q;
  const windowMs = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - windowMs - 1);
  const prevTo = new Date(from.getTime() - 1);
  const currentSettled = data.payments.filter((p) => p.status === 'succeeded' && inRange(p.settledAt, from, to));
  const previousSettled = data.payments.filter((p) => p.status === 'succeeded' && inRange(p.settledAt, prevFrom, prevTo));
  const currentRefunds = data.refunds.filter((r) => inRange(r.confirmedAt, from, to));

  const grossCollected: CurrencyMap = {};
  const refunded: CurrencyMap = {};
  const netCollected: CurrencyMap = {};
  currentSettled.forEach((p) => add(grossCollected, p.currency, p.amountCents));
  currentRefunds.forEach((r) => add(refunded, r.currency, r.amountCents));
  for (const currency of new Set([...Object.keys(grossCollected), ...Object.keys(refunded)])) {
    netCollected[currency] = (grossCollected[currency] ?? 0) - (refunded[currency] ?? 0);
  }

  const currentFunnel = paymentFunnel(data, from, to);
  const previousFunnel = paymentFunnel(data, prevFrom, prevTo);
  const revenueAtRisk: Snapshot = { count: 0, valueCents: {} };
  for (const p of data.payments) {
    const booking = data.bookings.find((b) => b.id === p.bookingId);
    if (p.status !== 'pending' || booking?.status !== 'payment_pending') continue;
    revenueAtRisk.count += 1;
    add(revenueAtRisk.valueCents, p.currency, p.amountCents);
  }

  const today = dateOnlyAtColombo(now);
  const inDays = (date: string | null, days: number) => !!date && date >= today && date <= addDays(today, days);
  const upcoming7 = data.bookings.filter((b) => inDays(b.travelDate, 7));
  const needsAttention: OperationsAttention[] = [];
  for (const b of upcoming7) {
    if (b.status === 'draft' || b.status === 'payment_pending') {
      needsAttention.push({
        kind: 'payment', bookingId: b.id, reference: b.reference, travelDate: b.travelDate,
        label: 'Payment outstanding', amountCents: b.amountDueNowCents, currency: b.currency,
      });
    } else if (b.status === 'paid' && (!b.fulfilmentStatus || b.fulfilmentStatus === 'paid')) {
      needsAttention.push({
        kind: 'fulfilment', bookingId: b.id, reference: b.reference, travelDate: b.travelDate,
        label: 'Vehicle not confirmed', amountCents: b.totalCents, currency: b.currency,
      });
    }
  }
  needsAttention.sort((a, b) => (a.travelDate ?? '').localeCompare(b.travelDate ?? '') || a.reference.localeCompare(b.reference));

  const activeRideLists = data.rideLists.filter((l) =>
    (l.status === 'gathering' || l.status === 'confirmed') && l.date >= today,
  );
  let committedSeats = 0, seatsNeeded = 0;
  for (const list of activeRideLists) {
    const seats = list.members
      .filter((m) => m.status === 'held' || m.status === 'charged')
      .reduce((sum, m) => sum + m.seats, 0);
    committedSeats += seats;
    if (list.status === 'gathering') seatsNeeded += Math.max(0, list.minSeats - seats);
  }

  const seriesMap = new Map<string, { bucketStart: string; paidBookings: number; netCollectedCents: CurrencyMap }>();
  const endKey = colomboBucketKey(to, bucket);
  for (let key = colomboBucketKey(from, bucket); ; key = nextBucketKey(key, bucket)) {
    seriesMap.set(key, { bucketStart: key, paidBookings: 0, netCollectedCents: {} });
    if (key >= endKey) break;
  }
  for (const p of currentSettled) {
    const entry = p.settledAt ? seriesMap.get(colomboBucketKey(p.settledAt, bucket)) : null;
    if (!entry) continue;
    add(entry.netCollectedCents, p.currency, p.amountCents);
  }
  // A booking can settle a deposit and its balance separately. Count that as one paid
  // booking in the chart (matching the headline), anchored to its first settlement here.
  const firstSettlementByBooking = new Map<string, Date>();
  for (const p of currentSettled) {
    if (!p.settledAt) continue;
    const first = firstSettlementByBooking.get(p.bookingId);
    if (!first || p.settledAt < first) firstSettlementByBooking.set(p.bookingId, p.settledAt);
  }
  for (const settledAt of firstSettlementByBooking.values()) {
    const entry = seriesMap.get(colomboBucketKey(settledAt, bucket));
    if (entry) entry.paidBookings += 1;
  }
  for (const r of currentRefunds) {
    const entry = seriesMap.get(colomboBucketKey(r.confirmedAt, bucket));
    if (entry) add(entry.netCollectedCents, r.currency, -r.amountCents);
  }

  return {
    range: { from: from.toISOString(), to: to.toISOString(), bucket },
    updatedAt: now.toISOString(),
    tiles: {
      paidBookings: { value: new Set(currentSettled.map((p) => p.bookingId)).size, prev: new Set(previousSettled.map((p) => p.bookingId)).size },
      grossCollected,
      refunded,
      netCollected,
      paymentSuccessPct: { value: currentFunnel.successRatePct, prev: previousFunnel.successRatePct },
      revenueAtRisk,
      upcomingNeedsAttention: needsAttention.length,
    },
    paymentFunnel: currentFunnel,
    series: [...seriesMap.values()],
    operations: {
      upcoming7: upcoming7.length,
      upcoming28: data.bookings.filter((b) => inDays(b.travelDate, 28)).length,
      needsAttention,
      rideBoard: {
        activeLists: activeRideLists.length,
        confirmedLists: activeRideLists.filter((l) => l.status === 'confirmed').length,
        gatheringLists: activeRideLists.filter((l) => l.status === 'gathering').length,
        committedSeats,
        seatsNeeded,
      },
    },
    excluded: data.excluded,
    truncated: data.truncated,
  };
}
