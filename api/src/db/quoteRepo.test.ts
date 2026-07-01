import { describe, it, expect } from 'vitest';
import { InMemoryQuoteRepo, type NewQuote } from './quoteRepo';

const sample = (over: Partial<NewQuote> = {}): NewQuote => ({
  product: 'private',
  vehicle: 'car',
  customerName: 'Maya',
  customerContact: '+34600',
  totalCents: 4048,
  currency: 'USD',
  rateCardVersion: '2026-06-28',
  marginCents: 900,
  request: { product: 'private', legs: [{ from: 'A', to: 'B', distanceKm: 80 }] },
  result: { totalCents: 4048 },
  ...over,
});

describe('InMemoryQuoteRepo', () => {
  it('save assigns id, a Q- reference, draft status, and timestamps', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    expect(q.id).toMatch(/[0-9a-f-]{36}/);
    expect(q.reference).toMatch(/^Q-[0-9A-Z]{4}$/);
    expect(q.status).toBe('draft');
    expect(q.channel).toBe('ops');
    expect(q.totalCents).toBe(4048);
    expect(q.request).toEqual(sample().request);
    expect(q.createdAt).toBeInstanceOf(Date);
    expect(q.sentAt).toBeNull();
    expect(q.decidedAt).toBeNull();
    expect(q.convertedBookingId).toBeNull();
  });

  it('get returns a saved quote and null for unknown ids', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    expect((await repo.get(q.id))?.reference).toBe(q.reference);
    expect(await repo.get('nope')).toBeNull();
  });

  it('list returns newest first and filters by status and product', async () => {
    const repo = new InMemoryQuoteRepo();
    const a = await repo.save(sample({ product: 'private' }));
    const b = await repo.save(sample({ product: 'chauffeur' }));
    await repo.patch(b.id, { status: 'won' });
    const all = await repo.list();
    expect(all.map((r) => r.id)).toEqual([b.id, a.id]); // newest first
    expect((await repo.list({ product: 'chauffeur' })).map((r) => r.id)).toEqual([b.id]);
    expect((await repo.list({ status: 'won' })).map((r) => r.id)).toEqual([b.id]);
    expect((await repo.list({ status: 'draft' })).map((r) => r.id)).toEqual([a.id]);
  });

  it('patch updates status, stamps sent_at then decided_at, and records lost_reason', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    const sent = await repo.patch(q.id, { status: 'sent' });
    expect(sent?.status).toBe('sent');
    expect(sent?.sentAt).toBeInstanceOf(Date);
    expect(sent?.decidedAt).toBeNull();
    const lost = await repo.patch(q.id, { status: 'lost', lostReason: 'too expensive' });
    expect(lost?.status).toBe('lost');
    expect(lost?.sentAt).toBeInstanceOf(Date); // preserved
    expect(lost?.decidedAt).toBeInstanceOf(Date);
    expect(lost?.lostReason).toBe('too expensive');
  });

  it('patch returns null for an unknown id', async () => {
    expect(await new InMemoryQuoteRepo().patch('nope', { status: 'won' })).toBeNull();
  });
});
