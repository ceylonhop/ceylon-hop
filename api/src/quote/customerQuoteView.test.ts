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
      quote({
        marginCents: 31_000,
        rateCardJson: { costPerKmCents: 40 },
        // Deliberately a ONE-option quote (`private`, though `both` is priceable below): the
        // per-journey rail has to be POPULATED or this test never looks at the newest thing that
        // reads the stored, founder-only lineItems — and a two-option quote now suppresses it.
        requestedService: 'private',
        showLegPrices: true,
        result: {
          lineItems: [
            {
              label: 'Colombo Airport → Sigiriya (car)',
              amountCents: 46_500,
              meta: { distanceKm: 168, billableKm: 178, vehicle: 'car', hotZone: 'Ella +12%' },
            },
            {
              label: 'Sigiriya → Kandy (car)',
              amountCents: 37_500,
              meta: { distanceKm: 92, billableKm: 102, vehicle: 'car' },
            },
          ],
        },
      }),
      both,
    );
    // Prove the populated path was actually exercised, not silently skipped.
    expect(v.options[0].legPrices?.rows).toHaveLength(2);
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

// What the money buys, as separate lines (owner, 2026-08-16). The customer's question at this
// box is "what am I being charged for", and one `·`-joined sentence answered it as a paragraph.
describe('what each option says is included', () => {
  const opts = () => customerQuoteView(quote({ requestedService: 'both' }), both).options;

  it('gives private transfers its three inclusions as separate items, no lead-in', () => {
    const inc = opts()[0].included;
    expect(inc.lead).toBeNull();
    expect(inc.items).toEqual([
      'Pick up and drop off',
      'Air-conditioned car with driver',
      'Fuel, tolls and parking',
    ]);
  });

  it('puts the chauffeur card\'s "everything in X, plus" above its items, not inside them', () => {
    const inc = opts()[1].included;
    expect(inc.lead).toBe('Everything in Private transfers, plus:');
    expect(inc.items).toEqual([
      'Your car and driver stays for the whole trip',
      'Sightseeing, waiting',
      "Driver's meals & rooms covered",
    ]);
    // The lead-in is a sentence ABOUT the list — bulleting it would claim it as an inclusion.
    expect(inc.items.some((i) => /Everything in/.test(i))).toBe(false);
  });

  // A quote.html cached before the bullets shipped still reads includedText, so it has to keep
  // saying the same thing the bullets do rather than going blank.
  it('keeps the legacy one-line sentence in step with the items', () => {
    for (const o of opts()) {
      for (const item of o.included.items) expect(o.includedText).toContain(item);
      if (o.included.lead) expect(o.includedText.startsWith(o.included.lead)).toBe(true);
    }
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

  it('DERIVES the pre-discount total for a quote discounted before the reorder', () => {
    // #422 renamed discountedSubtotalCents → totalBeforeDiscountCents. A quote discounted before
    // that deploy has only the old field, and requiring the new one hid the breakdown on a
    // genuinely discounted quote.
    const view = customerQuoteView(
      { ...base, totalCents: 22900, result: { discountCents: 3000, discountedSubtotalCents: 22900 } },
      { pointToPoint: { totalCents: 22900 }, chauffeur: null },
    );
    expect(view.options[0].discount).toEqual({ totalBeforeUsd: '$259', discountUsd: '$30' });
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

describe('per-journey prices', () => {
  const shown = (over: Record<string, unknown> = {}) =>
    customerQuoteView(quote({ showLegPrices: true, ...over }), p2pOnly).options[0].legPrices;

  // A request with ONE driving leg. The split is "the first N lineItems are the driving legs",
  // N coming from the request — so a fixture whose lineItems are one leg plus an extra has to
  // carry a one-leg request too, or it is not a shape the engine can produce.
  const oneLegRequest = {
    engine: { product: 'private', firstDate: '2026-08-20', lastDate: '2026-08-28' },
    tool: { passengerCount: 2, legs: [{ from: 'A', to: 'B', date: '2026-08-20', distanceKm: 100 }] },
  };

  it('is null unless ops ticked the quote', () => {
    expect(customerQuoteView(quote(), p2pOnly).options[0].legPrices).toBeNull();
  });

  it('is null on a chauffeur-priced quote even when ticked', () => {
    const v = customerQuoteView(
      quote({
        showLegPrices: true,
        request: {
          engine: { product: 'chauffeur', firstDate: '2026-08-20', lastDate: '2026-08-28' },
          tool: { passengerCount: 2, legs: [] },
        },
      }),
      { pointToPoint: null, chauffeur: { totalCents: 118_000 } },
    );
    expect(v.options[0].legPrices).toBeNull();
  });

  /* Owner, 2026-08-16: a quote that also offers Chauffeur-guide shows NO per-journey prices —
     not on the secondary card (a recompute, never the approved total) and not on the private
     card either. There is one DAY BY DAY rail below both cards, so a column of private figures
     under a two-option comparison invites the customer to add it up against the chauffeur total.
     Naming whose prices they were was the earlier answer; this is the owner's. */
  it('is null on BOTH options when the quote offers chauffeur alongside private', () => {
    const v = customerQuoteView(
      quote({
        showLegPrices: true,
        requestedService: 'both',
        result: {
          lineItems: [
            { label: 'Colombo Airport → Sigiriya (car)', amountCents: 46_500 },
            { label: 'Sigiriya → Kandy (car)', amountCents: 37_500 },
          ],
        },
      }),
      both,
    );
    expect(v.options).toHaveLength(2);
    expect(v.options[0].legPrices).toBeNull();
    expect(v.options[1].legPrices).toBeNull();
  });

  // The same quote with only the private option offered — the breakdown is back. Without this,
  // the assertion above could pass because the projection broke, not because the gate held.
  it('still shows the breakdown on a single-option private quote', () => {
    const v = customerQuoteView(
      quote({
        showLegPrices: true,
        requestedService: 'private',
        result: {
          lineItems: [
            { label: 'Colombo Airport → Sigiriya (car)', amountCents: 46_500 },
            { label: 'Sigiriya → Kandy (car)', amountCents: 37_500 },
          ],
        },
      }),
      both,
    );
    expect(v.options).toHaveLength(1);
    expect(v.options[0].legPrices!.rows).toEqual([
      { label: 'Colombo Airport → Sigiriya', amountUsd: '$465' },
      { label: 'Sigiriya → Kandy', amountUsd: '$375' },
    ]);
  });

  // Whole dollars, and they already add up: 4508 + 3180 = 7688 engine cents against a $76 charged
  // total, so the $0.88 the finish took off is spread over the two journeys rather than shown as
  // a row of its own — leg 1 keeps its rounded-up $45, leg 2 gives up the dollar (largest
  // remainder: .56 beats .43).
  it('shows one whole-dollar row per journey, named without the vehicle tag', () => {
    const lp = shown({
      result: {
        lineItems: [
          { label: 'Colombo Airport → Sigiriya (car)', amountCents: 4508, meta: { distanceKm: 168 } },
          { label: 'Sigiriya → Kandy (car)', amountCents: 3180, meta: { distanceKm: 92 } },
        ],
      },
      totalCents: 7600,
    });
    expect(lp!.rows).toEqual([
      { label: 'Colombo Airport → Sigiriya', amountUsd: '$45' },
      { label: 'Sigiriya → Kandy', amountUsd: '$31' },
    ]);
  });

  it('folds an attributed extra into its own leg rather than adding a row', () => {
    const lp = shown({
      result: {
        lineItems: [
          { label: 'A → B (car)', amountCents: 5000 },
          { label: 'B → C (car)', amountCents: 5000 },
          { label: 'Sightseeing stops (up to 3h) — A → B', amountCents: 1000, meta: { kind: 'extra', code: 'sightseeing', legIndex: 0 } },
        ],
      },
      totalCents: 11000,
    });
    expect(lp!.rows).toEqual([
      { label: 'A → B', amountUsd: '$60' },
      { label: 'B → C', amountUsd: '$50' },
    ]);
  });

  // priceExtras() pushes an UNATTRIBUTED extra as a bare { label, amountCents } — no `meta` key
  // at all (extrasDeposit.ts). That is the real engine shape, so it is the shape asserted here:
  // it must land after the legs, keep its own label whole, and never be mistaken for a journey.
  it('gives an unattributed extra its own row, label intact', () => {
    const lp = shown({
      request: oneLegRequest,
      result: {
        lineItems: [
          { label: 'A → B (car)', amountCents: 5000 },
          { label: 'Sightseeing stops (up to 3h)', amountCents: 1000 },
        ],
      },
      totalCents: 6000,
    });
    expect(lp!.rows).toEqual([
      { label: 'A → B', amountUsd: '$50' },
      { label: 'Sightseeing stops (up to 3h)', amountUsd: '$10' },
    ]);
  });

  // The rail is read POSITIONALLY against the itinerary's driving days, so an extra that slips
  // into the leg bucket does not just mislabel itself — it shifts every later journey's price
  // onto the wrong day. Two legs, an unattributed extra between nothing: leg 2 must still be $32.
  it('keeps each journey on its own price when an unattributed extra follows the legs', () => {
    const lp = shown({
      result: {
        lineItems: [
          { label: 'Colombo Airport → Sigiriya (car)', amountCents: 4508 },
          { label: 'Sigiriya → Kandy (car)', amountCents: 3180 },
          { label: 'Luggage rack', amountCents: 1500 },
        ],
      },
      totalCents: 9200,
    });
    expect(lp!.rows).toEqual([
      { label: 'Colombo Airport → Sigiriya', amountUsd: '$45' },
      { label: 'Sigiriya → Kandy', amountUsd: '$32' },
      { label: 'Luggage rack', amountUsd: '$15' },
    ]);
  });

  // The view maps every non-chauffeur product onto the 'private' card, so the gate has to read
  // the ENGINE's product: a `shared` quote is priced per seat and has no per-journey price.
  it('is null on a shared quote even when ticked', () => {
    const lp = shown({
      request: {
        engine: { product: 'shared', firstDate: '2026-08-20', lastDate: '2026-08-28' },
        tool: { passengerCount: 2, legs: [{ from: 'A', to: 'B', date: '2026-08-20' }] },
      },
      result: { lineItems: [{ label: 'A → B (seat)', amountCents: 5000 }] },
      totalCents: 5000,
    });
    expect(lp).toBeNull();
  });

  // Stored results are JSON off the wire and can be malformed. A corrupt row must degrade to
  // $0, not print "$NaN" on the row AND poison the remainder with it.
  it('degrades a malformed amount to $0 rather than $NaN', () => {
    const lp = shown({
      result: {
        lineItems: [
          { label: 'A → B (car)', amountCents: 5000 },
          { label: 'B → C (car)' },
        ],
      },
      totalCents: 6000,
    });
    // The zero-weight row takes no share of the total, so the whole $60 lands on the good leg.
    // A wrong-looking figure on a corrupt row, never "$NaN" and never a column that fails to add.
    expect(lp!.rows).toEqual([
      { label: 'A → B', amountUsd: '$60' },
      { label: 'B → C', amountUsd: '$0' },
    ]);
    expect(JSON.stringify(lp)).not.toMatch(/NaN/);
  });

  // A downward finish ($361.46 engine → $359 charged) used to print "Rounded down −$2". The row
  // is gone (owner, 2026-08-16), so the one journey there is simply shown at what it is charged.
  it('absorbs a downward finish into the leg price instead of a rounding row', () => {
    const lp = shown({
      result: { lineItems: [{ label: 'A → B (car)', amountCents: 36146 }] },
      totalCents: 35900,
    });
    expect(lp!.rows).toEqual([{ label: 'A → B', amountUsd: '$359' }]);
    expect(lp!.totalUsd).toBe('$359');
  });

  // `finishPrice`'s 'nearest_50_cents' can leave CENTS on the total. With no remainder row to put
  // them in, they ride on the largest leg — which here is the only leg — so the column still adds
  // up to the $50.50 the pay link charges rather than to a tidier $50.
  it('puts the odd cents of a finished total on the largest leg', () => {
    const lp = shown({
      result: { lineItems: [{ label: 'A → B (car)', amountCents: 5040 }] },
      totalCents: 5050,
    });
    expect(lp!.rows).toEqual([{ label: 'A → B', amountUsd: '$50.50' }]);
  });

  // Case that motivated the fix (owner, 2026-08-16): a `nearest_50_cents` or `unchanged` finish
  // can leave cents on `target` with MORE than one leg behind it. Forcing whole-dollar rows and
  // then dumping the odd cents onto the single largest row made two IDENTICAL legs read a
  // dollar-plus apart — a customer comparing two $200 journeys saw $199.54 beside $198 and would
  // ask about it. The fix quantises in CENTS instead whenever `target` itself carries cents, so
  // equal legs render equal.
  it('spreads a cents-bearing target in cents, not whole dollars, so identical legs render identically', () => {
    const lp = shown({
      request: {
        engine: { product: 'private', firstDate: '2026-08-20', lastDate: '2026-08-22' },
        tool: {
          passengerCount: 2,
          legs: [
            { from: 'A', to: 'B', date: '2026-08-20', distanceKm: 100 },
            { from: 'B', to: 'C', date: '2026-08-22', distanceKm: 100 },
          ],
        },
      },
      result: {
        lineItems: [
          { label: 'A → B (car)', amountCents: 20000 },
          { label: 'B → C (car)', amountCents: 20000 },
        ],
      },
      totalCents: 39754,
    });
    expect(lp!.rows).toEqual([
      { label: 'A → B', amountUsd: '$198.77' },
      { label: 'B → C', amountUsd: '$198.77' },
    ]);
    expect(lp!.totalUsd).toBe('$397.54');
  });

  // Martina's real seven-leg quote (owner, 2026-08-16). The charm-finished total lands on a whole
  // number of dollars, so this must render EXACTLY as it always did — whole-dollar rows by largest
  // remainder — unaffected by the cents-mode branch the fix above added.
  it("renders Martina's seven-leg quote in whole dollars, unchanged by the cents-mode fix", () => {
    const legs = [4508, 3180, 5917, 5112, 5917, 3623, 7889];
    const lp = shown({
      request: {
        engine: { product: 'private', firstDate: '2026-08-20', lastDate: '2026-08-28' },
        tool: {
          passengerCount: 2,
          legs: legs.map((_, i) => ({ from: `L${i}`, to: `M${i}`, date: '2026-08-20', distanceKm: 100 })),
        },
      },
      result: { lineItems: legs.map((a, i) => ({ label: `L${i} → M${i} (car)`, amountCents: a })) },
      totalCents: 35900,
    });
    expect(lp!.rows.map((r) => r.amountUsd)).toEqual(['$45', '$31', '$59', '$51', '$59', '$36', '$78']);
    expect(lp!.totalUsd).toBe('$359');
  });

  // The invariant, specifically in the CENTS regime with more than one row (the case above only
  // proves it for equal weights): unequal legs on a cents-bearing target still sum exactly, and
  // in this regime more than one row is allowed to carry cents — the whole-dollar test's
  // "at most one row" rule is a property of THAT regime, not a universal one.
  it('holds the invariant in the cents regime too, with unequal legs', () => {
    const lp = shown({
      request: {
        engine: { product: 'private', firstDate: '2026-08-20', lastDate: '2026-08-24' },
        tool: {
          passengerCount: 2,
          legs: [
            { from: 'A', to: 'B', date: '2026-08-20', distanceKm: 100 },
            { from: 'B', to: 'C', date: '2026-08-22', distanceKm: 100 },
            { from: 'C', to: 'D', date: '2026-08-24', distanceKm: 100 },
          ],
        },
      },
      result: {
        lineItems: [
          { label: 'A → B (car)', amountCents: 10000 },
          { label: 'B → C (car)', amountCents: 20000 },
          { label: 'C → D (car)', amountCents: 30000 },
        ],
      },
      totalCents: 59999,
    });
    const parse = (s: string) => Math.round(Number(s.replace(/[$,+]/g, '')) * 100);
    expect(lp!.rows.reduce((s, r) => s + parse(r.amountUsd), 0)).toBe(59999);
    expect(parse(lp!.totalUsd)).toBe(59999);
  });

  it('leaves the leg prices alone when they already sum to the charged total', () => {
    const lp = shown({
      result: {
        lineItems: [
          { label: 'A → B (car)', amountCents: 5000 },
          { label: 'B → C (car)', amountCents: 3000 },
        ],
      },
      totalCents: 8000,
    });
    expect(lp!.rows).toEqual([
      { label: 'A → B', amountUsd: '$50' },
      { label: 'B → C', amountUsd: '$30' },
    ]);
  });

  it('gives a discount its own row instead of burying it in the leg prices', () => {
    const lp = shown({
      result: {
        lineItems: [{ label: 'A → B (car)', amountCents: 20000 }],
        discountCents: 5000,
        totalBeforeDiscountCents: 20000,
      },
      totalCents: 15000,
    });
    // The rows sum to the PRE-discount $200 — the discount is a row of its own beneath them, or
    // the column would not add up to the $150 charged.
    expect(lp!.rows).toEqual([{ label: 'A → B', amountUsd: '$200' }]);
    expect(lp!.discount).toEqual({ label: 'Discount', amountUsd: '−$50' });
    expect(lp!.totalUsd).toBe('$150');
  });

  /* THE INVARIANT — the point of the whole feature. Whatever rounding and finishing did, the
     column the customer adds up must land on the figure the pay link charges. With the rounding
     row gone (owner, 2026-08-16) the rows themselves carry it, so the form is now:

         Σ(rows) − discount === totalCents

     and each row is a whole number of dollars except, at most, the largest leg when the finish
     left cents on the total. */
  it('always sums to the charged total', () => {
    const cases = [
      { legs: [4508, 3180, 5917, 5112, 5917, 3623, 7889], total: 35900, discount: 0 }, // multi-leg
      { legs: [4999], total: 4999, discount: 0 }, // single leg, cents on the total
      { legs: [5040], total: 5050, discount: 0 }, // a finish that rounded UP
      { legs: [20000, 10000], total: 25000, discount: 5000 }, // discounted
      { legs: [3333, 3333, 3334], total: 9900, discount: 0 }, // thirds — largest remainder earns it
    ];
    for (const c of cases) {
      const lp = shown({
        request: {
          engine: { product: 'private', firstDate: '2026-08-20', lastDate: '2026-08-28' },
          tool: {
            passengerCount: 2,
            legs: c.legs.map((_, i) => ({ from: `L${i}`, to: `M${i}`, date: '2026-08-20', distanceKm: 100 })),
          },
        },
        result: {
          lineItems: c.legs.map((a, i) => ({ label: `L${i} → M${i} (car)`, amountCents: a })),
          ...(c.discount ? { discountCents: c.discount, totalBeforeDiscountCents: c.total + c.discount } : {}),
        },
        totalCents: c.total,
      })!;
      const parse = (s: string) => Math.round(Number(s.replace(/[$,+]/g, '').replace('−', '-')) * 100);
      const sum =
        lp.rows.reduce((s, r) => s + parse(r.amountUsd), 0) +
        (lp.discount ? parse(lp.discount.amountUsd) : 0);
      expect(sum, `legs ${c.legs} total ${c.total}`).toBe(c.total);
      expect(parse(lp.totalUsd)).toBe(c.total);
      // No rounding row, so the only place stray cents can hide is a row — and at most one row
      // may carry them (the largest). Everything else the customer reads is whole dollars.
      const withCents = lp.rows.filter((r) => parse(r.amountUsd) % 100 !== 0);
      expect(withCents.length, `legs ${c.legs} total ${c.total}`).toBeLessThanOrEqual(1);
    }
  });

  // Finding 2: the engine's own `price_adjustment` and `discount` rows are skipped on purpose —
  // the leg rows are DISTRIBUTED to hit the charged total and `discount` is computed from the
  // stored discountCents, so reading the engine's rows back would double-count them. If the skip
  // were ever deleted, the invariant test would still pass (the distribution absorbs the stray
  // rows), so this has to check identity, not just the sum.
  it('never prints the engine\'s own adjustment or discount rows, computing its own instead', () => {
    const lp = shown({
      request: {
        engine: { product: 'private', firstDate: '2026-08-20', lastDate: '2026-08-28' },
        tool: {
          passengerCount: 2,
          legs: [
            { from: 'A', to: 'B', date: '2026-08-20', distanceKm: 100 },
            { from: 'B', to: 'C', date: '2026-08-22', distanceKm: 100 },
          ],
        },
      },
      result: {
        lineItems: [
          { label: 'A → B (car)', amountCents: 20000 },
          { label: 'B → C (car)', amountCents: 20000 },
          { label: 'Final price adjustment', amountCents: -246, meta: { kind: 'price_adjustment', strategy: 'charm' } },
          { label: 'Discount', amountCents: -5000, meta: { kind: 'discount' } },
        ],
        // The projection's own discount row is read from these top-level fields, never from the
        // lineItems' own 'Discount' row — so this exercises both skips at once: the adjustment
        // row folds into `reconcile`, and the lineItems' discount row is ignored in favour of
        // the one computed from discountCents.
        discountCents: 5000,
        totalBeforeDiscountCents: 39754,
      },
      totalCents: 34754,
    });
    expect(lp!.rows.map((r) => r.label)).not.toContain('Final price adjustment');
    expect(lp!.rows.map((r) => r.label)).not.toContain('Discount');
    // The skipped −246 adjustment reaches the customer as a $2.46 shave on the leg rows, not as a
    // row. The $397.54 pre-discount target carries cents, so the spread quantises in CENTS, not
    // whole dollars: two EQUAL $200 legs land on the same figure — $198.77 each — rather than one
    // customer's journey reading $1.54 more than an identical one just because the residual cents
    // used to get dumped on a single "largest" row.
    expect(lp!.rows).toEqual([
      { label: 'A → B', amountUsd: '$198.77' },
      { label: 'B → C', amountUsd: '$198.77' },
    ]);
    // The discount is the PROJECTION's own computed row: $50 from discountCents, not the
    // lineItems' own -5000 'Discount' row (which would print $50 too, but by being read back).
    expect(lp!.discount).toEqual({ label: 'Discount', amountUsd: '−$50' });
    const parse = (s: string) => Math.round(Number(s.replace(/[$,+]/g, '').replace('−', '-')) * 100);
    const sum =
      lp!.rows.reduce((s, r) => s + parse(r.amountUsd), 0) + (lp!.discount ? parse(lp!.discount.amountUsd) : 0);
    expect(sum).toBe(34754);
  });

  // Finding 3: N is trusted today (request and result are written atomically), but if it ever
  // overran the real leg rows, a bare slice-by-N could pull an internal row into the leg bucket
  // and show it to a customer as a journey. The projection stops at the first internal row
  // regardless of N.
  it('never buckets an internal row as a journey even if N overruns the leg rows', () => {
    const lp = shown({
      request: {
        engine: { product: 'private', firstDate: '2026-08-20', lastDate: '2026-08-28' },
        tool: {
          passengerCount: 2,
          // N (driving-leg count) is 3, but the stored result only has ONE real leg row before
          // its internal rows — the shape a corrupt/legacy result could have.
          legs: [
            { from: 'A', to: 'B', date: '2026-08-20', distanceKm: 100 },
            { from: 'B', to: 'C', date: '2026-08-22', distanceKm: 100 },
            { from: 'C', to: 'D', date: '2026-08-24', distanceKm: 100 },
          ],
        },
      },
      result: {
        lineItems: [
          { label: 'A → B (car)', amountCents: 20000 },
          { label: 'Final price adjustment', amountCents: -246, meta: { kind: 'price_adjustment', strategy: 'charm' } },
          { label: 'Discount', amountCents: -5000, meta: { kind: 'discount' } },
        ],
      },
      totalCents: 14754,
    });
    // One surviving leg row, so it carries the whole (corrupt) total — the point here is that the
    // internal rows never appear as journeys, not what the one journey costs.
    expect(lp!.rows).toEqual([{ label: 'A → B', amountUsd: '$147.54' }]);
    expect(lp!.rows.map((r) => r.label)).not.toContain('Final price adjustment');
    expect(lp!.rows.map((r) => r.label)).not.toContain('Discount');
  });

  // The rail and this column are matched POSITIONALLY — the Nth journey row gets the Nth price.
  // quoteDays sorts the legs by DATE; the engine prices `req.legs` as given and never sorts. So a
  // quote whose stored legs are out of chronological order put a real price on the wrong journey.
  it('orders leg rows as the rail renders them, not as the request stored them', () => {
    const out = {
      showLegPrices: true,
      request: {
        engine: { product: 'private', firstDate: '2026-08-20', lastDate: '2026-08-24' },
        tool: {
          passengerCount: 2,
          legs: [
            // Stored SECOND-day-first — ops reordered the itinerary after pricing.
            { from: 'Kandy', to: 'Ella', date: '2026-08-24', distanceKm: 120 },
            { from: 'Colombo Airport', to: 'Kandy', date: '2026-08-20', distanceKm: 116 },
          ],
        },
      },
      // lineItems are in REQUEST order: that is the only order the engine emits.
      result: {
        lineItems: [
          { label: 'Kandy → Ella (car)', amountCents: 9000 },
          { label: 'Colombo Airport → Kandy (car)', amountCents: 4000 },
        ],
      },
      totalCents: 13000,
    };
    const v = customerQuoteView(quote(out), p2pOnly);
    expect(v.options[0].legPrices!.rows).toEqual([
      { label: 'Colombo Airport → Kandy', amountUsd: '$40' },
      { label: 'Kandy → Ella', amountUsd: '$90' },
    ]);
    // And the thing that actually matters: row i belongs to journey i of the rail.
    expect(v.days.filter((d) => d.kind === 'journey').map((d) => d.title)).toEqual(
      v.options[0].legPrices!.rows.map((r) => r.label),
    );
  });

  // An attributed extra's `legIndex` counts the engine's driving legs in REQUEST order, so the
  // fold has to happen against request order and the reorder afterwards — or the extra rides to
  // the wrong journey. Here the $10 sightseeing belongs to leg 0 = the LATER journey.
  it('folds an attributed extra by request index before reordering', () => {
    const lp = shown({
      request: {
        engine: { product: 'private', firstDate: '2026-08-20', lastDate: '2026-08-24' },
        tool: {
          passengerCount: 2,
          legs: [
            { from: 'Kandy', to: 'Ella', date: '2026-08-24', distanceKm: 120 },
            { from: 'Colombo Airport', to: 'Kandy', date: '2026-08-20', distanceKm: 116 },
          ],
        },
      },
      result: {
        lineItems: [
          { label: 'Kandy → Ella (car)', amountCents: 9000 },
          { label: 'Colombo Airport → Kandy (car)', amountCents: 4000 },
          { label: 'Sightseeing stops (up to 3h) — Kandy → Ella', amountCents: 1000, meta: { kind: 'extra', legIndex: 0 } },
          { label: 'Luggage rack', amountCents: 500 },
        ],
      },
      totalCents: 14500,
    });
    expect(lp!.rows).toEqual([
      { label: 'Colombo Airport → Kandy', amountUsd: '$40' },
      { label: 'Kandy → Ella', amountUsd: '$100' },
      // Loose extras stay trailing, after all leg rows.
      { label: 'Luggage rack', amountUsd: '$5' },
    ]);
  });

  // quoteDays bails out of calendar arithmetic when ANY leg is undated and emits the legs in
  // REQUEST order. Sorting here regardless would introduce the same bug in the other direction.
  it('keeps REQUEST order when a leg is undated, exactly as the rail does', () => {
    const out = {
      showLegPrices: true,
      request: {
        engine: { product: 'private' },
        tool: {
          passengerCount: 2,
          legs: [
            { from: 'Kandy', to: 'Ella', date: '2026-08-24', distanceKm: 120 },
            { from: 'Colombo Airport', to: 'Kandy', date: '', distanceKm: 116 },
          ],
        },
      },
      result: {
        lineItems: [
          { label: 'Kandy → Ella (car)', amountCents: 9000 },
          { label: 'Colombo Airport → Kandy (car)', amountCents: 4000 },
        ],
      },
      totalCents: 13000,
    };
    const v = customerQuoteView(quote(out), p2pOnly);
    expect(v.options[0].legPrices!.rows).toEqual([
      { label: 'Kandy → Ella', amountUsd: '$90' },
      { label: 'Colombo Airport → Kandy', amountUsd: '$40' },
    ]);
    expect(v.days.filter((d) => d.kind === 'journey').map((d) => d.title)).toEqual(
      v.options[0].legPrices!.rows.map((r) => r.label),
    );
  });

  // A stay_day leg is a rail row but never a priced one, and it takes part in the date sort. The
  // driving legs' price rows must still land on the driving rows in rail order.
  it('orders around an interleaved stay day', () => {
    const lp = shown({
      request: {
        engine: { product: 'private', firstDate: '2026-08-20', lastDate: '2026-08-24' },
        tool: {
          passengerCount: 2,
          legs: [
            { from: 'Kandy', to: 'Ella', date: '2026-08-24', distanceKm: 120 },
            { from: 'Kandy', to: 'Kandy', date: '2026-08-22', category: 'stay_day' },
            { from: 'Colombo Airport', to: 'Kandy', date: '2026-08-20', distanceKm: 116 },
          ],
        },
      },
      result: {
        lineItems: [
          { label: 'Kandy → Ella (car)', amountCents: 9000 },
          { label: 'Colombo Airport → Kandy (car)', amountCents: 4000 },
        ],
      },
      totalCents: 13000,
    });
    expect(lp!.rows).toEqual([
      { label: 'Colombo Airport → Kandy', amountUsd: '$40' },
      { label: 'Kandy → Ella', amountUsd: '$90' },
    ]);
  });

  it('never leaks lineItem meta', () => {
    const lp = shown({
      result: {
        lineItems: [{ label: 'A → B (car)', amountCents: 5000, meta: { hotZone: 'Ella +12%', vehicle: 'car' } }],
      },
      totalCents: 5000,
    });
    expect(JSON.stringify(lp)).not.toMatch(/hotZone|Ella \+12%|vehicle/);
  });
});
