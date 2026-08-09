import { describe, it, expect } from 'vitest';
import { customerQuoteView } from './customerQuoteView';

const quote = (over: Record<string, unknown> = {}) => ({
  reference: 'Q-7F3KX',
  customerName: 'Anna Bergström',
  vehicle: 'car',
  totalCents: 84_000,
  requestedService: 'private',
  request: {
    engine: { product: 'private', firstDate: '2026-08-20', lastDate: '2026-08-28' },
    tool: {
      passengerCount: 2,
      legs: [
        { from: 'Colombo Airport', to: 'Sigiriya', date: '2026-08-20', distanceKm: 168 },
        { from: 'Sigiriya', to: 'Kandy', date: '2026-08-22', distanceKm: 92 },
      ],
    },
  },
  ...over,
});

const both = { pointToPoint: { totalCents: 84_000 }, chauffeur: { totalCents: 118_000 } };
const p2pOnly = { pointToPoint: { totalCents: 84_000 }, chauffeur: null };

describe('customerQuoteView', () => {
  it('never emits margin on any path', () => {
    const v = customerQuoteView(
      quote({ marginCents: 31_000, rateCardJson: { costPerKmCents: 40 }, requestedService: 'both' }),
      both,
    );
    const s = JSON.stringify(v);
    expect(s).not.toMatch(/margin/i);
    expect(s).not.toMatch(/rateCard|costPerKm|markup|hotZone/i);
  });

  it('shows one option for a `private` quote, even when chauffeur is priceable', () => {
    const v = customerQuoteView(quote(), both);
    expect(v.options).toHaveLength(1);
    expect(v.options[0]).toMatchObject({ service: 'private', lead: true, totalUsd: '$840' });
  });

  it('shows both options for a `both` quote, priced service leading', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), both);
    expect(v.options.map((o) => o.service)).toEqual(['private', 'chauffeur']);
    expect(v.options[0].lead).toBe(true);
    expect(v.options[1].lead).toBe(false);
    expect(v.options[1].totalUsd).toBe('$1,180');
  });

  it('carries no delta line on the non-priced option', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), both);
    // No delta line (owner, 2026-08-06): the card carries its own total and nothing else —
    // the interface has no delta fields at all, so a re-add must come back through review.
    expect('deltaText' in v.options[1]).toBe(false);
  });

  it('degrades to one card when chauffeur cannot be priced on a `both` quote', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), p2pOnly);
    expect(v.options).toHaveLength(1);
    expect(v.options[0].service).toBe('private');
    expect(v.heroTotalNote).not.toMatch(/or \$/);
  });

  it('names both numbers in the hero note on a two-option quote', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), both);
    expect(v.heroTotalUsd).toBe('$840');
    expect(v.heroTotalNote).toBe('private transfers · or $1,180 with your driver throughout');
  });

  it('gives each service its own cancellation ladder, matching pay.html exactly', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), both);
    expect(v.options[0].cancellation).toEqual({
      headline: 'Free cancellation until 24 hours before departure.',
      ladder: [
        'More than 24 hours before departure: full refund, unlimited changes',
        'Within 24 hours, a no-show, or after departure: no refund',
      ],
    });
    expect(v.options[1].cancellation).toEqual({
      headline: 'Free cancellation until 10 days before your trip starts.',
      ladder: [
        '10–8 days before: 80% refund',
        '7–3 days before: 60% refund',
        '2 days–24 hours before: 40% refund',
        'Within 24 hours, a no-show, or after the trip begins: no refund',
      ],
    });
  });

  it('prefills WhatsApp with the reference and the tapped option', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), both);
    expect(v.options[1].waText).toBe(
      "Hi! I'd like to book the Chauffeur-guide option for quote Q-7F3KX",
    );
    expect(v.waText).toContain('Q-7F3KX');
  });

  it('exposes the ordered map stops and trip stats', () => {
    const v = customerQuoteView(quote(), p2pOnly);
    expect(v.mapStops).toEqual(['Colombo Airport', 'Sigiriya', 'Kandy']);
    expect(v.totalKm).toBe(260);
    expect(v.travelDays).toBe(2);
  });

  // The customer map must draw the road the quote was priced on. routeVariant is stored per
  // leg and was never exposed here, so a Local-road quote drew the expressway to the customer.
  it('exposes the map runs the route was quoted on', () => {
    const v = customerQuoteView(quote(), p2pOnly);
    expect(v.mapRuns).toEqual([
      { stops: ['Colombo Airport', 'Sigiriya', 'Kandy'], avoidTolls: false, continues: false },
    ]);
  });

  it('marks a toll-free leg so the customer sees the local road', () => {
    const v = customerQuoteView(quote({
      request: {
        engine: { product: 'private', firstDate: '2026-08-20', lastDate: '2026-08-28' },
        tool: {
          legs: [{ from: 'Ella', to: 'Colombo City', distanceKm: 197, routeVariant: 'no_tolls' }],
        },
      },
    }), p2pOnly);
    expect(v.mapRuns).toEqual([
      { stops: ['Ella', 'Colombo City'], avoidTolls: true, continues: false },
    ]);
  });

  // avoidTolls is a per-request modifier, so legs that disagree can't be one query.
  it('splits a journey whose legs disagree on the road, flagging the join', () => {
    const v = customerQuoteView(quote({
      request: {
        engine: { product: 'private', firstDate: '2026-08-20', lastDate: '2026-08-28' },
        tool: {
          legs: [
            { from: 'Ella', to: 'Kandy', distanceKm: 120, routeVariant: 'no_tolls' },
            { from: 'Kandy', to: 'Colombo City', distanceKm: 115 },
          ],
        },
      },
    }), p2pOnly);
    expect(v.mapRuns).toEqual([
      { stops: ['Ella', 'Kandy'], avoidTolls: true, continues: false },
      { stops: ['Kandy', 'Colombo City'], avoidTolls: false, continues: true },
    ]);
    // mapStops stays the flat, de-duplicated list the stop count and SVG fallback are built on.
    expect(v.mapStops).toEqual(['Ella', 'Kandy', 'Colombo City']);
  });

  it('renders a legacy quote with no engine without throwing', () => {
    const v = customerQuoteView(quote({ request: {} }), { pointToPoint: { totalCents: 84_000 }, chauffeur: null });
    expect(v.options).toHaveLength(1);
    expect(v.days).toEqual([]);
    expect(v.mapStops).toEqual([]);
    expect(v.mapRuns).toEqual([]);
  });

  // Correction 1: heroTotalNote must describe the SECONDARY option's own service, not always
  // assume the secondary is chauffeur. When ops priced chauffeur and private is the cheaper
  // alternative, "with your driver throughout" would misdescribe the point-to-point option.
  it('names the hero note correctly when the priced service is chauffeur', () => {
    const chauffeurQuote = quote({
      requestedService: 'both',
      totalCents: 118_000,
      request: {
        engine: { product: 'chauffeur', firstDate: '2026-08-20', lastDate: '2026-08-28' },
        tool: {
          passengerCount: 2,
          legs: [
            { from: 'Colombo Airport', to: 'Sigiriya', date: '2026-08-20', distanceKm: 168 },
            { from: 'Sigiriya', to: 'Kandy', date: '2026-08-22', distanceKm: 92 },
          ],
        },
      },
    });
    const v = customerQuoteView(chauffeurQuote, both);
    expect(v.options.map((o) => o.service)).toEqual(['chauffeur', 'private']);
    expect(v.heroTotalUsd).toBe('$1,180');
    expect(v.heroTotalNote).toBe('chauffeur-guide · or $840 travelling journey by journey');
  });

  // Correction 2: a legacy row with requestedService: null must render exactly one option
  // (the priced one) and must not throw — the brief only covers 'private' and 'both'.
  it('renders exactly one option for a legacy quote with requestedService null', () => {
    const v = customerQuoteView(quote({ requestedService: null }), both);
    expect(v.options).toHaveLength(1);
    expect(v.options[0].service).toBe('private');
    expect(v.options[0].lead).toBe(true);
  });

  // Finding 2: priceFinish.ts has an 'unchanged' (and 'nearest_50_cents') strategy, so a total
  // can legitimately carry cents. usd() must not silently drop them and understate the price
  // the pay page (which uses .toFixed(2)) would actually charge.
  it('renders whole dollars when the total is an exact number of dollars', () => {
    const v = customerQuoteView(quote({ totalCents: 84_000 }), { pointToPoint: { totalCents: 84_000 }, chauffeur: null });
    expect(v.heroTotalUsd).toBe('$840');
  });

  it('renders cents, with the thousands separator, when the total carries cents', () => {
    const v = customerQuoteView(quote({ totalCents: 84_037 }), { pointToPoint: { totalCents: 84_037 }, chauffeur: null });
    expect(v.heroTotalUsd).toBe('$840.37');
  });

  it('renders a thousands-separated cents value correctly', () => {
    const v = customerQuoteView(quote({ totalCents: 1_180_37 }), { pointToPoint: { totalCents: 1_180_37 }, chauffeur: null });
    expect(v.heroTotalUsd).toBe('$1,180.37');
  });

  // Finding 3: `totalFor(priced) ?? quote.totalCents` is the guard that keeps the STORED,
  // approved total authoritative when a recompute is unavailable. `??` (not `||`) also matters
  // because a legitimate stored total of 0 must survive, not be treated as falsy.
  it('falls back to the stored total when the priced service itself cannot be priced', () => {
    const v = customerQuoteView(quote({ totalCents: 84_000 }), { pointToPoint: null, chauffeur: null });
    expect(v.options[0].totalCents).toBe(84_000);
    expect(v.heroTotalUsd).toBe('$840');
  });

  it('preserves a stored total of 0 rather than treating it as missing', () => {
    const v = customerQuoteView(quote({ totalCents: 0 }), { pointToPoint: null, chauffeur: null });
    expect(v.options[0].totalCents).toBe(0);
    expect(v.heroTotalUsd).toBe('$0');
  });
});

