import { describe, it, expect } from 'vitest';
import type { DistanceResult, MapsAdapter, RouteVariants } from '../adapters/maps';
import { cheaperRouteChoice, measureLeg } from './routeChoice';

const FAST: DistanceResult = { km: 335, durationMin: 299 };
const SLOW: DistanceResult = { km: 213, durationMin: 374 };
const FORK: RouteVariants = { fastest: FAST, noTolls: SLOW, hasChoice: true };
const NO_FORK: RouteVariants = { fastest: FAST, noTolls: null, hasChoice: false };

function stub(opts: { fast?: DistanceResult | null; variants?: RouteVariants | null; variantsThrow?: boolean } = {}) {
  const calls = { distance: 0, variants: 0 };
  const maps: MapsAdapter = {
    provider: 'stub',
    async distance() { calls.distance++; return opts.fast === undefined ? FAST : opts.fast; },
    async distanceVariants() {
      calls.variants++;
      if (opts.variantsThrow) throw new Error('google down');
      return opts.variants === undefined ? FORK : opts.variants;
    },
    async places() { return []; },
  };
  return { maps, calls };
}

describe('measureLeg', () => {
  it('measures the fastest road and never asks for variants when no road is requested', async () => {
    const { maps, calls } = stub();
    expect(await measureLeg(maps, 'A', 'B')).toEqual({ km: 335, durationMin: 299, variant: 'fastest' });
    expect(await measureLeg(maps, 'A', 'B', 'fastest')).toEqual({ km: 335, durationMin: 299, variant: 'fastest' });
    expect(calls.variants).toBe(0);
  });

  it('measures the toll-free road when a material fork exists', async () => {
    const { maps } = stub();
    expect(await measureLeg(maps, 'A', 'B', 'no_tolls')).toEqual({ km: 213, durationMin: 374, variant: 'no_tolls' });
  });

  it('falls back to the fastest road when there is no fork', async () => {
    const { maps } = stub({ variants: NO_FORK });
    expect(await measureLeg(maps, 'A', 'B', 'no_tolls')).toEqual({ km: 335, durationMin: 299, variant: 'fastest' });
  });

  it('falls back to the fastest road when the comparison throws', async () => {
    const { maps } = stub({ variantsThrow: true });
    expect((await measureLeg(maps, 'A', 'B', 'no_tolls'))?.variant).toBe('fastest');
  });

  it('never trades an estimated (offline) distance for a variant', async () => {
    const { maps, calls } = stub({ fast: { km: 300, durationMin: 400, estimated: true } });
    expect(await measureLeg(maps, 'A', 'B', 'no_tolls')).toEqual({ km: 300, durationMin: 400, estimated: true, variant: 'fastest' });
    expect(calls.variants).toBe(0);
  });

  it('returns null when the pair does not resolve', async () => {
    const { maps } = stub({ fast: null });
    expect(await measureLeg(maps, 'A', 'B', 'no_tolls')).toBeNull();
  });
});

describe('cheaperRouteChoice', () => {
  const perKm = (km: number) => km * 40; // any monotonic price is enough here

  it('returns both roads with their prices when the local road is cheaper, without re-measuring', async () => {
    const { maps, calls } = stub();
    expect(await cheaperRouteChoice(maps, 'A', 'B', FAST, perKm)).toEqual({
      fastest: { distanceKm: 335, durationMin: 299, totalCents: 13400 },
      noTolls: { distanceKm: 213, durationMin: 374, totalCents: 8520 },
    });
    expect(calls.distance).toBe(0); // the caller's measured distance is reused, never re-billed
  });

  it('returns null without a fork, on an estimated distance, or when the comparison throws', async () => {
    expect(await cheaperRouteChoice(stub({ variants: NO_FORK }).maps, 'A', 'B', FAST, perKm)).toBeNull();
    const est = stub();
    expect(await cheaperRouteChoice(est.maps, 'A', 'B', { km: 300, durationMin: 1, estimated: true }, perKm)).toBeNull();
    expect(est.calls.variants).toBe(0);
    expect(await cheaperRouteChoice(stub({ variantsThrow: true }).maps, 'A', 'B', FAST, perKm)).toBeNull();
  });

  it('returns null when the toll-free road is not cheaper (floor fare, or longer road)', async () => {
    expect(await cheaperRouteChoice(stub().maps, 'A', 'B', FAST, () => 2900)).toBeNull();
    const longer: RouteVariants = { fastest: FAST, noTolls: { km: 360, durationMin: 420 }, hasChoice: true };
    expect(await cheaperRouteChoice(stub({ variants: longer }).maps, 'A', 'B', FAST, perKm)).toBeNull();
  });
});
