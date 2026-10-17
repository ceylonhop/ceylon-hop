import type { BookingRepo } from '../db/bookingRepo';
import type { AlertLogRepo } from '../db/alertLogRepo';
import { WATCHDOG_TICK, WATCHDOG_STALE_MS } from './watchdog';
import { NOTIFICATIONS_TICK, NOTIFICATIONS_STALE_MS } from './scheduler';
import { utcDay } from './usageMeter';
import type { UsageSource } from './emailQuota';

// The ops Health payload (spec 2026-10-13 §5): what only our own process and database know —
// heartbeats, alert kinds, abandoned carts, and usage against the free-tier caps. Outage detection
// and vendor metrics live elsewhere (UptimeRobot, the vendor consoles — linked below); this is the
// one place to start from. Days are UTC, and say so.

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

// Ledger rows that are bookkeeping, not alerts anyone received (digest.ts keeps the same set).
export const BOOKKEEPING_KINDS: ReadonlySet<string> = new Set(['ops_digest', WATCHDOG_TICK.kind, NOTIFICATIONS_TICK.kind]);

export const VENDOR_LINKS: ReadonlyArray<{ label: string; url: string }> = [
  { label: 'Render — service, logs, instance hours', url: 'https://dashboard.render.com/' },
  { label: 'Supabase — database, usage, backups', url: 'https://supabase.com/dashboard/projects' },
  { label: 'Resend — emails, daily volume, bounces', url: 'https://resend.com/emails' },
  { label: 'Google Cloud — Maps quotas & billing', url: 'https://console.cloud.google.com/google/maps-apis/quotas' },
  { label: 'Sentry — errors', url: 'https://sentry.io/' },
  { label: 'GitHub Actions — crons & CI', url: 'https://github.com/ceylonhop/ceylon-hop/actions' },
  { label: 'cron-job.org — watchdog schedule', url: 'https://console.cron-job.org/' },
  { label: 'UptimeRobot — uptime & status page', url: 'https://dashboard.uptimerobot.com/' },
];

export interface SystemHealthDeps {
  bookings: Pick<BookingRepo, 'list'>;
  alertLog?: AlertLogRepo;
  usage?: UsageSource;
  dbSize?: () => Promise<number | null>;
  limits: { emailDaily: number; emailMonthly: number };
  build?: { commit?: string | null; startedAt: Date };
}

export interface SystemHealth {
  generatedAt: string;
  dayBasis: 'utc';
  build: { commit: string | null; startedAt: string; uptimeSec: number };
  db: { sizeBytes: number | null };
  jobs: {
    watchdog: { lastRunAt: string | null; stale: boolean };
    notificationsTick: { lastRunAt: string | null; stale: boolean };
  } | null;
  alerts: { last24h: AlertKindCount[]; last7d: AlertKindCount[] } | null;
  carts: { paymentPending: number; paymentPendingLast24h: number; drafts: number };
  email: {
    today: { sent: number; failed: number; suppressed: number };
    month: { sent: number };
    dailyLimit: number;
    monthlyLimit: number;
  };
  maps: { today: UsageByKey; month: UsageByKey };
  rateLimit: { refusedToday: number; refusedMonth: number };
  links: typeof VENDOR_LINKS;
}

export interface AlertKindCount { kind: string; keys: number }
export interface UsageByKey { byKey: Record<string, number>; total: number }

// The process's own start time — the default when server.ts passes no build info.
const PROCESS_STARTED_AT = new Date();

