import { describe, it, expect } from 'vitest';
import { payPageCopy } from './payPageCopy';

// The pay page's words are DERIVED, never typed: everything comes from the quote the
// operator already built, so nothing surprising can be shown to a customer. These tests
// pin the derivation rules from spec D11 — and the day-counting must agree with the
// engine's span maths, which is why the chauffeur cases use first/last dates.

const tool = (legs: unknown[], extra: Record<string, unknown> = {}) => ({
  vehicle: 'car', passengerCount: 2, luggageCount: 2, legs, ...extra,
});
const leg = (from: string, to: string, date = '', category = 'transfer') => ({ from, to, date, category });

function quoteOf(opts: {
  name?: string | null; vehicle?: string | null; product?: string;
  legs?: unknown[]; toolExtra?: Record<string, unknown>;
  firstDate?: string; lastDate?: string; totalCents?: number;
}) {
  const product = opts.product ?? 'private';
  const legs = opts.legs ?? [leg('Colombo Airport (CMB)', 'Galle', '2026-08-08')];
  return {
    customerName: opts.name === undefined ? 'Emma Larsson' : opts.name,
    vehicle: opts.vehicle === undefined ? 'car' : opts.vehicle,
    totalCents: opts.totalCents ?? 5800,
    request: {
      tool: tool(legs, opts.toolExtra ?? {}),
      engine: product === 'chauffeur'
        ? { product, firstDate: opts.firstDate ?? '2026-08-12', lastDate: opts.lastDate ?? '2026-08-17', travelDays: [] }
        : { product, legs: [] },
    },
  };
}

describe('payPageCopy — single transfer', () => {
  it('titles with the route and carries the journey facts', () => {
    const c = payPageCopy(quoteOf({}));
    expect(c.product).toBe('single');
    expect(c.greetingName).toBe('Emma');
    expect(c.title).toBe('Colombo Airport (CMB) → Galle');
    expect(c.totalLabel).toBe('Total');
    expect(c.legs).toBeNull();
    expect(c.facts.map((f) => f.k)).toContain('Travellers');
    expect(c.facts.map((f) => f.k)).toContain('Vehicle');
  });

  it('subtitle carries the date when the leg has one', () => {
    const c = payPageCopy(quoteOf({}));
    expect(c.subtitle).toContain('8 August 2026');
  });
});

describe('payPageCopy — multi-leg', () => {
  const THREE = [
    leg('Colombo Airport (CMB)', 'Kandy', '2026-08-20'),
    leg('Kandy', 'Ella', '2026-08-22'),
    leg('Ella', 'Mirissa', '2026-08-24'),
  ];

  it('counts journeys as a word and spans the dates', () => {
    const c = payPageCopy(quoteOf({ legs: THREE }));
    expect(c.product).toBe('multi');
    expect(c.title).toBe('Three journeys, 20–24 August');
    expect(c.totalLabel).toBe('Total · all 3 journeys');
  });

  it('lists every leg — one row each, date preformatted, never a price', () => {
    const c = payPageCopy(quoteOf({ legs: THREE }));
    expect(c.legs).toHaveLength(3);
    expect(c.legs![0]).toEqual({ route: 'Colombo Airport (CMB) → Kandy', date: 'THU 20 AUG' });
    expect(c.legs![2].date).toBe('MON 24 AUG');
  });

  it('drops the date clause when legs are undated', () => {
    const undated = [leg('A', 'B'), leg('B', 'C'), leg('C', 'D')];
    const c = payPageCopy(quoteOf({ legs: undated }));
    expect(c.title).toBe('Three journeys');
    expect(c.legs![0].date).toBeNull();
  });

  it('excludes stay days from the journey list and the count', () => {
    const withStay = [
      leg('A', 'B', '2026-08-20'),
      leg('B', 'B', '2026-08-21', 'stay_day'),
      leg('B', 'C', '2026-08-22'),
    ];
    const c = payPageCopy(quoteOf({ legs: withStay }));
    expect(c.title).toContain('Two journeys');
    expect(c.legs).toHaveLength(2);
  });
});

