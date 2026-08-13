import { describe, it, expect } from 'vitest';
import { liveRateCard } from './liveCard';
import { InMemoryZonesRepo, type NewZone } from '../db/zonesRepo';
import { RATE_CARD, type RateCard } from './rateCard';

// InMemoryZonesRepo takes no constructor seed — rows go in via create().
async function zonesWith(...seed: NewZone[]): Promise<InMemoryZonesRepo> {
  const repo = new InMemoryZonesRepo();
  for (const z of seed) await repo.create(z);
  return repo;
}

describe('liveRateCard', () => {
  it('attaches the active zones to the compiled card', async () => {
    const card = await liveRateCard(await zonesWith({ placeName: 'Ella', boostPct: 15 }));
    expect(card.hotZones).toHaveLength(1);
    expect(card.hotZones![0].placeName).toBe('Ella');
    expect(card.hotZones![0].boostPct).toBe(15);
    expect(card.version).toBe(RATE_CARD.version);
  });

  it('yields an empty zone list when none are active', async () => {
    const card = await liveRateCard(new InMemoryZonesRepo());
    expect(card.hotZones).toEqual([]);
  });

  it('omits an inactive zone', async () => {
    const card = await liveRateCard(await zonesWith({ placeName: 'Ella', boostPct: 15, active: false }));
    expect(card.hotZones).toEqual([]);
  });

  it('does not mutate the compiled card', async () => {
    await liveRateCard(await zonesWith({ placeName: 'Ella', boostPct: 15 }));
    expect((RATE_CARD as RateCard).hotZones).toBeUndefined();
  });
});
