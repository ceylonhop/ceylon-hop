import { describe, it, expect } from 'vitest';
import type { FunnelQuoteRow } from '../../db/quoteRepo';
import { colomboDayKey, colomboWeekKey } from './time';
import { computeFunnel } from './funnel';

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

// Fixed "now" anchor: all row times are built relative to it, so no date-bombs.
// Midday UTC keeps ±few-hour offsets away from any Colombo day boundary unless a
// test crosses it on purpose.
const NOW = new Date('2026-07-01T12:00:00.000Z');
const daysAgo = (n: number, plusMs = 0) => new Date(NOW.getTime() - n * DAY + plusMs);

let seq = 0;
function mk(over: Partial<FunnelQuoteRow> = {}): FunnelQuoteRow {
  seq += 1;
  return {
    id: `q${seq}`,
    status: 'draft',
    product: 'private',
    totalCents: 10000,
    currency: 'USD',
    marginCents: null,
    lostReason: null,
    createdAt: daysAgo(5),
    sentAt: null,
    decidedAt: null,
    ...over,
  };
}

const range = (fromDays: number, toDays = 0, bucket: 'day' | 'week' = 'day') => ({
  from: daysAgo(fromDays),
  to: daysAgo(toDays),
  bucket,
  now: NOW,
});

describe('colombo time keys', () => {
  it('buckets a late-UTC-evening instant onto the NEXT Colombo day', () => {
    // 18:45Z = 00:15 +0530 the following day
    expect(colomboDayKey(new Date('2026-06-30T18:45:00.000Z'))).toBe('2026-07-01');
    expect(colomboDayKey(new Date('2026-06-30T18:29:00.000Z'))).toBe('2026-06-30');
  });

  it('splits ISO weeks at Colombo Monday midnight, labelled by their Monday', () => {
    // 2026-06-29 is a Monday. Sunday 23:00 Colombo = 2026-06-28T17:30Z;
    // Monday 01:00 Colombo = 2026-06-28T19:30Z.
    expect(colomboWeekKey(new Date('2026-06-28T17:00:00.000Z'))).toBe('2026-06-22');
    expect(colomboWeekKey(new Date('2026-06-28T19:30:00.000Z'))).toBe('2026-06-29');
  });
});

describe('computeFunnel tiles', () => {
  it('counts created/sent/decided in range with inclusive edges', () => {
    const q = range(28);
    const rows = [
      mk({ createdAt: q.from }),                                  // exactly at from — counts
      mk({ createdAt: new Date(q.from.getTime() - 1) }),          // 1ms before — out
      mk({ createdAt: daysAgo(40), sentAt: daysAgo(3) }),         // sent in range, created out
      mk({ createdAt: daysAgo(40), sentAt: daysAgo(39), status: 'won', decidedAt: daysAgo(2) }),
    ];
    const r = computeFunnel(rows, q);
    expect(r.tiles.created.value).toBe(1);
    expect(r.tiles.sent.value).toBe(1);
    expect(r.tiles.won.value).toBe(1);
  });

  it('deltas compare against the previous equal-length window', () => {
    const rows = [
      mk({ createdAt: daysAgo(3) }),  // current 7d window
      mk({ createdAt: daysAgo(10) }), // previous window (7–14d ago)
      mk({ createdAt: daysAgo(12) }),
      mk({ createdAt: daysAgo(20) }), // outside both
    ];
    const r = computeFunnel(rows, range(7));
    expect(r.tiles.created).toEqual({ value: 1, prev: 2 });
  });
});

describe('computeFunnel quote $ values', () => {
  it('won value sums decided-in-range wins per currency; quoted value sums sent-in-range', () => {
    const rows = [
      mk({ status: 'won', createdAt: daysAgo(20), sentAt: daysAgo(10), decidedAt: daysAgo(5), totalCents: 30000 }),
      mk({ status: 'won', createdAt: daysAgo(20), sentAt: daysAgo(10), decidedAt: daysAgo(4), totalCents: 8000, currency: 'EUR' }),
      mk({ status: 'won', createdAt: daysAgo(60), sentAt: daysAgo(50), decidedAt: daysAgo(40), totalCents: 99999 }), // decided out of range
      mk({ status: 'sent', createdAt: daysAgo(20), sentAt: daysAgo(3), totalCents: 12000 }),  // sent in range, not won
      mk({ status: 'lost', createdAt: daysAgo(20), sentAt: daysAgo(50), decidedAt: daysAgo(2), totalCents: 5000 }), // lost — not won value; sent out of range
    ];
    const r = computeFunnel(rows, range(28));
    expect(r.tiles.wonValue).toEqual({ USD: 30000, EUR: 8000 });
    // Quoted value follows sentAt-in-range regardless of eventual outcome.
    expect(r.tiles.sentValue).toEqual({ USD: 42000, EUR: 8000 });
  });

  it('avg quote size divides per currency over sent-in-range quotes, rounded to whole cents', () => {
    const rows = [
      mk({ status: 'sent', createdAt: daysAgo(20), sentAt: daysAgo(3), totalCents: 10000 }),
      mk({ status: 'sent', createdAt: daysAgo(20), sentAt: daysAgo(2), totalCents: 15001 }),
      mk({ status: 'sent', createdAt: daysAgo(20), sentAt: daysAgo(1), totalCents: 7000, currency: 'EUR' }),
      mk({ status: 'draft', createdAt: daysAgo(2), totalCents: 50000 }), // never sent — excluded
    ];
    const r = computeFunnel(rows, range(7));
    expect(r.tiles.avgSentCents).toEqual({ USD: 12501, EUR: 7000 }); // (10000+15001)/2 → 12500.5 → 12501
  });

  it('empty range yields empty currency maps, not zeros or NaN', () => {
    const r = computeFunnel([], range(7));
    expect(r.tiles.wonValue).toEqual({});
    expect(r.tiles.sentValue).toEqual({});
    expect(r.tiles.avgSentCents).toEqual({});
  });
});

