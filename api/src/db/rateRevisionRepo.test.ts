import { describe, it, expect } from 'vitest';
import { InMemoryRateRevisionRepo, StaleRatesError } from './rateRevisionRepo';
import { ratesFromCard } from '../quote/rateRevision';
import { RATE_CARD } from '../quote/rateCard';

const RATES = ratesFromCard(RATE_CARD);

describe('InMemoryRateRevisionRepo', () => {
  it('starts empty: no latest, no history', async () => {
    const repo = new InMemoryRateRevisionRepo();
    expect(await repo.latest()).toBeNull();
    expect(await repo.list()).toEqual([]);
  });

  it('appends: each save is a new numbered row, the newest is latest, history is newest first', async () => {
    const repo = new InMemoryRateRevisionRepo();
    const a = await repo.create({ rates: RATES, baseVersion: null, createdBy: 'f@x.com' }, new Date('2026-09-27T08:00:00Z'));
    const b = await repo.create({ rates: { ...RATES, bufferPct: 12 }, baseVersion: a.version, createdBy: 'f@x.com' }, new Date('2026-09-28T08:00:00Z'));
    expect([a.seq, a.version, b.seq, b.version]).toEqual([1, '2026-09-27.1', 2, '2026-09-28.2']);
    expect(await repo.latest()).toEqual(b);
    expect((await repo.list()).map((r) => r.version)).toEqual(['2026-09-28.2', '2026-09-27.1']);
    expect(a.revertedToVersion).toBeNull();
  });

  it('refuses a save from a stale base and names what is current', async () => {
    const repo = new InMemoryRateRevisionRepo();
    const a = await repo.create({ rates: RATES, baseVersion: null, createdBy: 'f@x.com' });
    const err = await repo.create({ rates: RATES, baseVersion: null, createdBy: 'f@x.com' }).catch((e) => e);
    expect(err).toBeInstanceOf(StaleRatesError);
    expect((err as StaleRatesError).current?.id).toBe(a.id);
  });

  it('keeps its own copy of the rates', async () => {
    const repo = new InMemoryRateRevisionRepo();
    const rates = ratesFromCard(RATE_CARD);
    await repo.create({ rates, baseVersion: null, createdBy: 'f@x.com' });
    rates.perKmCents.car = 1;
    expect((await repo.latest())!.rates.perKmCents.car).toBe(40.25);
  });
});