export async function collectSystemHealth(now: Date, deps: SystemHealthDeps): Promise<SystemHealth> {
  const startedAt = deps.build?.startedAt ?? PROCESS_STARTED_AT;
  const commit = deps.build?.commit ?? process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null;

  const [sizeBytes, jobs, alerts, carts, usage] = await Promise.all([
    deps.dbSize ? deps.dbSize().catch(() => null) : Promise.resolve(null),
    deps.alertLog ? heartbeats(now, deps.alertLog) : Promise.resolve(null),
    deps.alertLog ? alertCounts(now, deps.alertLog) : Promise.resolve(null),
    cartCounts(now, deps.bookings),
    usageWindows(now, deps.usage),
  ]);

  return {
    generatedAt: now.toISOString(),
    dayBasis: 'utc',
    build: { commit, startedAt: startedAt.toISOString(), uptimeSec: Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000)) },
    db: { sizeBytes },
    jobs,
    alerts,
    carts,
    email: {
      today: {
        sent: usage.today['email.sent'] ?? 0,
        failed: usage.today['email.failed'] ?? 0,
        suppressed: usage.today['email.suppressed'] ?? 0,
      },
      month: { sent: usage.month['email.sent'] ?? 0 },
      dailyLimit: deps.limits.emailDaily,
      monthlyLimit: deps.limits.emailMonthly,
    },
    maps: { today: byPrefix(usage.today, 'maps.'), month: byPrefix(usage.month, 'maps.') },
    rateLimit: {
      refusedToday: usage.today['ratelimit.refused'] ?? 0,
      refusedMonth: usage.month['ratelimit.refused'] ?? 0,
    },
    links: VENDOR_LINKS,
  };
}

async function heartbeats(now: Date, log: AlertLogRepo) {
  const [watchdog, tick] = await Promise.all([
    log.lastSentAt(WATCHDOG_TICK.kind, WATCHDOG_TICK.key),
    log.lastSentAt(NOTIFICATIONS_TICK.kind, NOTIFICATIONS_TICK.key),
  ]);
  const beat = (last: Date | null, staleMs: number) => ({
    lastRunAt: last ? last.toISOString() : null,
    stale: !last || now.getTime() - last.getTime() > staleMs,
  });
  return { watchdog: beat(watchdog, WATCHDOG_STALE_MS), notificationsTick: beat(tick, NOTIFICATIONS_STALE_MS) };
}

// countsSince is the digest's approximation — one row per (kind, dedupe_key) whose last send
// falls in the window — labelled `keys` so nobody reads it as emails sent.
async function alertCounts(now: Date, log: AlertLogRepo) {
  const window = async (ms: number): Promise<AlertKindCount[]> => {
    const counts = await log.countsSince(new Date(now.getTime() - ms));
    return Object.entries(counts)
      .filter(([kind]) => !BOOKKEEPING_KINDS.has(kind))
      .map(([kind, keys]) => ({ kind, keys }))
      .sort((a, b) => b.keys - a.keys || a.kind.localeCompare(b.kind));
  };
  const [last24h, last7d] = await Promise.all([window(DAY_MS), window(7 * DAY_MS)]);
  return { last24h, last7d };
}

async function cartCounts(now: Date, bookings: Pick<BookingRepo, 'list'>) {
  const [pending, drafts] = await Promise.all([
    bookings.list({ status: 'payment_pending' }),
    bookings.list({ status: 'draft' }),
  ]);
  const since = now.getTime() - DAY_MS;
  return {
    paymentPending: pending.length,
    paymentPendingLast24h: pending.filter((b) => Date.parse(b.createdAt) >= since).length,
    drafts: drafts.length,
  };
}

// Today and month-to-date (UTC) per key. The meter is flushed first so the page is never behind
// by more than this request.
async function usageWindows(now: Date, usage?: UsageSource): Promise<{ today: Record<string, number>; month: Record<string, number> }> {
  const today: Record<string, number> = {};
  const month: Record<string, number> = {};
  if (!usage) return { today, month };
  await usage.meter.flush();
  const day = utcDay(now);
  const monthStart = `${day.slice(0, 7)}-01`;
  for (const row of await usage.repo.range(monthStart, day)) {
    month[row.key] = (month[row.key] ?? 0) + row.n;
    if (row.day === day) today[row.key] = (today[row.key] ?? 0) + row.n;
  }
  return { today, month };
}

function byPrefix(counts: Record<string, number>, prefix: string): UsageByKey {
  const byKey: Record<string, number> = {};
  let total = 0;
  for (const [key, n] of Object.entries(counts)) {
    if (!key.startsWith(prefix)) continue;
    byKey[key] = n;
    total += n;
  }
  return { byKey, total };
}