describe('computeFunnel snapshots (ignore range, use now)', () => {
  it('pipeline = current sent only, value grouped per currency, never merged', () => {
    const rows = [
      mk({ status: 'sent', createdAt: daysAgo(60), sentAt: daysAgo(50), totalCents: 5000 }),
      mk({ status: 'sent', createdAt: daysAgo(2), sentAt: daysAgo(1), totalCents: 7000, currency: 'EUR' }),
      mk({ status: 'won', createdAt: daysAgo(9), sentAt: daysAgo(8), decidedAt: daysAgo(7) }),
      mk({ status: 'pending_review', createdAt: daysAgo(1), totalCents: 100 }),
    ];
    const r = computeFunnel(rows, range(7));
    expect(r.tiles.pipeline).toEqual({ count: 2, valueCents: { USD: 5000, EUR: 7000 } });
  });

  it('aging buckets open sent quotes by whole days since sentAt', () => {
    const rows = [
      mk({ status: 'sent', createdAt: daysAgo(40), sentAt: daysAgo(0, -2 * HOUR) }),        // <3d → 0-2
      mk({ status: 'sent', createdAt: daysAgo(40), sentAt: daysAgo(2, -23 * HOUR) }),       // 2d23h → 0-2
      mk({ status: 'sent', createdAt: daysAgo(40), sentAt: daysAgo(3) }),                   // 3-7
      mk({ status: 'sent', createdAt: daysAgo(40), sentAt: daysAgo(8) }),                   // 8-14
      mk({ status: 'sent', createdAt: daysAgo(40), sentAt: daysAgo(14, -12 * HOUR) }),      // 14.5d → 8-14
      mk({ status: 'sent', createdAt: daysAgo(40), sentAt: daysAgo(15) }),                  // 15+
      mk({ status: 'won', createdAt: daysAgo(40), sentAt: daysAgo(20), decidedAt: daysAgo(1) }), // decided — absent
    ];
    const r = computeFunnel(rows, range(7));
    expect(r.aging.map((b) => [b.bucket, b.count])).toEqual([
      ['0-2', 2], ['3-7', 1], ['8-14', 2], ['15+', 1],
    ]);
  });
});

describe('computeFunnel series & lost reasons', () => {
  it('series is zero-filled per Colombo day with created/sent/won stacked by their own stamps', () => {
    const q = range(2);
    const rows = [
      mk({ createdAt: daysAgo(1) }),
      mk({ createdAt: daysAgo(1), sentAt: daysAgo(0, -HOUR) }),
    ];
    const r = computeFunnel(rows, q);
    expect(r.series.length).toBe(3); // 2 days ago, yesterday, today — no gaps
    expect(r.series.reduce((s, b) => s + b.created, 0)).toBe(2);
    expect(r.series.reduce((s, b) => s + b.sent, 0)).toBe(1);
    expect(r.series.every((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.bucketStart))).toBe(true);
  });

  it('lost reasons group nulls separately and sort by count desc', () => {
    const rows = [
      mk({ status: 'lost', createdAt: daysAgo(9), decidedAt: daysAgo(2), lostReason: 'price' }),
      mk({ status: 'lost', createdAt: daysAgo(9), decidedAt: daysAgo(2), lostReason: 'price', totalCents: 2000 }),
      mk({ status: 'lost', createdAt: daysAgo(9), decidedAt: daysAgo(1), lostReason: null }),
    ];
    const r = computeFunnel(rows, range(28));
    expect(r.lostReasons[0]).toEqual({ reason: 'price', count: 2, valueCents: { USD: 12000 } });
    expect(r.lostReasons[1].reason).toBeNull();
  });
});
