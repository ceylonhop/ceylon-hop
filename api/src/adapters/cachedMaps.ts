import { canonPlace, isCatalogTown, type DistanceResult, type MapsAdapter, type RouteVariants } from './maps';
import type { DistanceCacheRepo } from '../db/distanceCacheRepo';

// Persistent distance cache over a MapsAdapter (spec 2026-08-12 §Distance cache) — the
// durable sibling of bookings.ts's per-request memoizeDistance. Only distance() is cached:
// places() is autocomplete and distanceVariants() is the route-choice comparison, both
// interactive and rare.
//
// Cache policy, enforced here rather than trusted to callers:
//   • hit  → return it, no billed call, no `estimated` flag (cached rows are real routing);
//   • miss → inner adapter; write back ONLY a non-estimated result between catalogue towns;
//   • the cache failing (read or write) degrades to the inner adapter, never to an error —
//     a broken cache must cost money, not bookings.
export class CachedMapsAdapter implements MapsAdapter {
  readonly provider: string;

  constructor(
    private readonly inner: MapsAdapter,
    private readonly cache: DistanceCacheRepo,
  ) {
    this.provider = inner.provider;
  }

  places(q: string): ReturnType<MapsAdapter['places']> {
    return this.inner.places(q);
  }

  distanceVariants(from: string, to: string): Promise<RouteVariants | null> {
    return this.inner.distanceVariants(from, to);
  }

  async distance(from: string, to: string): Promise<DistanceResult | null> {
    const fromKey = canonPlace(from);
    const toKey = canonPlace(to);
    try {
      const hit = await this.cache.get(fromKey, toKey);
      if (hit) return { km: hit.km, durationMin: hit.durationMin };
    } catch {
      /* cache down — fall through to the inner adapter */
    }
    const live = await this.inner.distance(from, to);
    if (live && !live.estimated && isCatalogTown(from) && isCatalogTown(to)) {
      try {
        await this.cache.upsert({ fromKey, toKey, km: live.km, durationMin: live.durationMin });
      } catch {
        /* a failed write must never fail the lookup */
      }
    }
    return live;
  }
}
