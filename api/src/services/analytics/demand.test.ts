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
    offerValidUntil: null,
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
  it('counts final destinations once per quote and attributes won value', () => {
    const rows = [
      mk({ places: ['Kandy', 'Ella', 'Kandy'] }),                        // Kandy touched once
      mk({ places: ['Kandy', 'Yala'], status: 'won', totalCents: 5000 }),
      mk({ places: ['Ella', 'Galle'] }),
    ];
    const r = computeDemand(rows, range(28));
    const kandy = r.topDestinations.find((d) => d.place === 'Kandy')!;
    expect(kandy.count).toBe(1);
    expect(kandy.wonValueCents).toEqual({});
    const yala = r.topDestinations.find((d) => d.place === 'Yala')!;
    expect(yala.count).toBe(1);
    expect(yala.wonValueCents).toEqual({ USD: 5000 });
  });

  it('corridors stay directional with average km', () => {
    const rows = [
      mk({ places: ['Kandy', 'Galle'], km: 100 }),
      mk({ places: ['Kandy', 'Galle'], km: 140 }),
      mk({ places: ['Galle', 'Kandy'], km: 120 }), // reverse direction — its own corridor
    ];
    const r = computeDemand(rows, range(28));
    expect(r.topCorridors.find((c) => c.from === 'Hill country' && c.to === 'South coast')).toMatchObject({ count: 2, avgKm: 120 });
    expect(r.topCorridors.find((c) => c.from === 'South coast' && c.to === 'Hill country')).toMatchObject({ count: 1, avgKm: 120 });
  });

  /* Grouping (owner, 2026-10-08). Stored places are free text, so keying on the raw string split
     one town into a bar per hotel address — and put customers' addresses on screen. Origins and
     destinations group by TOWN, corridors and movers by REGION (too sparse town-by-town). */
  it('origins and destinations group addresses into their town; unknown places read "Other"', () => {
    const rows = [
      mk({ places: ['Colombo Airport (CMB)', 'Colombo City'] }),
      mk({ places: ['Bandaranaike International Airport, Katunayake, Sri Lanka', 'Granbell Hotel Colombo, Marine Drive, Colombo, Sri Lanka'] }),
      mk({ places: ['Colombo Airport (CMB)', 'Lighthouse Hotel, Colombo 03, Sri Lanka'] }),
      mk({ places: ['12 Temple Lane, Bella Vista, Sri Lanka', 'Ella'] }),
    ];
    const r = computeDemand(rows, range(28));
    expect(r.topOrigins).toEqual([
      { place: 'Colombo Airport (CMB)', count: 3 },
      { place: 'Other', count: 1 },
    ]);
    expect(r.topDestinations.map((d) => [d.place, d.count])).toEqual([['Colombo City', 3], ['Ella', 1]]);
    const labels = [...r.topOrigins.map((o) => o.place), ...r.topDestinations.map((d) => d.place)];
    expect(labels.some((l) => /Granbell|Lighthouse|Temple Lane/.test(l))).toBe(false);
  });

  it('a destination town is counted once per quote even when two rides end at different addresses in it', () => {
    const row = mk({
      request: { tool: {}, engine: { product: 'private', vehicle: 'car', pax: 2, bags: 1, legs: [
        { stops: ['Colombo Airport (CMB)', '98 Acres Resort, Ella, Sri Lanka'], segmentKms: [200] },
        { stops: ['Kandy', 'Ella'], segmentKms: [140] },
      ] } },
    });
    const r = computeDemand([row], range(28));
    expect(r.topDestinations.find((d) => d.place === 'Ella')).toMatchObject({ count: 1 });
  });

  it('corridors group by region at both ends', () => {
    const rows = [
      mk({ places: ['Colombo Airport (CMB)', 'Galle'], status: 'won', totalCents: 12_000 }),
      mk({ places: ['Negombo', 'Mirissa'] }),
      mk({ places: ['Kandy', 'Ella'] }),
      mk({ places: ['Nuwara Eliya', 'Ella'] }),
    ];
    const r = computeDemand(rows, range(28));
    expect(r.topCorridors.map((c) => [c.from, c.to, c.count])).toEqual([
      ['Airport & Negombo', 'South coast', 2],
      ['Hill country', 'Hill country', 2],
    ]);
    expect(r.topCorridors[0]).toMatchObject({ wins: 1, winRatePct: 50, bookedValueCents: { USD: 12_000 } });
  });

  it('separates origins from destinations and reports commercial corridor outcomes', () => {
    const rows = [
      mk({ places: ['Kandy', 'Ella'], status: 'won', totalCents: 30_000 }),
      mk({ places: ['Kandy', 'Ella'], status: 'lost', totalCents: 10_000 }),
      mk({ places: ['Ella', 'Galle'], status: 'won', totalCents: 20_000 }),
    ];
    const r = computeDemand(rows, range(28));
    expect(r.topOrigins[0]).toMatchObject({ place: 'Kandy', count: 2 });
    expect(r.topDestinations.find((d) => d.place === 'Ella')).toMatchObject({ count: 2 });
    expect(r.topCorridors.find((c) => c.from === 'Hill country' && c.to === 'Hill country')).toMatchObject({
      count: 2, wins: 1, winRatePct: 50, bookedValueCents: { USD: 30_000 },
    });
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
      // Jaffna: 1 → 2 — too small, silent
      at(20, 'Jaffna'), at(5, 'Jaffna'), at(4, 'Jaffna'),
    ];
    const r = computeDemand(rows, range(28));
    const names = r.movers.map((m) => m.place);
    expect(names).toContain('Hill country');
    expect(names).toContain('South coast');
    expect(names).not.toContain('North & west');
    expect(r.movers.find((m) => m.place === 'Hill country')).toMatchObject({ prior: 3, recent: 6, changePct: 100 });
  });

  it('movers: towns in one region add up (Galle 2→1 plus Mirissa 1→4 is a rising south coast)', () => {
    const at = (d: number, place: string) => mk({ createdAt: daysAgo(d), places: [place, 'Colombo City'] });
    const rows = [at(20, 'Galle'), at(18, 'Galle'), at(5, 'Galle'), at(19, 'Mirissa'), ...[6, 5, 4, 3].map((d) => at(d, 'Mirissa'))];
    const r = computeDemand(rows, range(28));
    expect(r.movers.find((m) => m.place === 'South coast')).toMatchObject({ prior: 3, recent: 5 });
  });

  /* A place with NO prior half is not rising — it is new, and there is nothing to compare it
     against. It used to pass both guards anyway: MOVER_MIN_TOUCHES tests the LARGER side, and
     changePct divides by Math.max(prior, 1), so prior=0 yielded recent*100% and cleared the
     ±50% filter automatically. On a dataset younger than the selected range that is every place
     at once, and the card degenerated into a re-ranked copy of the top destinations wearing
     green arrows — noise that reads exactly like signal (owner, 2026-08-01). */
  it('movers: a place with no prior half is NOT a riser, however many recent touches', () => {
    const at = (d: number, place: string) => mk({ createdAt: daysAgo(d), places: [place, 'Colombo City'] });
    const rows = [
      // Colombo Airport: 0 prior, 13 recent — the shape the whole card was showing.
      ...[10, 9, 9, 8, 8, 7, 7, 6, 6, 5, 4, 3, 2].map((d) => at(d, 'Colombo Airport (CMB)')),
      // A genuine riser alongside it, to prove the card still works when there IS history.
      ...[20, 18, 16].map((d) => at(d, 'Ella')),
      ...[10, 9, 8, 7, 6, 5].map((d) => at(d, 'Ella')),
    ];
    const r = computeDemand(rows, range(28));
    const names = r.movers.map((m) => m.place);
    expect(names).not.toContain('Airport & Negombo');
    expect(names).toContain('Hill country');
    // Every surviving mover must have something to compare against.
    r.movers.forEach((m) => expect(m.prior).toBeGreaterThan(0));
  });

  it('movers: the whole card stays empty when nothing has a prior half', () => {
    const at = (d: number, place: string) => mk({ createdAt: daysAgo(d), places: [place, 'Colombo City'] });
    // Every quote in the recent half — a dataset younger than the range, which is what a team
    // that just started using the tool actually has.
    const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((d) => at(d, 'Ella'));
    const r = computeDemand(rows, range(28));
    expect(r.movers).toEqual([]); // the UI's "needs more volume" empty state is the honest answer
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
