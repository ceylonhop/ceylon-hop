import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryZonesRepo } from './zonesRepo';

afterEach(() => {
  delete process.env.HOT_ZONES_DISABLED;
});

describe('InMemoryZonesRepo', () => {
  it('activeZones returns only active rows, mapped to HotZone', async () => {
    const repo = new InMemoryZonesRepo();
    await repo.create({ placeName: 'Ella', boostPct: 15 });
    await repo.create({ placeName: 'Galle', boostPct: 10, active: false });
    const active = await repo.activeZones();
    expect(active).toEqual([{ placeName: 'Ella', boostPct: 15, active: true }]);
  });

  it('carries the geo trio only when fully present', async () => {
    const repo = new InMemoryZonesRepo();
    await repo.create({ placeName: 'Ella', boostPct: 15, lat: 6.87, lng: 81.05, radiusKm: 10 });
    expect((await repo.activeZones())[0]).toMatchObject({ lat: 6.87, lng: 81.05, radiusKm: 10 });
  });

  it('HOT_ZONES_DISABLED kill switch ⇒ activeZones() is [] (data untouched)', async () => {
    const repo = new InMemoryZonesRepo();
    await repo.create({ placeName: 'Ella', boostPct: 15 });
    process.env.HOT_ZONES_DISABLED = '1';
    expect(await repo.activeZones()).toEqual([]);
    expect(await repo.list()).toHaveLength(1); // rows still there — one env flip, no data loss
  });

  it('patch merges partial fields; remove is idempotent-ish', async () => {
    const repo = new InMemoryZonesRepo();
    const z = await repo.create({ placeName: 'Ella', boostPct: 15 });
    const p = await repo.patch(z.id, { boostPct: 30 });
    expect(p?.boostPct).toBe(30);
    expect(p?.placeName).toBe('Ella');
    expect(await repo.remove(z.id)).toBe(true);
    expect(await repo.remove(z.id)).toBe(false);
    expect(await repo.patch(z.id, { boostPct: 5 })).toBeNull();
  });
});
