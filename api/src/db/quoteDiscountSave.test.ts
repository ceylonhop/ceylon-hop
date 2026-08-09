// api/src/db/quoteDiscountSave.test.ts
// Task 4 of docs/superpowers/plans/2026-08-09-founder-manual-discounts.md — the tri-state
// discount intent on an Ops save.
//
// These cover the SHAPE of the intent against the in-memory fake. The atomicity itself — a failed
// discount write taking the whole save down — is only a real property in Postgres, and is asserted
// in postgres.test.ts where a real transaction exists.
import { describe, it, expect } from 'vitest';
import { InMemoryQuoteRepo, type NewQuote } from './quoteRepo';
import { InMemoryQuoteDiscountRepo } from './quoteDiscountRepo';

const FOUNDER = 'founder@ceylonhop.com';

const quoteInput = (totalCents: number): NewQuote => ({
  product: 'private',
  vehicle: 'car',
  customerName: 'Maya',
  totalCents,
  currency: 'USD',
  rateCardVersion: '2026-07-14',
  request: { product: 'private', legs: [{ from: 'A', to: 'B', distanceKm: 80 + totalCents / 1000 }] },
  result: { totalCents, lineItems: [] },
});

const discountRow = (applied: number) => ({
  source: 'manual' as const,
  method: 'fixed' as const,
  value: applied,
  reason: 'closing the deal',
  subtotalBeforeCents: 20000,
  totalBeforeCents: 20000,
  requestedCents: applied,
  appliedCents: applied,
  totalAfterCents: 20000 - applied,
  capReason: null,
  estimatedCostCents: 17400,
  marginBeforeCents: 2600,
  marginAfterCents: 2600 - applied,
  appliedBy: FOUNDER,
});

async function setup() {
  const discounts = new InMemoryQuoteDiscountRepo();
  const quotes = new InMemoryQuoteRepo(discounts);
  const q = await quotes.save(quoteInput(20000));
  return { quotes, discounts, id: q.id };
}

describe('Ops save — tri-state discount intent', () => {
  it('applies a discount alongside the content write', async () => {
    const { quotes, discounts, id } = await setup();
    await quotes.update(id, quoteInput(19000), { kind: 'apply', by: FOUNDER, row: discountRow(1000) });

    const active = await discounts.activeFor(id);
    expect(active?.appliedCents).toBe(1000);
    expect(active?.appliedBy).toBe(FOUNDER);
  });

  it('stamps the discount with the revision the save PRODUCED, not the one it replaced', async () => {
    const { quotes, discounts, id } = await setup();
    const before = (await quotes.get(id))!.revision;
    const after = await quotes.update(id, quoteInput(19000), { kind: 'apply', by: FOUNDER, row: discountRow(1000) });

    expect(after!.revision).toBe(before + 1);
    // The discount belongs to the state being written, not the one being superseded.
    expect((await discounts.activeFor(id))?.quoteRevision).toBe(after!.revision);
  });

  it('PRESERVES an existing discount when intent is omitted', async () => {
    const { quotes, discounts, id } = await setup();
    await quotes.update(id, quoteInput(19000), { kind: 'apply', by: FOUNDER, row: discountRow(1000) });
    // An ordinary content save — autosave, a note edit — must not disturb the discount.
    await quotes.update(id, quoteInput(18500));

    expect((await discounts.activeFor(id))?.appliedCents).toBe(1000);
    expect(await discounts.historyFor(id)).toHaveLength(1);
  });

  it('removes on explicit intent, and keeps the row with its remover', async () => {
    const { quotes, discounts, id } = await setup();
    await quotes.update(id, quoteInput(19000), { kind: 'apply', by: FOUNDER, row: discountRow(1000) });
    await quotes.update(id, quoteInput(20000), { kind: 'remove', by: FOUNDER });

    expect(await discounts.activeFor(id)).toBeNull();
    const history = await discounts.historyFor(id);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('removed');
    expect(history[0].supersededBy).toBe(FOUNDER);
  });

  it('replaces by superseding first, so the unique index is never challenged', async () => {
    const { quotes, discounts, id } = await setup();
    await quotes.update(id, quoteInput(19000), { kind: 'apply', by: FOUNDER, row: discountRow(1000) });
    await quotes.update(id, quoteInput(17500), { kind: 'apply', by: FOUNDER, row: discountRow(2500) });

    expect((await discounts.activeFor(id))?.appliedCents).toBe(2500);
    const history = await discounts.historyFor(id);
    expect(history).toHaveLength(2);
    expect(history[0].appliedCents).toBe(2500);
    expect(history[1].status).toBe('replaced');
  });

  it('leaves a quote with no discount repo wired completely unaffected', async () => {
    // Every pre-existing test constructs a bare InMemoryQuoteRepo; none may break.
    const quotes = new InMemoryQuoteRepo();
    const q = await quotes.save(quoteInput(20000));
    const updated = await quotes.update(q.id, quoteInput(19000), { kind: 'apply', by: FOUNDER, row: discountRow(1000) });
    expect(updated?.totalCents).toBe(19000);
  });
});
