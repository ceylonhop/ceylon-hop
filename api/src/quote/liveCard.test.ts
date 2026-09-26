import { describe, it, expect } from 'vitest';
import { liveRateCard, currentRateCard } from './liveCard';
import { InMemoryZonesRepo, type NewZone } from '../db/zonesRepo';
import { InMemoryRateRevisionRepo } from '../db/rateRevisionRepo';
import { RATE_CARD, type RateCard } from './rateCard';
import { ratesFromCard, applyRates } from './rateRevision';

// InMemoryZonesRepo takes no constructor seed — rows go in via create().
async function zonesWith(...seed: NewZone[]): Promise<InMemoryZonesRepo> {
  const repo = new InMemoryZonesRepo();
  for (const z of seed) await repo.create(z);
  return repo;
}

describe('liveRateCard', () => {
  it('attaches the active zones to the compiled card', async () => {
    const card = await liveRateCard(await zonesWith({ placeName: 'Ella', boostPct: 15 }), new InMemoryRateRevisionRepo());
    expect(card.hotZones).toHaveLength(1);
    expect(card.hotZones![0].placeName).toBe('Ella');
    expect(card.hotZones![0].boostPct).toBe(15);
    expect(card.version).toBe(RATE_CARD.version);
  });

  it('yields an empty zone list when none are active', async () => {
    const card = await liveRateCard(new InMemoryZonesRepo(), new InMemoryRateRevisionRepo());
    expect(card.hotZones).toEqual([]);
  });

  it('omits an inactive zone', async () => {
    const card = await liveRateCard(await zonesWith({ placeName: 'Ella', boostPct: 15, active: false }), new InMemoryRateRevisionRepo());
    expect(card.hotZones).toEqual([]);
  });

  it('does not mutate the compiled card', async () => {
    await liveRateCard(await zonesWith({ placeName: 'Ella', boostPct: 15 }), new InMemoryRateRevisionRepo());
    expect((RATE_CARD as RateCard).hotZones).toBeUndefined();
  });
});

describe('liveRateCard with founder revisions (spec 2026-09-26 §8.2)', () => {
  it('no revision ⇒ the code card exactly, plus zones', async () => {
    const card = await liveRateCard(new InMemoryZonesRepo(), new InMemoryRateRevisionRepo());
    expect(card).toEqual({ ...RATE_CARD, hotZones: [] });
  });

  it('the newest revision replaces the editable set and names the version; zones still ride on top', async () => {
    const revisions = new InMemoryRateRevisionRepo();
    const rates = ratesFromCard(RATE_CARD);
    const a = await revisions.create({ rates: { ...rates, bufferPct: 11 }, baseVersion: null, createdBy: 'f@x.com' }, new Date('2026-09-27T08:00:00Z'));
    await revisions.create({ rates: { ...rates, perKmCents: { ...rates.perKmCents, car: 45 } }, baseVersion: a.version, createdBy: 'f@x.com' }, new Date('2026-09-27T09:00:00Z'));
    const card = await liveRateCard(await zonesWith({ placeName: 'Ella', boostPct: 15 }), revisions);
    expect(card.version).toBe('2026-09-27.2');
    expect(card.perKmCents.car).toBe(45);
    expect(card.bufferPct).toBe(RATE_CARD.bufferPct); // the newest row is the whole set, not a delta
    expect(card.hotZones).toHaveLength(1);
    expect(await currentRateCard(revisions)).toEqual(applyRates(RATE_CARD, (await revisions.latest())!.rates, '2026-09-27.2'));
  });
});