// The page must never print a number the pay link would not charge. The pay link charges the
// STORED total (quotePay.ts: soldCents ?? totalCents); approval snapshots the rate card without
// re-writing totalCents, so a recompute can legitimately differ from it after a rate-card deploy.
describe('the lead option is the stored, approved total', () => {
  it('shows the stored total even when the recompute disagrees', () => {
    const v = customerQuoteView(
      quote({ totalCents: 84_000 }),
      { pointToPoint: { totalCents: 79_500 }, chauffeur: null }, // recompute drifted down
    );
    expect(v.options[0].totalUsd).toBe('$840');
    expect(v.heroTotalUsd).toBe('$840');
  });

  it('measures the secondary option delta against the stored total', () => {
    const v = customerQuoteView(
      quote({ totalCents: 84_000, requestedService: 'both' }),
      { pointToPoint: { totalCents: 79_500 }, chauffeur: { totalCents: 118_000 } },
    );
    expect(v.options[1].totalUsd).toBe('$1,180'); // secondary keeps its recompute
  });
});



describe('a negotiated price on the customer quote page', () => {
  const base = {
    reference: 'Q-TEST1', customerName: 'Maya', vehicle: 'car', requestedService: 'private',
    request: { engine: { product: 'private' }, tool: { legs: [{ from: 'A', to: 'B', distanceKm: 80 }] } },
  };

  it('shows Total, Discount and Final total, and they reconcile exactly', () => {
    const view = customerQuoteView(
      { ...base, totalCents: 5200, result: { totalBeforeDiscountCents: 6200, discountCents: 1000 } },
      { pointToPoint: { totalCents: 5200 }, chauffeur: null },
    );
    const lead = view.options[0];
    expect(lead.discount).toEqual({ totalBeforeUsd: '$62', discountUsd: '$10' });
    expect(lead.totalUsd).toBe('$52');
    // The customer can check the arithmetic and it holds — which is only true because finishing
    // runs BEFORE the discount. Under the old order this was $62 − $10 = $51.99.
    expect(6200 - 1000).toBe(5200);
  });

  it('shows no breakdown when nothing was negotiated', () => {
    const view = customerQuoteView(
      { ...base, totalCents: 6200, result: { } },
      { pointToPoint: { totalCents: 6200 }, chauffeur: null },
    );
    expect(view.options[0].discount).toBeUndefined();
  });

  it('never invents a discount on the COMPARISON card', () => {
    // The second card is a recompute with no stored discount behind it.
    const view = customerQuoteView(
      { ...base, requestedService: 'both', totalCents: 5200, result: { totalBeforeDiscountCents: 6200, discountCents: 1000 } },
      { pointToPoint: { totalCents: 5200 }, chauffeur: { totalCents: 9900 } },
    );
    expect(view.options[0].discount).toBeDefined();
    expect(view.options[1]?.discount).toBeUndefined();
  });
});
