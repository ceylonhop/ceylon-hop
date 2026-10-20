import type { DistanceResult, MapsAdapter, RouteVariants } from './maps';
import type { UsageMeter } from '../services/usageMeter';

// Counts LIVE Google calls per method (spec 2026-10-13 §3) against the per-SKU monthly
// allowances. server.ts wraps the raw Google adapter with this INSIDE CachedMapsAdapter, so a
// distance-cache hit never reaches it and never counts. A call that throws is counted too —
// Google billed it. Optional methods are assigned conditionally, as CachedMapsAdapter does, so
// the wrapper reports them absent exactly when the inner adapter does.
export class MeteredMapsAdapter implements MapsAdapter {
  readonly provider: string;
  readonly geocode?: MapsAdapter['geocode'];
  readonly placeCandidates?: MapsAdapter['placeCandidates'];

  constructor(
    private readonly inner: MapsAdapter,
    private readonly meter: UsageMeter,
  ) {
    this.provider = inner.provider;
    if (inner.geocode) {
      this.geocode = (query: string) => this.count('maps.geocode', () => inner.geocode!(query));
    }
    if (inner.placeCandidates) {
      this.placeCandidates = (query: string) => this.count('maps.place_candidates', () => inner.placeCandidates!(query));
    }
  }

  distance(from: string, to: string): Promise<DistanceResult | null> {
    return this.count('maps.distance', () => this.inner.distance(from, to));
  }

  distanceVariants(from: string, to: string): Promise<RouteVariants | null> {
    return this.count('maps.route_variants', () => this.inner.distanceVariants(from, to));
  }

  places(q: string): ReturnType<MapsAdapter['places']> {
    return this.count('maps.places', () => this.inner.places(q));
  }

  private count<T>(key: string, call: () => Promise<T>): Promise<T> {
    this.meter.bump(key);
    return call();
  }
}