describe('payPageCopy — chauffeur', () => {
  it('titles with the span as a word and shows the shape, not the itinerary', () => {
    const c = payPageCopy(quoteOf({
      product: 'chauffeur', vehicle: 'van_6',
      legs: [
        leg('Colombo Airport (CMB)', 'Sigiriya', '2026-08-12'),
        leg('Sigiriya', 'Kandy', '2026-08-13'),
        leg('Kandy', 'Ella', '2026-08-15'),
        leg('Ella', 'Galle', '2026-08-17'),
      ],
      toolExtra: { passengerCount: 4 },
      firstDate: '2026-08-12', lastDate: '2026-08-17',
    }));
    expect(c.product).toBe('chauffeur');
    expect(c.title).toBe('Six days across Sri Lanka');
    expect(c.totalLabel).toBe('Total · 6 days');
    expect(c.legs).toBeNull(); // shape, never the leg list
    // Exactly the four approved facts, in order.
    expect(c.facts.map((f) => f.k)).toEqual(['Trip', 'Days', 'Travellers', 'Starts']);
    expect(c.facts[0].v).toBe('Colombo Airport (CMB) → Galle');
    expect(c.facts[0].sub).toContain('day-by-day');
    expect(c.facts[1].v).toBe('6 with your driver');
    expect(c.facts[2].v).toBe('4 · Van'); // pax from tool, vehicle label mapped
    expect(c.facts[3].v).toBe('Wed 12 Aug');
  });

  it('uses digits past twelve — the 18-day monster', () => {
    const c = payPageCopy(quoteOf({
      product: 'chauffeur',
      legs: [leg('Colombo Airport (CMB)', 'Colombo Airport (CMB)', '2026-09-03')],
      firstDate: '2026-09-03', lastDate: '2026-09-20',
    }));
    expect(c.title).toBe('18 days across Sri Lanka');
    expect(c.totalLabel).toBe('Total · 18 days');
  });
});

describe('payPageCopy — fallbacks', () => {
  it('omits the greeting when there is no name', () => {
    expect(payPageCopy(quoteOf({ name: null })).greetingName).toBeNull();
    expect(payPageCopy(quoteOf({ name: '  ' })).greetingName).toBeNull();
  });

  it('falls back to first → last stop on an unresolvable shape', () => {
    const q = quoteOf({ legs: [leg('Somewhere', 'Elsewhere')] });
    (q.request as { engine: unknown }).engine = null;
    const c = payPageCopy(q);
    expect(c.title).toBe('Somewhere → Elsewhere');
  });

  it('maps vehicle tiers to customer words', () => {
    expect(payPageCopy(quoteOf({ vehicle: 'van_14' })).facts.find((f) => f.k === 'Vehicle')?.v).toMatch(/van/i);
    expect(payPageCopy(quoteOf({ vehicle: 'custom' })).facts.find((f) => f.k === 'Vehicle')?.v).toMatch(/vehicle/i);
  });
});

// The chauffeur pax fact needs passengerCount — pin that it reads the tool, not a default.
describe('payPageCopy — reads the tool payload', () => {
  it('travellers come from passengerCount', () => {
    const c = payPageCopy(quoteOf({
      product: 'chauffeur', vehicle: 'van_6',
      legs: [leg('A', 'B', '2026-08-12')],
      toolExtra: { passengerCount: 4 },
      firstDate: '2026-08-12', lastDate: '2026-08-17',
    }));
    expect(c.facts.find((f) => f.k === 'Travellers')?.v).toBe('4 · Van');
  });
});

// A partial-leg link (spec 2026-08-04) pays for SOME legs. Before this, every word on the page
// still described the whole trip — the total line literally read "all 4 journeys" over a
// two-leg payment. Owner-caught in PROD, 2026-08-05.
describe('payPageCopy — partial link', () => {
  const fourLegs = [
    leg('Colombo Airport (CMB)', 'Unawatuna', '2026-08-07'),
    leg('Unawatuna', 'Trincomalee', '2026-08-12'),
    leg('Trincomalee', 'Sigiriya', '2026-08-14'),
    leg('Sigiriya', 'Colombo Airport (CMB)', '2026-08-16'),
  ];
  const q = quoteOf({ legs: fourLegs, name: 'Kirsty' });
  const covering = (legIndexes: number[]) => payPageCopy(q, { legIndexes, extraIndexes: [] });

  it('never claims the payment covers all of them', () => {
    const copy = covering([0, 2]);
    expect(copy.totalLabel).not.toMatch(/all/i);
    expect(copy.totalLabel).toContain('2 of');
    expect(copy.title).not.toMatch(/^Four journeys/);
  });

  it('marks which journeys the payment covers', () => {
    const copy = covering([0, 2]);
    expect(copy.legs!.map((l) => l.covered)).toEqual([true, false, true, false]);
    // Every journey still shown — the customer keeps sight of the whole trip.
    expect(copy.legs).toHaveLength(4);
  });

  it('does not promise driver and fuel on journeys nobody paid for', () => {
    expect(covering([0, 2]).includedText).not.toMatch(/every journey/i);
  });

  it('is unchanged when the selection covers everything', () => {
    const full = payPageCopy(q, { legIndexes: [0, 1, 2, 3], extraIndexes: [] });
    expect(full).toEqual(payPageCopy(q));
  });

  it('is unchanged with no selection at all', () => {
    const copy = payPageCopy(q);
    expect(copy.totalLabel).toBe('Total · all 4 journeys');
    expect(copy.legs!.every((l) => l.covered === undefined)).toBe(true);
  });
});
