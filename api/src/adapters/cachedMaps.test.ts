import { describe, it, expect, vi } from 'vitest';
import { CachedMapsAdapter } from './cachedMaps';
import { isCatalogTown, type MapsAdapter, type DistanceResult } from './maps';
import { InMemoryDistanceCacheRepo } from '../db/distanceCacheRepo';

function fakeInner(result: DistanceResult | null): MapsAdapter & { calls: number } {
  const inner = {
    provider: 'test',
    calls: 0,
    places: async () => [],
    distanceVariants: async () => null,
    async distance(): Promise<DistanceResult | null> {
      inner.calls++;
      return result;
    },
  };
  return inner;
}

describe('isCatalogTown', () => {
  it('recognises catalogue towns in any spelling canonPlace collapses', () => {
    expect(isCatalogTown('Ella')).toBe(true);
    expect(isCatalogTown('  ella, Sri Lanka ')).toBe(true);
  });
  it('rejects coordinates and unknown strings', () => {
    expect(isCatalogTown('6.87,81.05')).toBe(false);
    expect(isCatalogTown('Villa Serendib, Ahangama Rd')).toBe(false);
  });
});

describe('CachedMapsAdapter', () => {
  it('serves a hit from the cache without calling the inner adapter', async () => {
    const inner = fakeInner({ km: 999, durationMin: 999 });
    const cache = new InMemoryDistanceCacheRepo();
    await cache.upsert({ fromKey: 'ella', toKey: 'yala', km: 126, durationMin: 198 });
    const maps = new CachedMapsAdapter(inner, cache);
    const d = await maps.distance('Ella', 'Yala');
    expect(d).toEqual({ km: 126, durationMin: 198 });
    expect(inner.calls).toBe(0);
  });

  it('writes a real result back on a miss between catalogue towns', async () => {
    const inner = fakeInner({ km: 126, durationMin: 198 });
    const cache = new InMemoryDistanceCacheRepo();
    const maps = new CachedMapsAdapter(inner, cache);
    await maps.distance('Ella', 'Yala');
    expect(inner.calls).toBe(1);
    expect((await cache.get('ella', 'yala'))!.km).toBe(126);
    // Second call is a hit.
    await maps.distance('Ella', 'Yala');
    expect(inner.calls).toBe(1);
  });

  it('never stores an estimated result', async () => {
    const inner = fakeInner({ km: 120, durationMin: 170, estimated: true });
    const cache = new InMemoryDistanceCacheRepo();
    const maps = new CachedMapsAdapter(inner, cache);
    const d = await maps.distance('Ella', 'Yala');
    expect(d!.estimated).toBe(true); // still returned to the caller, still flagged
    expect(await cache.get('ella', 'yala')).toBeNull();
  });

  it('never mints a row for a non-catalogue endpoint', async () => {
    const inner = fakeInner({ km: 12, durationMin: 20 });
    const cache = new InMemoryDistanceCacheRepo();
    const maps = new CachedMapsAdapter(inner, cache);
    await maps.distance('Ella', '6.01,80.25');
    expect(inner.calls).toBe(1);
    expect(await cache.all()).toHaveLength(0);
  });

  it('a cache write failure never fails the lookup', async () => {
    const inner = fakeInner({ km: 126, durationMin: 198 });
    const cache = new InMemoryDistanceCacheRepo();
    vi.spyOn(cache, 'upsert').mockRejectedValue(new Error('db down'));
    const maps = new CachedMapsAdapter(inner, cache);
    expect((await maps.distance('Ella', 'Yala'))!.km).toBe(126);
  });

  it('a cache read failure falls through to the inner adapter', async () => {
    const inner = fakeInner({ km: 126, durationMin: 198 });
    const cache = new InMemoryDistanceCacheRepo();
    vi.spyOn(cache, 'get').mockRejectedValue(new Error('db down'));
    const maps = new CachedMapsAdapter(inner, cache);
    expect((await maps.distance('Ella', 'Yala'))!.km).toBe(126);
    expect(inner.calls).toBe(1);
  });
});
