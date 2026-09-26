import { describe, expect, it } from 'vitest';
import { computeBusinessAnalytics, type BusinessAnalyticsData } from './business';

const DAY = 86_400_000;
const NOW = new Date('2026-09-26T12:00:00.000Z');
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY);

function data(over: Partial<BusinessAnalyticsData> = {}): BusinessAnalyticsData {
  return {
    bookings: [], payments: [], refunds: [], checkoutEvents: [], rideLists: [],
    excluded: { teamBookings: 0, teamQuoteContacts: 0, seedRideLists: 0, teamRideMembers: 0 },
    truncated: false,
    ...over,
  };
}

const range = { from: at(27), to: NOW, bucket: 'day' as const, now: NOW };

describe('computeBusinessAnalytics', () => {
  it('reports collected and net money from settled payments and confirmed refunds', () => {
    const report = computeBusinessAnalytics(data({
      bookings: [
        { id: 'b1', reference: 'CH-REAL1', channel: 'website', mode: 'single', status: 'paid', totalCents: 50_000, amountDueNowCents: 50_000, currency: 'USD', createdAt: at(5), travelDate: '2026-10-01', fulfilmentStatus: 'vehicle_confirmed' },
        { id: 'b2', reference: 'CH-REAL2', channel: 'whatsapp', mode: 'trip', status: 'paid', totalCents: 20_000, amountDueNowCents: 20_000, currency: 'USD', createdAt: at(4), travelDate: '2026-10-05', fulfilmentStatus: 'paid' },
      ],
      payments: [
        { id: 'p1', bookingId: 'b1', status: 'succeeded', amountCents: 50_000, currency: 'USD', createdAt: at(5), settledAt: at(4), attemptCount: 1, lastAttemptAt: at(4) },
        { id: 'p2', bookingId: 'b2', status: 'succeeded', amountCents: 20_000, currency: 'USD', createdAt: at(4), settledAt: at(3), attemptCount: 1, lastAttemptAt: at(3) },
        { id: 'p3', bookingId: 'b1', status: 'succeeded', amountCents: 5_000, currency: 'USD', createdAt: at(3), settledAt: at(2), attemptCount: 1, lastAttemptAt: at(2) },
      ],
      refunds: [{ bookingId: 'b1', amountCents: 5_000, currency: 'USD', confirmedAt: at(2) }],
    }), range);

    expect(report.tiles.paidBookings.value).toBe(2);
    expect(report.tiles.grossCollected).toEqual({ USD: 75_000 });
    expect(report.tiles.refunded).toEqual({ USD: 5_000 });
    expect(report.tiles.netCollected).toEqual({ USD: 70_000 });
    expect(report.series.reduce((sum, point) => sum + point.paidBookings, 0)).toBe(2);
  });

  it('uses a booking cohort for the website payment funnel and follows retries to success', () => {
    const report = computeBusinessAnalytics(data({
      bookings: [
        { id: 'paid', reference: 'CH-PAID1', channel: 'website', mode: 'single', status: 'paid', totalCents: 10_000, amountDueNowCents: 10_000, currency: 'USD', createdAt: at(5), travelDate: null, fulfilmentStatus: null },
        { id: 'failed', reference: 'CH-FAIL1', channel: 'website', mode: 'single', status: 'payment_pending', totalCents: 12_000, amountDueNowCents: 12_000, currency: 'USD', createdAt: at(4), travelDate: null, fulfilmentStatus: null },
        { id: 'ops-paid', reference: 'CH-OPS01', channel: 'whatsapp', mode: 'single', status: 'paid', totalCents: 20_000, amountDueNowCents: 20_000, currency: 'USD', createdAt: at(4), travelDate: null, fulfilmentStatus: null },
      ],
      payments: [
        { id: 'p1', bookingId: 'paid', status: 'succeeded', amountCents: 10_000, currency: 'USD', createdAt: at(5), settledAt: at(2), attemptCount: 2, lastAttemptAt: at(2) },
        { id: 'p2', bookingId: 'failed', status: 'failed', amountCents: 12_000, currency: 'USD', createdAt: at(4), settledAt: null, attemptCount: 1, lastAttemptAt: at(3) },
        { id: 'p3', bookingId: 'ops-paid', status: 'succeeded', amountCents: 20_000, currency: 'USD', createdAt: at(4), settledAt: at(3), attemptCount: 1, lastAttemptAt: at(3) },
      ],
      checkoutEvents: [
        { bookingId: 'paid', at: at(5), action: 'checkout', outcome: 'succeeded' },
        { bookingId: 'paid', at: at(5), action: 'gateway', outcome: 'opened' },
        { bookingId: 'paid', at: at(4), action: 'webhook', outcome: 'failed' },
        { bookingId: 'paid', at: at(2), action: 'webhook', outcome: 'settled' },
        { bookingId: 'failed', at: at(4), action: 'checkout', outcome: 'succeeded' },
        { bookingId: 'failed', at: at(4), action: 'gateway', outcome: 'opened' },
        { bookingId: 'failed', at: at(3), action: 'webhook', outcome: 'failed' },
        { bookingId: 'ops-paid', at: at(4), action: 'checkout', outcome: 'succeeded' },
        { bookingId: 'ops-paid', at: at(4), action: 'gateway', outcome: 'opened' },
        { bookingId: 'ops-paid', at: at(3), action: 'webhook', outcome: 'settled' },
      ],
    }), range);

    expect(report.paymentFunnel).toMatchObject({ started: 2, gatewayOpened: 2, paid: 1, failed: 1, abandoned: 0, successRatePct: 50 });
  });

  it('surfaces pending money and upcoming operational risks as actionable records', () => {
    const report = computeBusinessAnalytics(data({
      bookings: [
        { id: 'b1', reference: 'CH-RISK1', channel: 'website', mode: 'single', status: 'payment_pending', totalCents: 47_00, amountDueNowCents: 47_00, currency: 'USD', createdAt: at(2), travelDate: '2026-09-29', fulfilmentStatus: null },
        { id: 'b2', reference: 'CH-RISK2', channel: 'whatsapp', mode: 'trip', status: 'paid', totalCents: 90_000, amountDueNowCents: 30_000, currency: 'USD', createdAt: at(10), travelDate: '2026-09-30', fulfilmentStatus: 'paid' },
      ],
      payments: [{ id: 'p1', bookingId: 'b1', status: 'pending', amountCents: 4_700, currency: 'USD', createdAt: at(2), settledAt: null, attemptCount: 2, lastAttemptAt: at(1) }],
    }), range);

    expect(report.tiles.revenueAtRisk).toEqual({ count: 1, valueCents: { USD: 4_700 } });
    expect(report.operations.needsAttention.map((x) => x.reference)).toEqual(['CH-RISK1', 'CH-RISK2']);
    expect(report.tiles.upcomingNeedsAttention).toBe(2);
  });

  it('reports clean Ride Board demand and the repository exclusion totals', () => {
    const report = computeBusinessAnalytics(data({
      rideLists: [
        { id: 'real', code: 'KE-1000', from: 'Kandy', to: 'Ella', status: 'gathering', date: '2026-10-03', cutoffAt: new Date('2026-10-01T00:00:00Z'), minSeats: 4, capacity: 6, seatPriceCents: 2_000, createdAt: at(4), members: [{ seats: 2, status: 'held' }] },
      ],
      excluded: { teamBookings: 3, teamQuoteContacts: 2, seedRideLists: 7, teamRideMembers: 4 },
    }), range);

    expect(report.operations.rideBoard).toMatchObject({ activeLists: 1, committedSeats: 2, seatsNeeded: 2 });
    expect(report.excluded.seedRideLists).toBe(7);
  });
});
