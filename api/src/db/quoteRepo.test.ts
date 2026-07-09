import { describe, it, expect, vi } from 'vitest';
import { InMemoryQuoteRepo, genReference, parseDateFilter, canTransition, type NewQuote } from './quoteRepo';

describe('canTransition (quote review lifecycle)', () => {
  it('allows the maker-checker path and founder self-approve', () => {
    expect(canTransition('draft', 'pending_review')).toBe(true);
    expect(canTransition('draft', 'ready')).toBe(true); // self-approve (capability-gated at the route)
    expect(canTransition('pending_review', 'ready')).toBe(true);
    expect(canTransition('pending_review', 'changes_requested')).toBe(true);
    expect(canTransition('changes_requested', 'pending_review')).toBe(true);
    expect(canTransition('ready', 'sent')).toBe(true);
    expect(canTransition('ready', 'draft')).toBe(true); // reopen to edit
  });
  it('rejects skipping the review gate', () => {
    expect(canTransition('draft', 'sent')).toBe(false);
    expect(canTransition('pending_review', 'sent')).toBe(false);
    expect(canTransition('sent', 'ready')).toBe(false);
  });
  it('allows an outcome flip from any live state, not from draft', () => {
    for (const s of ['pending_review', 'ready', 'sent'] as const) expect(canTransition(s, 'lost')).toBe(true);
    expect(canTransition('draft', 'won')).toBe(false);
  });
});

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
    expect(q.reference).toMatch(/^Q-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
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
    expect(all.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect((await repo.list({ product: 'chauffeur' })).map((r) => r.id)).toEqual([b.id]);
    expect((await repo.list({ status: 'won' })).map((r) => r.id)).toEqual([b.id]);
    expect((await repo.list({ status: 'draft' })).map((r) => r.id)).toEqual([a.id]);
  });

  it('list orders by createdAt desc, then reference desc as a deterministic tiebreak', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-15T10:00:00.000Z'));
      const repo = new InMemoryQuoteRepo();
      // Both saves happen at the exact same fake instant, forcing a real createdAt tie.
      const a = await repo.save(sample());
      const b = await repo.save(sample());
      expect(a.createdAt.getTime()).toBe(b.createdAt.getTime());

      const expected = [a, b].sort((x, y) => (x.reference < y.reference ? 1 : -1)).map((r) => r.id);
      const first = await repo.list();
      const second = await repo.list();
      expect(first.map((r) => r.id)).toEqual(expected);
      expect(second.map((r) => r.id)).toEqual(expected); // stable across repeated calls
    } finally {
      vi.useRealTimers();
    }
  });

  it('genReference produces a Q- reference from the unambiguous 5-char alphabet', () => {
    for (let i = 0; i < 50; i++) {
      expect(genReference()).toMatch(/^Q-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
    }
  });

  it('save never produces a duplicate reference across many inserts', async () => {
    const repo = new InMemoryQuoteRepo();
    const refs = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const q = await repo.save(sample());
      expect(refs.has(q.reference)).toBe(false);
      refs.add(q.reference);
    }
    expect(refs.size).toBe(200);
  });

  it('parseDateFilter treats a date-only "to" as inclusive of the whole UTC day', () => {
    const from = parseDateFilter('2026-07-01', 'from');
    const to = parseDateFilter('2026-07-01', 'to');
    expect(from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-07-01T23:59:59.999Z');
  });

  it('parseDateFilter parses non date-only strings as-is', () => {
    const iso = '2026-07-01T05:30:00.000Z';
    expect(parseDateFilter(iso, 'from').toISOString()).toBe(iso);
    expect(parseDateFilter(iso, 'to').toISOString()).toBe(iso);
  });

  it('list from/to filters are inclusive of the whole day when dates are date-only', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    const today = q.createdAt.toISOString().slice(0, 10);
    const listed = await repo.list({ from: today, to: today });
    expect(listed.map((r) => r.id)).toContain(q.id);
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
