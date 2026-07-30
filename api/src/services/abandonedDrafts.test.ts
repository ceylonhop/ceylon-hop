import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sweepAbandonedDrafts, ABANDONED_DRAFT_TTL_MS } from './abandonedDrafts';
import { InMemoryQuoteRepo, type NewQuote } from '../db/quoteRepo';

const NOW = new Date('2026-07-29T06:00:00Z');
const HOUR = 3600 * 1000;

const shell = (over: Partial<NewQuote> = {}): NewQuote => ({
  channel: 'ops',
  product: 'private',
  totalCents: 0,
  currency: 'USD',
  rateCardVersion: 'v',
  request: { shell: true },
  result: { shell: true },
  ...over,
});
const priced = (over: Partial<NewQuote> = {}): NewQuote => ({
  ...shell(),
  totalCents: 4048,
  request: { tool: {}, engine: {} },
  result: { totalCents: 4048 },
  ...over,
});

// The in-memory repo stamps createdAt/updatedAt from the clock, so create the row at `at`
// and then restore the clock to NOW.
async function savedAt(repo: InMemoryQuoteRepo, at: Date, q: NewQuote) {
  vi.setSystemTime(at);
  const row = await repo.save(q);
  vi.setSystemTime(NOW);
  return row;
}

describe('sweepAbandonedDrafts', () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  it('soft-deletes an unpriced draft untouched past the TTL', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await savedAt(repo, new Date(NOW.getTime() - ABANDONED_DRAFT_TTL_MS - HOUR), shell());

    expect(await sweepAbandonedDrafts(NOW, { quotes: repo })).toEqual({ swept: 1 });
    expect(await repo.get(q.id)).toBeNull(); // get() hides soft-deleted rows
  });

  it('stamps the sweep as the deleting actor', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await savedAt(repo, new Date(NOW.getTime() - ABANDONED_DRAFT_TTL_MS - HOUR), shell());
    const spy = vi.spyOn(repo, 'softDelete');

    await sweepAbandonedDrafts(NOW, { quotes: repo });

    expect(spy).toHaveBeenCalledWith(q.id, 'system:draft-cleanup');
  });

  it('spares an unpriced draft younger than the TTL', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await savedAt(repo, new Date(NOW.getTime() - HOUR), shell());
    expect(await sweepAbandonedDrafts(NOW, { quotes: repo })).toEqual({ swept: 0 });
    expect(await repo.get(q.id)).not.toBeNull();
  });

  it('spares a priced draft of any age', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await savedAt(repo, new Date(NOW.getTime() - 30 * 24 * HOUR), priced());
    expect(await sweepAbandonedDrafts(NOW, { quotes: repo })).toEqual({ swept: 0 });
    expect(await repo.get(q.id)).not.toBeNull();
  });

  it('spares an old shell that was touched inside the window', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await savedAt(repo, new Date(NOW.getTime() - 5 * 24 * HOUR), shell());
    await repo.patch(q.id, { internalNotes: 'called back' }); // bumps updatedAt to NOW
    expect(await sweepAbandonedDrafts(NOW, { quotes: repo })).toEqual({ swept: 0 });
    expect(await repo.get(q.id)).not.toBeNull();
  });

  it('sweeps an assigned shell — assignment does not grant immortality', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await savedAt(
      repo,
      new Date(NOW.getTime() - ABANDONED_DRAFT_TTL_MS - HOUR),
      shell({ assignedTo: 'op@x.com' }),
    );
    expect(await sweepAbandonedDrafts(NOW, { quotes: repo })).toEqual({ swept: 1 });
    expect(await repo.get(q.id)).toBeNull();
  });

  it('keeps going when one row fails to delete', async () => {
    const repo = new InMemoryQuoteRepo();
    const old = new Date(NOW.getTime() - ABANDONED_DRAFT_TTL_MS - HOUR);
    const a = await savedAt(repo, old, shell());
    const b = await savedAt(repo, old, shell());
    const real = repo.softDelete.bind(repo);
    vi.spyOn(repo, 'softDelete').mockImplementation(async (id, by) => {
      if (id === a.id) throw new Error('boom');
      return real(id, by);
    });

    expect(await sweepAbandonedDrafts(NOW, { quotes: repo })).toEqual({ swept: 1 });
    expect(await repo.get(b.id)).toBeNull();
  });
});
