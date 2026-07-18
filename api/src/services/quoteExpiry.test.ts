import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { expireStaleQuotes, SENT_QUOTE_TTL_MS } from './quoteExpiry';
import { InMemoryQuoteRepo, type NewQuote, type QuotePatch } from '../db/quoteRepo';

const NOW = new Date('2026-07-17T12:00:00Z');
const DAY = 24 * 3600 * 1000;

const sample = (over: Partial<NewQuote> = {}): NewQuote => ({
  channel: 'ops',
  product: 'private',
  vehicle: 'car',
  customerName: 'Maya',
  customerContact: '+34600',
  totalCents: 4048,
  currency: 'USD',
  rateCardVersion: '2026-06-28',
  request: { product: 'private' },
  result: { totalCents: 4048 },
  ...over,
});

// Save a quote then stamp it 'sent' at `sentAt`. The in-memory repo stamps sentAt from the
// clock, so we fake the clock to the send moment, patch, then restore it to NOW.
async function sentQuote(repo: InMemoryQuoteRepo, sentAt: Date, over: Partial<NewQuote> = {}) {
  const q = await repo.save(sample(over));
  vi.setSystemTime(sentAt);
  await repo.patch(q.id, { status: 'sent' });
  vi.setSystemTime(NOW);
  return q;
}

describe('expireStaleQuotes', () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  it('expires an ops sent quote idle past the TTL and stamps decidedAt', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await sentQuote(repo, new Date(NOW.getTime() - SENT_QUOTE_TTL_MS - DAY));

    const r = await expireStaleQuotes(NOW, { quotes: repo });

    expect(r.expired).toBe(1);
    const after = await repo.get(q.id);
    expect(after?.status).toBe('expired');
    expect(after?.decidedAt).toBeInstanceOf(Date);
  });

  it('leaves a freshly-sent quote (still within the TTL) untouched', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await sentQuote(repo, new Date(NOW.getTime() - SENT_QUOTE_TTL_MS + DAY));

    const r = await expireStaleQuotes(NOW, { quotes: repo });

    expect(r.expired).toBe(0);
    expect((await repo.get(q.id))?.status).toBe('sent');
  });

  it('ignores non-sent ops quotes and web quotes, however old', async () => {
    const repo = new InMemoryQuoteRepo();
    const old = new Date(NOW.getTime() - SENT_QUOTE_TTL_MS - 10 * DAY);

    const draft = await repo.save(sample()); // never sent
    const ready = await repo.save(sample());
    vi.setSystemTime(old);
    await repo.patch(ready.id, { status: 'ready' });
    vi.setSystemTime(NOW);
    const won = await sentQuote(repo, old);
    await repo.patch(won.id, { status: 'won' });
    const web = await sentQuote(repo, old, { channel: 'web' }); // rate-lock owns the web clock

    const r = await expireStaleQuotes(NOW, { quotes: repo });

    expect(r.expired).toBe(0);
    expect((await repo.get(draft.id))?.status).toBe('draft');
    expect((await repo.get(ready.id))?.status).toBe('ready');
    expect((await repo.get(won.id))?.status).toBe('won');
    expect((await repo.get(web.id))?.status).toBe('sent');
  });

  it('is idempotent across ticks', async () => {
    const repo = new InMemoryQuoteRepo();
    await sentQuote(repo, new Date(NOW.getTime() - SENT_QUOTE_TTL_MS - DAY));

    const r1 = await expireStaleQuotes(NOW, { quotes: repo });
    const r2 = await expireStaleQuotes(NOW, { quotes: repo });

    expect(r1.expired).toBe(1);
    expect(r2.expired).toBe(0);
  });

  it('sweeps the rest when one quote fails to patch (per-row best-effort)', async () => {
    const repo = new InMemoryQuoteRepo();
    const bad = await sentQuote(repo, new Date(NOW.getTime() - SENT_QUOTE_TTL_MS - DAY));
    const good = await sentQuote(repo, new Date(NOW.getTime() - SENT_QUOTE_TTL_MS - 2 * DAY));
    const realPatch = repo.patch.bind(repo);
    vi.spyOn(repo, 'patch').mockImplementation((id: string, patch: QuotePatch) => {
      if (id === bad.id) throw new Error('boom');
      return realPatch(id, patch);
    });

    const r = await expireStaleQuotes(NOW, { quotes: repo });

    expect(r.expired).toBe(1);
    expect((await realPatch(good.id, {}))?.status).toBe('expired');
  });
});
