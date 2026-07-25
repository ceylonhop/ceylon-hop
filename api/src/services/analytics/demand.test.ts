import { describe, it, expect } from 'vitest';
import type { DemandQuoteRow } from '../../db/quoteRepo';
import { computeDemand } from './demand';

const DAY = 24 * 3600 * 1000;
const NOW = new Date('2026-07-01T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

let seq = 0;
function mk(over: Partial<DemandQuoteRow> & { places?: string[]; km?: number } = {}): DemandQuoteRow {
  seq += 1;
  const { places, km, ...rest } = over;
  const stops = places ?? ['Colombo Airport (CMB)', 'Kandy'];
  return {
    id: `q${seq}`,
    status: 'draft',
    product: 'private',
    vehicle: 'car',
    requestedService: 'private',
    totalCents: 10000,
    currency: 'USD',
    createdAt: daysAgo(5),
    request: {
      tool: {},
      engine: {
        product: 'private', vehicle: 'car', pax: 2, bags: 1,
        legs: [{ stops, segmentKms: stops.slice(1).map(() => (km ?? 100) / (stops.length - 1)) }],
      },
    },
    ...rest,
  };
}

const range = (fromDays: number, toDays = 0) =>
  ({ from: daysAgo(fromDays), to: daysAgo(toDays), bucket: 'week' as const, now: NOW });

describe('computeDemand', () => {
  it('counts destination touches once per quote and attributes won value', () => {
    const rows = [
      mk({ places: ['Kandy', 'Ella', 'Kandy'] }),                        // Kandy touched once
      mk({ places: ['Kandy', 'Yala'], status: 'won', totalCents: 5000 }),
      mk({ places: ['Ella', 'Galle'] }),
    ];
    const r = computeDemand(rows, range(28));
    const kandy = r.topDestinations.find((d) => d.place === 'Kandy')!;
    expect(kandy.touches).toBe(2);
    expect(kandy.wonValueCents).toEqual({ USD: 5000 });
    const ella = r.topDestinations.find((d) => d.place === 'Ella')!;
    expect(ella.touches).toBe(2);
    expect(ella.wonValueCents).toEqual({});
  });

  it('corridors stay directional with average km', () => {
    const rows = [
      mk({ places: ['Kandy', 'Ella'], km: 100 }),
      mk({ places: ['Kandy', 'Ella'], km: 140 }),
      mk({ places: ['Ella', 'Kandy'], km: 120 }), // reverse direction — its own corridor
    ];
    const r = computeDemand(rows, range(28));
    expect(r.topCorridors.find((c) => c.from === 'Kandy' && c.to === 'Ella')).toMatchObject({ count: 2, avgKm: 120 });
    expect(r.topCorridors.find((c) => c.from === 'Ella' && c.to === 'Kandy')).toMatchObject({ count: 1, avgKm: 120 });
  });

  it('service mix includes an explicit unrecorded share; vehicle mix from the column', () => {
    const rows = [
      mk({ requestedService: 'private' }),
      mk({ requestedService: 'both', vehicle: 'van_6' }),
      mk({ requestedService: null, vehicle: null }),
    ];
    const r = computeDemand(rows, range(28));
    expect(r.tiles.serviceMix).toEqual({ private: 1, chauffeur: 0, both: 1, unrecorded: 1 });
    expect(r.tiles.vehicleMix).toEqual({ car: 1, van_6: 1 }); // null vehicle contributes nothing
  });

  it('movers: small-n guarded (1→2 silent), 3→6 rises, 6→2 falls', () => {
    // 28d range → halves split at 14d. Prior half = 28–14d ago, recent = last 14d.
    const at = (d: number, place: string) => mk({ createdAt: daysAgo(d), places: [place, 'Colombo City'] });
    const rows = [
      // Ella: prior 3, recent 6 → rising
      ...[20, 18, 16].map((d) => at(d, 'Ella')),
      ...[10, 9, 8, 7, 6, 5].map((d) => at(d, 'Ella')),
      // Galle: prior 6, recent 2 → falling
      ...[27, 26, 25, 24, 23, 22].map((d) => at(d, 'Galle')),
      ...[4, 3].map((d) => at(d, 'Galle')),
      // Mirissa: 1 → 2 — too small, silent
      at(20, 'Mirissa'), at(5, 'Mirissa'), at(4, 'Mirissa'),
    ];
    const r = computeDemand(rows, range(28));
    const names = r.movers.map((m) => m.place);
    expect(names).toContain('Ella');
    expect(names).toContain('Galle');
    expect(names).not.toContain('Mirissa');
    expect(r.movers.find((m) => m.place === 'Ella')).toMatchObject({ prior: 3, recent: 6, changePct: 100 });
  });

  it('shared/garbage rows are excluded from destination charts but kept in mix + coverage', () => {
    const rows = [
      mk(),
      mk({ product: 'shared', requestedService: null, request: { tool: {}, engine: { product: 'shared', legs: [{ routeId: 'r1', seats: 2, seatPriceCents: 4500 }] } } }),
      mk({ request: 'garbage' }),
    ];
    const r = computeDemand(rows, range(28));
    expect(r.coverage).toEqual({ parsed: 1, total: 3 });
    expect(r.tiles.serviceMix.unrecorded).toBe(1);
    expect(r.topDestinations.every((d) => d.place !== 'r1')).toBe(true);
  });

  it('km buckets and averages come only from parsed trips; rows outside range ignored', () => {
    const rows = [
      mk({ km: 40 }),
      mk({ km: 150 }),
      mk({ km: 260 }),
      mk({ createdAt: daysAgo(40), km: 999 }), // outside range
    ];
    const r = computeDemand(rows, range(28));
    expect(r.tiles.avgTripKm).toBe(150);
    expect(r.tiles.kmBuckets).toEqual([
      { bucket: '<50', count: 1 }, { bucket: '50-100', count: 0 },
      { bucket: '100-200', count: 1 }, { bucket: '200+', count: 1 },
    ]);
    expect(r.tiles.avgPax).toBe(2);
  });

  it('weekly service trend is zero-filled', () => {
    const rows = [mk({ createdAt: daysAgo(20), requestedService: 'chauffeur' }), mk({ createdAt: daysAgo(2) })];
    const r = computeDemand(rows, range(28));
    expect(r.serviceTrend.length).toBeGreaterThanOrEqual(4);
    expect(r.serviceTrend.reduce((s, w) => s + w.private + w.chauffeur + w.both, 0)).toBe(2);
  });
});
