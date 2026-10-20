import { describe, it, expect } from 'vitest';
import { collectSystemHealth, VENDOR_LINKS } from './systemHealth';
import { WATCHDOG_TICK } from './watchdog';
import { NOTIFICATIONS_TICK } from './scheduler';
import { UsageMeter } from './usageMeter';
import { InMemoryUsageCounterRepo } from '../db/usageCounterRepo';
import { InMemoryAlertLogRepo } from '../db/alertLogRepo';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';

// The ops Health payload (spec 2026-10-13 §5): what only our own process and database know.

const NOW = new Date('2026-10-13T10:00:00.000Z');
const HOUR = 3600_000;
const sample: NewBooking = {
  mode: 'single',
  input: {
    from: 'Colombo Airport', to: 'Ella', vehicleType: 'car', adults: 2, children: 0, bags: 2,
    customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
  },
  total: 5000, amountDueNow: 5000, currency: 'USD',
};

async function harness() {
  const bookings = new InMemoryBookingRepo();
  const pending = await bookings.create(sample);
  await bookings.setStatus(pending.id, 'payment_pending');
  await bookings.create(sample); // a draft
  const alertLog = new InMemoryAlertLogRepo();
  await alertLog.shouldSend('watchdog_stuck_pending', 'b1', 0, new Date(NOW.getTime() - 2 * HOUR));
  await alertLog.shouldSend('client_error', 'x', 0, new Date(NOW.getTime() - 3 * 24 * HOUR));
  await alertLog.shouldSend('ops_digest', 'daily', 0, new Date(NOW.getTime() - HOUR)); // bookkeeping, not an alert
  await alertLog.shouldSend(WATCHDOG_TICK.kind, WATCHDOG_TICK.key, 0, new Date(NOW.getTime() - 10 * 60_000));
  await alertLog.shouldSend(NOTIFICATIONS_TICK.kind, NOTIFICATIONS_TICK.key, 0, new Date(NOW.getTime() - 30 * HOUR));
  const repo = new InMemoryUsageCounterRepo();
  const meter = new UsageMeter(repo, { now: () => NOW, flushMs: 0 });
  await repo.add('2026-10-01', 'email.sent', 50);   // earlier this month
  await repo.add('2026-09-30', 'email.sent', 999);  // last month — out of the window
  await repo.add('2026-10-13', 'maps.distance', 4);
  meter.bump('email.sent', 7);                      // pending in memory — must still be counted
  meter.bump('email.failed');
  meter.bump('maps.places', 2);
  meter.bump('ratelimit.refused', 5);
  return { bookings, alertLog, repo, meter };
}

describe('collectSystemHealth', () => {
  it('reports build, jobs, alerts, carts, usage against limits, and the vendor links', async () => {
    const { bookings, alertLog, repo, meter } = await harness();
    const h = await collectSystemHealth(NOW, {
      bookings, alertLog,
      usage: { meter, repo },
      dbSize: async () => 21_000_000,
      limits: { emailDaily: 100, emailMonthly: 3000 },
      build: { commit: 'abc1234', startedAt: new Date(NOW.getTime() - 90_000) },
    });

    expect(h.generatedAt).toBe(NOW.toISOString());
    expect(h.dayBasis).toBe('utc');
    expect(h.build).toEqual({ commit: 'abc1234', startedAt: new Date(NOW.getTime() - 90_000).toISOString(), uptimeSec: 90 });
    expect(h.db).toEqual({ sizeBytes: 21_000_000 });

    expect(h.jobs!.watchdog.stale).toBe(false);
    expect(h.jobs!.watchdog.lastRunAt).toBe(new Date(NOW.getTime() - 10 * 60_000).toISOString());
    expect(h.jobs!.notificationsTick.stale).toBe(true); // 30 h > 26 h

    // Bookkeeping ledger rows are not alerts; windows are 24 h and 7 d.
    expect(h.alerts!.last24h).toEqual([{ kind: 'watchdog_stuck_pending', keys: 1 }]);
    expect(h.alerts!.last7d).toEqual(expect.arrayContaining([
      { kind: 'watchdog_stuck_pending', keys: 1 }, { kind: 'client_error', keys: 1 },
    ]));
    expect(h.alerts!.last7d.map((a) => a.kind)).not.toContain('ops_digest');

    expect(h.carts).toEqual({ paymentPending: 1, paymentPendingLast24h: 1, drafts: 1 });

    // Pending meter counts are flushed before reading; last month stays out.
    expect(h.email).toEqual({
      today: { sent: 7, failed: 1, suppressed: 0 },
      month: { sent: 57 },
      dailyLimit: 100, monthlyLimit: 3000,
    });
    expect(h.maps.today).toEqual({ byKey: { 'maps.distance': 4, 'maps.places': 2 }, total: 6 });
    expect(h.maps.month.total).toBe(6);
    expect(h.rateLimit).toEqual({ refusedToday: 5, refusedMonth: 5 });
    expect(h.links).toBe(VENDOR_LINKS);
    expect(VENDOR_LINKS.length).toBeGreaterThan(4);
    for (const l of VENDOR_LINKS) expect(l.url).toMatch(/^https:\/\//);
  });

  it('degrades honestly without a ledger, counters or a database', async () => {
    const bookings = new InMemoryBookingRepo();
    const h = await collectSystemHealth(NOW, { bookings, limits: { emailDaily: 100, emailMonthly: 3000 } });
    expect(h.jobs).toBeNull();
    expect(h.alerts).toBeNull();
    expect(h.db).toEqual({ sizeBytes: null });
    expect(h.email.today).toEqual({ sent: 0, failed: 0, suppressed: 0 });
    expect(h.maps.today).toEqual({ byKey: {}, total: 0 });
    expect(h.carts).toEqual({ paymentPending: 0, paymentPendingLast24h: 0, drafts: 0 });
  });
});
