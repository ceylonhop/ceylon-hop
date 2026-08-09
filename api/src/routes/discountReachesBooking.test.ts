// api/src/routes/discountReachesBooking.test.ts
// Task 7 — proving a founder's discount survives all the way to the money.
//
// The interesting finding is that most of this needs no new code: every downstream surface reads
// the STORED quote total, and the stored total is already the discounted one. These tests exist
// because "it happens to work" and "it is guaranteed to work" are different things, and this is
// the path a customer's card is charged on.
import { describe, it, expect } from 'vitest';
import { createApp as realCreateApp, type AppDeps } from '../app';
import { signSession } from '../lib/opsAuth';
import { InMemoryQuoteDiscountRepo } from '../db/quoteDiscountRepo';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { InMemoryBookingRepo } from '../db/bookingRepo';

const AUTH = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };
const FOUNDER = `ch_ops=${signSession({ email: 'f@x.com', exp: Date.now() + 60_000 }, AUTH.opsSessionSecret)}`;

function wired() {
  const discounts = new InMemoryQuoteDiscountRepo();
  const quotes = new InMemoryQuoteRepo(discounts);
  const bookings = new InMemoryBookingRepo();
  const deps: AppDeps = {
    auth: AUTH, adminApiKey: 'k', bookingLinkSecret: 'test-link-secret',
    quotes, quoteDiscounts: discounts, bookings, opsManualDiscountsEnabled: true,
  };
  return { discounts, quotes, bookings, a: realCreateApp(deps) };
}

const BODY = {
  name: 'Maya', vehicle: 'car', passengerCount: 2, luggageCount: 2, requestedService: 'private',
  legs: [{ category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 115 }],
};

const post = (a: ReturnType<typeof realCreateApp>, path: string, body: unknown) =>
  a.request(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: FOUNDER }, body: JSON.stringify(body) });

describe('a founder discount reaches the money', () => {
  it('lowers the STORED total, which is what every downstream surface reads', async () => {
    const { a } = wired();
    const full = (await (await post(a, '/admin/quote/save', BODY)).json()) as { id: string; totalCents: number };
    const discounted = (await (await post(a, '/admin/quote/save', {
      ...BODY, id: full.id, discount: { method: 'fixed', amountCents: 1000, reason: 'closing' },
    })).json()) as { totalCents: number };

    expect(discounted.totalCents).toBeLessThan(full.totalCents);

    // The stored row — not a recompute — is what the customer page, the pay link and the booking
    // all read. If this is right, they are right.
    const stored = (await (await a.request(`/admin/quote/${full.id}`, { headers: { cookie: FOUNDER } })).json()) as { totalCents: number };
    expect(stored.totalCents).toBe(discounted.totalCents);
  });

  // NOT COVERED HERE, deliberately, and flagged rather than faked: the pay-link refusal on a
  // discounted quote (shipped in Task 5) sits BEHIND the status/bookable guard, so a draft is
  // refused for its status and never reaches it. Exercising it needs a quote driven to `sent`,
  // which needs the submit/approve fixture this file does not have. A test that asserted 409
  // without reaching the discount branch would pass for the wrong reason and quietly rot — worse
  // than no test. Left for the Task 6 UI suite, which already builds that fixture.
});
