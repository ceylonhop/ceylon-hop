import type { FunnelQuoteRow } from '../../db/quoteRepo';
import { colomboBucketKey, nextBucketKey } from './time';

// Funnel & pipeline aggregation (founder analytics spec 2026-07-23, §A, simplified per the
// 2026-07-23 funnel-simplification spec: fewer tiles, quote $ values first-class). Pure
// function over an already-fetched row set: the repo does a bounded SUPERSET fetch, exact
// range filtering happens here where it is unit-tested. Definitions pinned by funnel.test.ts.

export interface AnalyticsRange { from: Date; to: Date; bucket: 'day' | 'week'; now: Date }

export interface Delta { value: number; prev: number }
export type CurrencyMap = Record<string, number>;   // cents keyed by ISO currency — never merged
export interface Snapshot { count: number; valueCents: CurrencyMap }

export interface FunnelReport {
  range: { from: string; to: string; bucket: 'day' | 'week' };
  tiles: {
    created: Delta; sent: Delta; won: Delta;
    wonValue: CurrencyMap;    // totals of quotes won (decided) in range
    sentValue: CurrencyMap;   // totals of quotes sent in range, regardless of outcome
    avgSentCents: CurrencyMap; // per-currency mean quote size over sent-in-range, whole cents
    pipeline: Snapshot;
  };
  series: { bucketStart: string; created: number; sent: number; won: number }[];
  lostReasons: { reason: string | null; count: number; valueCents: CurrencyMap }[];
  aging: { bucket: '0-2' | '3-7' | '8-14' | '15+'; count: number; valueCents: CurrencyMap }[];
}

const DAY_MS = 24 * 3600 * 1000;

const inRange = (t: Date | null, from: Date, to: Date): boolean =>
  !!t && t.getTime() >= from.getTime() && t.getTime() <= to.getTime();

function addCurrency(map: CurrencyMap, currency: string, cents: number): void {
  map[currency] = (map[currency] ?? 0) + cents;
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

  // Quote $ values — same in-range rules as the Won/Sent count tiles they sit beside.
  const wonValue: CurrencyMap = {};
  const sentValue: CurrencyMap = {};
  const sentCount: Record<string, number> = {};
  for (const r of rows) {
    if (r.status === 'won' && decidedIn(r, from, to)) addCurrency(wonValue, r.currency, r.totalCents);
    if (inRange(r.sentAt, from, to)) {
      addCurrency(sentValue, r.currency, r.totalCents);
      sentCount[r.currency] = (sentCount[r.currency] ?? 0) + 1;
    }
  }
  const avgSentCents: CurrencyMap = {};
  for (const cur of Object.keys(sentValue)) avgSentCents[cur] = Math.round(sentValue[cur] / sentCount[cur]);

  // Live snapshot — `now`-anchored, deliberately ignores the range.
  const pipeline: Snapshot = { count: 0, valueCents: {} };
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

  return {
    range: { from: from.toISOString(), to: to.toISOString(), bucket },
    tiles: { created, sent, won, wonValue, sentValue, avgSentCents, pipeline },
    series: [...seriesMap.values()],
    lostReasons: [...reasonMap.values()].sort((a, b) => b.count - a.count),
    aging: agingBuckets,
  };
}
