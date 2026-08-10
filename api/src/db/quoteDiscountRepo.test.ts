// api/src/db/quoteDiscountRepo.test.ts
// Task 3 of docs/superpowers/plans/2026-08-09-founder-manual-discounts.md.
//
// This suite is exported so postgres.test.ts runs the SAME assertions against the real database.
// A fake that accepts states Postgres refuses is worse than no fake at all: every route test above
// it would then be testing a world that cannot exist.
import { describe, it, expect } from 'vitest';
import {
  InMemoryQuoteDiscountRepo,
  DiscountAlreadyActiveError,
  type QuoteDiscountRepo,
  type NewQuoteDiscount,
} from './quoteDiscountRepo';

export function makeDiscount(over: Partial<NewQuoteDiscount> = {}): NewQuoteDiscount {
  return {
    quoteId: '00000000-0000-0000-0000-000000000001',
    quoteRevision: 3,
    source: 'manual',
    method: 'fixed',
    value: 1000,
    reason: 'closing the Perera booking',
    subtotalBeforeCents: 20000,
    totalBeforeCents: 20000,
    requestedCents: 1000,
    appliedCents: 1000,
    totalAfterCents: 19000,
    capReason: null,
    estimatedCostCents: 17400,
    marginBeforeCents: 2600,
    marginAfterCents: 1600,
    appliedBy: 'founder@ceylonhop.com',
    ...over,
  };
}

/** Shared contract. Both the in-memory fake and PostgresQuoteDiscountRepo must satisfy it. */
export function quoteDiscountRepoContract(
  name: string,
  make: () => Promise<{ repo: QuoteDiscountRepo; quoteId: string }>,
): void {
  describe(name, () => {
    it('stores a discount and reads it back as the active one', async () => {
      const { repo, quoteId } = await make();
      const written = await repo.apply(makeDiscount({ quoteId }));
      expect(written.status).toBe('active');
      expect(written.supersededBy).toBeNull();

      const active = await repo.activeFor(quoteId);
      expect(active?.id).toBe(written.id);
      expect(active?.appliedCents).toBe(1000);
      // The whole point of the table: the money either side of the decision, verbatim.
      expect(active?.totalBeforeCents).toBe(20000);
      expect(active?.totalAfterCents).toBe(19000);
      expect(active?.reason).toBe('closing the Perera booking');
      expect(active?.appliedBy).toBe('founder@ceylonhop.com');
    });

    it('permits only ONE active discount per quote', async () => {
      const { repo, quoteId } = await make();
      await repo.apply(makeDiscount({ quoteId }));
      await expect(repo.apply(makeDiscount({ quoteId }))).rejects.toThrow();
    });

    it('supersedes on removal, recording who and when, and keeps the row', async () => {
      const { repo, quoteId } = await make();
      const first = await repo.apply(makeDiscount({ quoteId }));
      const ended = await repo.supersede(quoteId, 'removed', 'founder@ceylonhop.com');

      expect(ended?.id).toBe(first.id);
      expect(ended?.status).toBe('removed');
      expect(ended?.supersededBy).toBe('founder@ceylonhop.com');
      expect(ended?.supersededAt).toBeInstanceOf(Date);
      expect(await repo.activeFor(quoteId)).toBeNull();
      // Removed, but never gone — that is the audit trail.
      expect(await repo.historyFor(quoteId)).toHaveLength(1);
    });

    it('allows a replacement once the previous one is superseded', async () => {
      const { repo, quoteId } = await make();
      await repo.apply(makeDiscount({ quoteId, appliedCents: 1000 }));
      await repo.supersede(quoteId, 'replaced', 'founder@ceylonhop.com');
      await repo.apply(makeDiscount({ quoteId, appliedCents: 2500, requestedCents: 2500 }));

      const active = await repo.activeFor(quoteId);
      expect(active?.appliedCents).toBe(2500);
      const history = await repo.historyFor(quoteId);
      expect(history).toHaveLength(2);
      expect(history[0].appliedCents).toBe(2500); // newest first
      expect(history[1].status).toBe('replaced');
    });

    it('returns null rather than throwing when there is nothing to supersede', async () => {
      const { repo, quoteId } = await make();
      expect(await repo.supersede(quoteId, 'removed', 'founder@ceylonhop.com')).toBeNull();
    });

    it('records a percentage request and which limit bound it', async () => {
      const { repo, quoteId } = await make();
      await repo.apply(makeDiscount({
        quoteId, method: 'percentage', value: 5000,
        requestedCents: 10000, appliedCents: 6000, capReason: 'percentage_cap',
        totalAfterCents: 14000,
      }));
      const active = await repo.activeFor(quoteId);
      expect(active?.method).toBe('percentage');
      expect(active?.value).toBe(5000);
      // Asked for half, allowed 30% — the pair a founder needs to see.
      expect(active?.requestedCents).toBe(10000);
      expect(active?.appliedCents).toBe(6000);
      expect(active?.capReason).toBe('percentage_cap');
    });

    it('accepts a zero-cent outcome, so a fully-capped attempt is still on the record', async () => {
      const { repo, quoteId } = await make();
      await repo.apply(makeDiscount({
        quoteId, requestedCents: 2000, appliedCents: 0,
        capReason: 'vehicle_minimum', totalAfterCents: 20000,
      }));
      const active = await repo.activeFor(quoteId);
      expect(active?.appliedCents).toBe(0);
      expect(active?.capReason).toBe('vehicle_minimum');
    });

    it('keeps history per quote', async () => {
      const { repo, quoteId } = await make();
      await repo.apply(makeDiscount({ quoteId }));
      expect(await repo.historyFor('00000000-0000-0000-0000-0000000000ff')).toHaveLength(0);
    });
  });
}

quoteDiscountRepoContract('InMemoryQuoteDiscountRepo', async () => ({
  repo: new InMemoryQuoteDiscountRepo(),
  quoteId: '00000000-0000-0000-0000-000000000001',
}));

describe('InMemoryQuoteDiscountRepo specifics', () => {
  it('throws the named error, so callers can map it to a 409', async () => {
    const repo = new InMemoryQuoteDiscountRepo();
    await repo.apply(makeDiscount());
    await expect(repo.apply(makeDiscount())).rejects.toBeInstanceOf(DiscountAlreadyActiveError);
  });
});
