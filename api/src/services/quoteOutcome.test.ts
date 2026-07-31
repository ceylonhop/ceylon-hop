import { describe, it, expect } from 'vitest';
import { releaseWonQuote } from './quoteOutcome';
import { InMemoryQuoteRepo } from '../db/quoteRepo';

async function wonQuote(quotes: InMemoryQuoteRepo, bookingId: string) {
  const q = await quotes.save({
    channel: 'ops', product: 'private', totalCents: 21900, currency: 'USD', rateCardVersion: 'v1',
    request: { engine: {} }, result: {},
  });
  await quotes.patch(q.id, { status: 'sent' });
  await quotes.patch(q.id, { status: 'won', convertedBookingId: bookingId });
  return q.id;
}

describe('releaseWonQuote', () => {
  it('turns a won quote into a lost one, with the reason, when its booking dies', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await wonQuote(quotes, 'bk-1');
    const decidedBefore = (await quotes.get(id))!.decidedAt;

    expect(await releaseWonQuote('bk-1', 'Booking cancelled', { quotes })).toBe('Booking cancelled');
    const after = await quotes.get(id);
    expect(after!.status).toBe('lost');
    expect(after!.lostReason).toBe('Booking cancelled');
    // The decision date is write-once, so the row stays in the analytics window it always
    // sat in — the flip corrects the outcome, it doesn't move history.
    expect(after!.decidedAt).toEqual(decidedBefore);
  });

  it('leaves a quote alone when nothing points at the booking', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await wonQuote(quotes, 'bk-1');
    expect(await releaseWonQuote('bk-other', 'Booking refunded', { quotes })).toBeNull();
    expect((await quotes.get(id))!.status).toBe('won');
  });

  it('never re-decides a quote that was already lost', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await quotes.save({
      channel: 'ops', product: 'private', totalCents: 100, currency: 'USD', rateCardVersion: 'v1',
      request: {}, result: {},
    });
    await quotes.patch(q.id, { status: 'lost', lostReason: 'Too expensive', convertedBookingId: 'bk-2' });
    expect(await releaseWonQuote('bk-2', 'Booking cancelled', { quotes })).toBeNull();
    expect((await quotes.get(q.id))!.lostReason).toBe('Too expensive');
  });

  it('is a no-op without a quote repo, and never throws on a repo failure', async () => {
    expect(await releaseWonQuote('bk-1', 'Booking cancelled', {})).toBeNull();
    const broken = {
      findByConvertedBookingId: async () => { throw new Error('db down'); },
    } as unknown as InMemoryQuoteRepo;
    expect(await releaseWonQuote('bk-1', 'Booking cancelled', { quotes: broken })).toBeNull();
  });
});
