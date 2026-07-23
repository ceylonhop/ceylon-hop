import type { FunnelQuoteRow, QuoteStatus } from '../../db/quoteRepo';
import { colomboBucketKey, nextBucketKey } from './time';

// Funnel & pipeline aggregation (founder analytics spec 2026-07-23, §A). Pure function over an
// already-fetched row set: the repo does a bounded SUPERSET fetch, exact range filtering happens
// here where it is unit-tested. Every definition below is pinned by funnel.test.ts.

export interface AnalyticsRange { from: Date; to: Date; bucket: 'day' | 'week'; now: Date }

export interface Delta { value: number; prev: number }
export interface Ratio { num: number; den: number } // UI renders "x of y" when den < 5
export type CurrencyMap = Record<string, number>;   // cents keyed by ISO currency — never merged
export interface Snapshot { count: number; valueCents: CurrencyMap }
interface Stat { median: number; p90: number; n: number }

export interface FunnelReport {
  range: { from: string; to: string; bucket: 'day' | 'week' };
  tiles: {
    created: Delta; sent: Delta;
    won: Delta; lost: Delta; expired: Delta;
    winRate: Ratio;
    sendRate: Ratio;
    pipeline: Snapshot;
    inReview: Snapshot;
  };
  series: { bucketStart: string; created: number; sent: number; won: number }[];
  funnel: { created: number; sent: number; won: number };
  lostReasons: { reason: string | null; count: number; valueCents: CurrencyMap }[];
  aging: { bucket: '0-2' | '3-7' | '8-14' | '15+'; count: number; valueCents: CurrencyMap }[];
  cycles: {
    draftToSentHours: Stat | null;
    sentToDecidedDays: Stat | null;
  };
}

const DAY_MS = 24 * 3600 * 1000;
const IN_REVIEW: readonly QuoteStatus[] = ['pending_review', 'changes_requested', 'ready'];

const inRange = (t: Date | null, from: Date, to: Date): boolean =>
  !!t && t.getTime() >= from.getTime() && t.getTime() <= to.getTime();

function addCurrency(map: CurrencyMap, currency: string, cents: number): void {
  map[currency] = (map[currency] ?? 0) + cents;
}

// Nearest-rank p90; median averages the middle pair on even n.
function stat(values: number[]): Stat | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length / 2;
  const median = s.length % 2 === 1 ? s[Math.floor(mid)] : (s[mid - 1] + s[mid]) / 2;
  const p90 = s[Math.max(0, Math.ceil(0.9 * s.length) - 1)];
  return { median, p90, n: s.length };
}

