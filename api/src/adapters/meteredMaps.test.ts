import { describe, it, expect } from 'vitest';
import { MeteredMapsAdapter } from './meteredMaps';
import type { MapsAdapter } from './maps';
import { UsageMeter } from '../services/usageMeter';
import { InMemoryUsageCounterRepo } from '../db/usageCounterRepo';

// Counts LIVE Google calls per method against the per-SKU monthly allowances (spec 2026-10-13
// §3). It wraps the raw Google adapter INSIDE CachedMapsAdapter, so a cache hit never counts.

const T0 = new Date('2026-10-13T10:00:00.000Z');

function stubMaps(withOptional: boolean): MapsAdapter {
  const base: MapsAdapter = {
    provider: 'stub',
    distance: async () => ({ km: 100, durationMin: 120 }),
    distanceVariants: async () => null,
    places: async () => [],
  };
  if (!withOptional) return base;
  return {
    ...base,
    geocode: async () => null,
    placeCandidates: async () => [],
  };
}

function harness(inner: MapsAdapter) {
  const repo = new InMemoryUsageCounterRepo();
  const meter = new UsageMeter(repo, { now: () => T0, flushMs: 0 });
  const adapter = new MeteredMapsAdapter(inner, meter);
  const counts = async () => {
    await meter.flush();
    return Object.fromEntries((await repo.range('2026-10-13', '2026-10-13')).map((r) => [r.key, r.n]));
  };
  return { adapter, counts };
}

describe('MeteredMapsAdapter', () => {
  it('counts each live call under its own key and returns the inner result', async () => {
    const { adapter, counts } = harness(stubMaps(true));
    expect(await adapter.distance('Kandy', 'Ella')).toEqual({ km: 100, durationMin: 120 });
    await adapter.distance('Ella', 'Kandy');
    await adapter.distanceVariants('Kandy', 'Ella');
    await adapter.places('Ell');
    await adapter.geocode!('Ella');
    await adapter.placeCandidates!('Ella');
    expect(await counts()).toEqual({
      'maps.distance': 2,
      'maps.route_variants': 1,
      'maps.places': 1,
      'maps.geocode': 1,
      'maps.place_candidates': 1,
    });
    expect(adapter.provider).toBe('stub');
  });

  it('reports the optional methods absent exactly when the inner adapter does', () => {
    const { adapter } = harness(stubMaps(false));
    expect(adapter.geocode).toBeUndefined();
    expect(adapter.placeCandidates).toBeUndefined();
  });

  it('counts a call that throws — Google billed it — and rethrows', async () => {
    const boom = new Error('quota');
    const { adapter, counts } = harness({ ...stubMaps(false), distance: async () => { throw boom; } });
    await expect(adapter.distance('a', 'b')).rejects.toBe(boom);
    expect(await counts()).toEqual({ 'maps.distance': 1 });
  });
});
