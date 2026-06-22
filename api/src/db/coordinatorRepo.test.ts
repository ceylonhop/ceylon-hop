import { describe, it, expect } from 'vitest';
import { InMemoryCoordinatorRepo } from './coordinatorRepo';

describe('InMemoryCoordinatorRepo', () => {
  it('creates and reads back a coordinator (active by default)', async () => {
    const repo = new InMemoryCoordinatorRepo();
    const c = await repo.create({ name: 'Nuwan', whatsapp: '+94770000000', regions: 'South coast' });
    expect(c.id).toBeTruthy();
    expect(c.active).toBe(true);
    expect((await repo.get(c.id))?.name).toBe('Nuwan');
  });
  it('lists coordinators, newest-first, with an active-only filter', async () => {
    const repo = new InMemoryCoordinatorRepo();
    await repo.create({ name: 'A', whatsapp: '1' });
    await repo.create({ name: 'B', whatsapp: '2' });
    expect((await repo.list()).map((c) => c.name)).toEqual(['B', 'A']);
    expect(await repo.list({ activeOnly: true })).toHaveLength(2);
  });
});
