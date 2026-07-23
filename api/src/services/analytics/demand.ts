import type { DemandQuoteRow } from '../../db/quoteRepo';
import type { AnalyticsRange, CurrencyMap } from './funnel';
import { colomboWeekKey, nextBucketKey } from './time';
import { extractTrip } from './extractLegs';

// Demand & geography aggregation (founder analytics spec 2026-07-23, §C). Pure function; all
// metrics are over quotes CREATED in range (demand = what was asked for, regardless of outcome),
// except won-value attribution which sums won-quote totals onto each touched place.

export interface DemandReport {
  range: { from: string; to: string };
  tiles: {
    serviceMix: { private: number; chauffeur: number; both: number; unrecorded: number };
    vehicleMix: Record<string, number>;
    avgTripKm: number | null;
    kmBuckets: { bucket: '<50' | '50-100' | '100-200' | '200+'; count: number }[];
    avgPax: number | null;
  };
  topDestinations: { place: string; touches: number; wonValueCents: CurrencyMap }[];
  topCorridors: { from: string; to: string; count: number; avgKm: number | null }[];
  movers: { place: string; recent: number; prior: number; changePct: number }[];
  serviceTrend: { bucketStart: string; private: number; chauffeur: number; both: number }[];
  coverage: { parsed: number; total: number };
}

const TOP_N = 12;
// Movers guard: a side needs ≥3 touches and the swing ≥50% before we call it a trend —
// 1→2 is noise, 3→6 is a signal.
const MOVER_MIN_TOUCHES = 3;
const MOVER_MIN_CHANGE_PCT = 50;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function computeDemand(rows: DemandQuoteRow[], q: AnalyticsRange): DemandReport {
  const { from, to } = q;
  const inRange = rows.filter((r) => r.createdAt >= from && r.createdAt <= to);

  const serviceMix = { private: 0, chauffeur: 0, both: 0, unrecorded: 0 };
  const vehicleMix: Record<string, number> = {};
  const kmBuckets: DemandReport['tiles']['kmBuckets'] = [
    { bucket: '<50', count: 0 }, { bucket: '50-100', count: 0 },
    { bucket: '100-200', count: 0 }, { bucket: '200+', count: 0 },
  ];
  const kms: number[] = [];
  const paxes: number[] = [];

  const dest = new Map<string, { place: string; touches: number; wonValueCents: CurrencyMap }>();
  const corr = new Map<string, { from: string; to: string; count: number; kms: number[] }>();
  const halves = new Map<string, { recent: number; prior: number }>();
  const mid = new Date(from.getTime() + (to.getTime() - from.getTime()) / 2);

  // Weekly service trend, zero-filled across the range.
  const trend = new Map<string, { bucketStart: string; private: number; chauffeur: number; both: number }>();
  const endWeek = colomboWeekKey(to);
  for (let key = colomboWeekKey(from); ; key = nextBucketKey(key, 'week')) {
    trend.set(key, { bucketStart: key, private: 0, chauffeur: 0, both: 0 });
    if (key >= endWeek) break;
  }

  let parsed = 0;
  for (const r of inRange) {
    const svc = r.requestedService;
    if (svc === 'private' || svc === 'chauffeur' || svc === 'both') {
      serviceMix[svc] += 1;
      const week = trend.get(colomboWeekKey(r.createdAt));
      if (week) week[svc] += 1;
    } else {
      serviceMix.unrecorded += 1;
    }
    if (r.vehicle) vehicleMix[r.vehicle] = (vehicleMix[r.vehicle] ?? 0) + 1;

    const trip = extractTrip(r.request);
    if (!trip) continue;
    parsed += 1;

    if (trip.totalKm !== null) {
      kms.push(trip.totalKm);
      const b = trip.totalKm < 50 ? 0 : trip.totalKm < 100 ? 1 : trip.totalKm < 200 ? 2 : 3;
      kmBuckets[b].count += 1;
    }
    if (trip.pax !== null) paxes.push(trip.pax);

    for (const place of trip.places) {
      const d = dest.get(place) ?? { place, touches: 0, wonValueCents: {} };
      d.touches += 1;
      if (r.status === 'won') d.wonValueCents[r.currency] = (d.wonValueCents[r.currency] ?? 0) + r.totalCents;
      dest.set(place, d);

      const h = halves.get(place) ?? { recent: 0, prior: 0 };
      if (r.createdAt > mid) h.recent += 1; else h.prior += 1;
      halves.set(place, h);
    }
    for (const c of trip.corridors) {
      const key = `${c.from}→${c.to}`;
      const entry = corr.get(key) ?? { from: c.from, to: c.to, count: 0, kms: [] };
      entry.count += 1;
      if (c.km !== null) entry.kms.push(c.km);
      corr.set(key, entry);
    }
  }

  const movers = [...halves.values()]
    .map((h, i) => ({ place: [...halves.keys()][i], ...h }))
    .filter((h) => Math.max(h.recent, h.prior) >= MOVER_MIN_TOUCHES)
    .map((h) => ({
      place: h.place, recent: h.recent, prior: h.prior,
      changePct: Math.round(((h.recent - h.prior) / Math.max(h.prior, 1)) * 100),
    }))
    .filter((m) => Math.abs(m.changePct) >= MOVER_MIN_CHANGE_PCT)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

  const byTouches = [...dest.values()].sort((a, b) => b.touches - a.touches || a.place.localeCompare(b.place));

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    tiles: {
      serviceMix,
      vehicleMix,
      avgTripKm: kms.length ? round1(kms.reduce((s, k) => s + k, 0) / kms.length) : null,
      kmBuckets,
      avgPax: paxes.length ? round1(paxes.reduce((s, p) => s + p, 0) / paxes.length) : null,
    },
    topDestinations: byTouches.slice(0, TOP_N),
    topCorridors: [...corr.values()]
      .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from))
      .slice(0, TOP_N)
      .map((c) => ({
        from: c.from, to: c.to, count: c.count,
        avgKm: c.kms.length ? round1(c.kms.reduce((s, k) => s + k, 0) / c.kms.length) : null,
      })),
    movers,
    serviceTrend: [...trend.values()],
    coverage: { parsed, total: inRange.length },
  };
}
