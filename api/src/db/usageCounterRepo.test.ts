import { describe, it, expect } from 'vitest';
import { InMemoryUsageCounterRepo, type UsageCounterRepo } from './usageCounterRepo';

// Shared contract — postgres.test.ts runs this same suite against PostgresUsageCounterRepo.
// One row per (UTC day, key); add() is an upsert that ADDS, so two writers never lose a count.
export function usageCounterRepoContract(makeRepo: () => Promise<UsageCounterRepo>): void {
  it('is empty until something is counted', async () => {
    const repo = await makeRepo();
    expect(await repo.range('2026-10-01', '2026-10-31')).toEqual([]);
  });

  it('add() creates the row, then adds to it', async () => {
    const repo = await makeRepo();
    await repo.add('2026-10-13', 'email.sent', 2);
    await repo.add('2026-10-13', 'email.sent', 3);
    await repo.add('2026-10-13', 'maps.distance', 1);
    expect(await repo.range('2026-10-13', '2026-10-13')).toEqual([
      { day: '2026-10-13', key: 'email.sent', n: 5 },
      { day: '2026-10-13', key: 'maps.distance', n: 1 },
    ]);
  });

  it('range() is inclusive at both ends and ordered by day then key', async () => {
    const repo = await makeRepo();
    await repo.add('2026-10-12', 'email.sent', 1);
    await repo.add('2026-10-13', 'email.sent', 1);
    await repo.add('2026-10-14', 'email.sent', 1);
    await repo.add('2026-10-15', 'email.sent', 1);
    const rows = await repo.range('2026-10-13', '2026-10-14');
    expect(rows.map((r) => r.day)).toEqual(['2026-10-13', '2026-10-14']);
  });
}

describe('InMemoryUsageCounterRepo', () => {
  usageCounterRepoContract(async () => new InMemoryUsageCounterRepo());
});
