// Cached road distances for catalogue-town pairs (spec 2026-08-12 §Distance cache). A price
// becomes a DB lookup instead of a billed Google call. Rows are DIRECTIONAL (A→B ≠ B→A: real
// routing differs by direction) and keyed on canonPlace() output, same as place_resolutions —
// key normalisation is what makes a cache actually hit.
//
// source is always 'google': an estimated (haversine-fallback) distance is never stored, so a
// Google outage can never poison the cache with approximations that then read as authoritative.
// There is no TTL — refresh is a manual, reviewable act (scripts/distance-report.ts --refresh).

export interface DistanceCacheRow {
  fromKey: string;
  toKey: string;
  km: number;
  durationMin: number;
  source: 'google';
  fetchedAt: Date;
}

export interface NewDistanceCacheRow {
  fromKey: string;
  toKey: string;
  km: number;
  durationMin: number;
}

export interface DistanceCacheRepo {
  get(fromKey: string, toKey: string): Promise<DistanceCacheRow | null>;
  upsert(row: NewDistanceCacheRow): Promise<DistanceCacheRow>;
  all(): Promise<DistanceCacheRow[]>;
}

export class InMemoryDistanceCacheRepo implements DistanceCacheRepo {
  private rows = new Map<string, DistanceCacheRow>();

  private key(from: string, to: string): string {
    return `${from}|${to}`;
  }

  async get(fromKey: string, toKey: string): Promise<DistanceCacheRow | null> {
    return this.rows.get(this.key(fromKey, toKey)) ?? null;
  }

  async upsert(r: NewDistanceCacheRow): Promise<DistanceCacheRow> {
    const row: DistanceCacheRow = { ...r, source: 'google', fetchedAt: new Date() };
    this.rows.set(this.key(r.fromKey, r.toKey), row);
    return row;
  }

  async all(): Promise<DistanceCacheRow[]> {
    return [...this.rows.values()];
  }
}