export function computeFunnel(rows: FunnelQuoteRow[], q: AnalyticsRange): FunnelReport {
  const { from, to, bucket, now } = q;
  // Previous equal-length window, ending immediately before `from`.
  const windowMs = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - windowMs - 1);
  const prevTo = new Date(from.getTime() - 1);

  const count = (stamp: (r: FunnelQuoteRow) => Date | null, pred: (r: FunnelQuoteRow) => boolean = () => true): Delta => ({
    value: rows.filter((r) => pred(r) && inRange(stamp(r), from, to)).length,
    prev: rows.filter((r) => pred(r) && inRange(stamp(r), prevFrom, prevTo)).length,
  });

  const decidedIn = (r: FunnelQuoteRow, f: Date, t: Date) => inRange(r.decidedAt, f, t);
  const created = count((r) => r.createdAt);
  const sent = count((r) => r.sentAt);
  const won = count((r) => r.decidedAt, (r) => r.status === 'won');
  const lost = count((r) => r.decidedAt, (r) => r.status === 'lost');
  const expired = count((r) => r.decidedAt, (r) => r.status === 'expired');

  const decidedNow = rows.filter((r) => decidedIn(r, from, to));
  const winRate: Ratio = { num: decidedNow.filter((r) => r.status === 'won').length, den: decidedNow.length };

  const cohort = rows.filter((r) => inRange(r.createdAt, from, to));
  const sendRate: Ratio = { num: cohort.filter((r) => r.sentAt).length, den: cohort.length };
  const funnel = {
    created: cohort.length,
    sent: cohort.filter((r) => r.sentAt).length,
    won: cohort.filter((r) => r.status === 'won').length,
  };

  // Live snapshots — `now`-anchored, deliberately ignore the range.
  const pipeline: Snapshot = { count: 0, valueCents: {} };
  const inReview: Snapshot = { count: 0, valueCents: {} };
  const agingBuckets = [
    { bucket: '0-2' as const, count: 0, valueCents: {} as CurrencyMap },
    { bucket: '3-7' as const, count: 0, valueCents: {} as CurrencyMap },
    { bucket: '8-14' as const, count: 0, valueCents: {} as CurrencyMap },
    { bucket: '15+' as const, count: 0, valueCents: {} as CurrencyMap },
  ];
  for (const r of rows) {
    if (r.status === 'sent') {
      pipeline.count += 1;
      addCurrency(pipeline.valueCents, r.currency, r.totalCents);
      const days = Math.floor((now.getTime() - (r.sentAt ?? r.createdAt).getTime()) / DAY_MS);
      const b = days < 3 ? agingBuckets[0] : days < 8 ? agingBuckets[1] : days < 15 ? agingBuckets[2] : agingBuckets[3];
      b.count += 1;
      addCurrency(b.valueCents, r.currency, r.totalCents);
    } else if (IN_REVIEW.includes(r.status)) {
      inReview.count += 1;
      addCurrency(inReview.valueCents, r.currency, r.totalCents);
    }
  }

  // Zero-filled series across the range in Colombo buckets.
  const seriesMap = new Map<string, { bucketStart: string; created: number; sent: number; won: number }>();
  const endKey = colomboBucketKey(to, bucket);
  for (let key = colomboBucketKey(from, bucket); ; key = nextBucketKey(key, bucket)) {
    seriesMap.set(key, { bucketStart: key, created: 0, sent: 0, won: 0 });
    if (key >= endKey) break;
  }
  const bump = (t: Date | null, field: 'created' | 'sent' | 'won') => {
    if (!t || !inRange(t, from, to)) return;
    const entry = seriesMap.get(colomboBucketKey(t, bucket));
    if (entry) entry[field] += 1;
  };
  for (const r of rows) {
    bump(r.createdAt, 'created');
    bump(r.sentAt, 'sent');
    if (r.status === 'won') bump(r.decidedAt, 'won');
  }

  // Lost reasons over quotes lost in range; null reason is its own visible group.
  const lostRows = rows.filter((r) => r.status === 'lost' && decidedIn(r, from, to));
  const reasonMap = new Map<string | null, { reason: string | null; count: number; valueCents: CurrencyMap }>();
  for (const r of lostRows) {
    const key = r.lostReason ?? null;
    const entry = reasonMap.get(key) ?? { reason: key, count: 0, valueCents: {} };
    entry.count += 1;
    addCurrency(entry.valueCents, r.currency, r.totalCents);
    reasonMap.set(key, entry);
  }

  const cycleHours = rows
    .filter((r) => inRange(r.sentAt, from, to))
    .map((r) => (r.sentAt!.getTime() - r.createdAt.getTime()) / (3600 * 1000));
  const cycleDays = rows
    .filter((r) => r.sentAt && decidedIn(r, from, to))
    .map((r) => (r.decidedAt!.getTime() - r.sentAt!.getTime()) / DAY_MS);

  return {
    range: { from: from.toISOString(), to: to.toISOString(), bucket },
    tiles: { created, sent, won, lost, expired, winRate, sendRate, pipeline, inReview },
    series: [...seriesMap.values()],
    funnel,
    lostReasons: [...reasonMap.values()].sort((a, b) => b.count - a.count),
    aging: agingBuckets,
    cycles: { draftToSentHours: stat(cycleHours), sentToDecidedDays: stat(cycleDays) },
  };
}
