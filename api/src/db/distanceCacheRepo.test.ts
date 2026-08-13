import { describe, it, expect } from 'vitest';
import { InMemoryDistanceCacheRepo, type DistanceCacheRepo } from './distanceCacheRepo';

// Shared contract — postgres.test.ts runs this same suite against PostgresDistanceCacheRepo.
export function distanceCacheRepoContract(makeRepo: () => Promise<DistanceCacheRepo>): void {
  it('misses on an unknown pair', async () => {
    const repo = await makeRepo();
    expect(await repo.get('ella', 'yala')).toBeNull();
  });

  it('stores and retrieves a directional pair', async () => {
    const repo = await makeRepo();
    await repo.upsert({ fromKey: 'ella', toKey: 'yala', km: 126, durationMin: 198 });
    const hit = await repo.get('ella', 'yala');
    expect(hit).not.toBeNull();
    expect(hit!.km).toBe(126);
    expect(hit!.durationMin).toBe(198);
    expect(hit!.source).toBe('google');
    // Directional: the reverse pair is a MISS, not a mirror (spec: real routing differs by direction).
    expect(await repo.get('yala', 'ella')).toBeNull();
  });

  it('upsert overwrites the same pair instead of duplicating', async () => {
    const repo = await makeRepo();
    await repo.upsert({ fromKey: 'ella', toKey: 'yala', km: 126, durationMin: 198 });
    await repo.upsert({ fromKey: 'ella', toKey: 'yala', km: 130, durationMin: 205 });
    expect((await repo.get('ella', 'yala'))!.km).toBe(130);
    expect(await repo.all()).toHaveLength(1);
  });
}

describe('InMemoryDistanceCacheRepo', () => {
  distanceCacheRepoContract(async () => new InMemoryDistanceCacheRepo());
});
