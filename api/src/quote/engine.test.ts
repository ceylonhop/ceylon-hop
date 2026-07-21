// api/src/quote/engine.test.ts
import { describe, it, expect } from 'vitest';
import { quote } from './engine';
import { RATE_CARD, type RateCard } from './rateCard';
import type { QuoteRequest } from './types';

describe('quote()', () => {
  it('applies one final-price adjustment after private core pricing', () => {
    const r = quote({ product: 'private', vehicle: 'custom', pax: 20, bags: 15, legs: [{ from: 'A', to: 'B', distanceKm: 140 }] });
    expect(r.subtotalCents).toBe(30993);
    expect(r.totalCents).toBe(30900);
    expect(r.lineItems.at(-1)).toMatchObject({
      label: 'Final price adjustment',
      amountCents: -93,
      meta: { kind: 'price_adjustment', strategy: 'charm' },
    });
    expect(r.marginEstimateCents).toBe(30900 - Math.round(154 * 175));
  });

  it('does not apply final-price finishing to shared-seat pricing', () => {
    const r = quote({ product: 'shared', legs: [{ routeId: 'test', seats: 1, seatPriceCents: 8099 }] });
    expect(r.subtotalCents).toBe(8099);
    expect(r.totalCents).toBe(8099);
    expect(r.lineItems.some((item) => item.meta?.kind === 'price_adjustment')).toBe(false);
  });

  it('private single leg with deposit = full total (Tatia Kandy→Nanu Oya 80km→bill 88km = $30.80)', () => {
    const r = quote({ product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }] });
    expect(r.subtotalCents).toBe(3542); // core: 88km × 40.25¢ = 3542
    expect(r.totalCents).toBe(3550); // final-price fallback rounds to the nearest 50¢
    expect(r.amountDueNowCents).toBe(3550);
    expect(r.rateCardVersion).toBe(RATE_CARD.version);
    expect(r.marginEstimateCents).toBe(470); // 3550 - (88km × 35¢ cost = 3080)
  });

  it('prices the SAME request against a GIVEN (locked-snapshot) rate card, not just the global one', () => {
    const req: QuoteRequest = { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'A', to: 'B', distanceKm: 200 }] };
    const current = quote(req);
    expect(current.rateCardVersion).toBe(RATE_CARD.version);
    // A locked snapshot with a cheaper car per-km + its own version → a different total for the SAME
    // request. This is the rate-lock path: a quote prices against the card frozen at its generation.
    const locked = { ...RATE_CARD, version: 'locked-test', perKmCents: { ...RATE_CARD.perKmCents, car: 20 } };
    const r = quote(req, locked);
    expect(r.rateCardVersion).toBe('locked-test');
    expect(r.totalCents).toBe(215 * 20); // 200km → bill 215km after the 15km max buffer × 20¢ = 4300
    expect(r.totalCents).not.toBe(current.totalCents);
  });

  it('does not retrofit final-price finishing onto a historical locked rate card', () => {
    const historicalCard: RateCard = { ...RATE_CARD };
    delete historicalCard.priceFinishing;
    const r = quote(
      { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }] },
      historicalCard,
    );
    expect(r.subtotalCents).toBe(3542);
    expect(r.totalCents).toBe(3542);
    expect(r.priceStrategy).toBe('unchanged');
  });

  it('private with extras adds them to the total', () => {
    const r = quote({ product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }], extras: ['sightseeing'] });
    expect(r.subtotalCents).toBe(3542 + 1000);
    expect(r.totalCents).toBe(4550);
  });

  it('chauffeur → amountDueNow is the full total for now (Emma $708.92)', () => {
    const r = quote({
      product: 'chauffeur', vehicle: 'car', firstDate: '2026-02-14', lastDate: '2026-02-22',
      travelDays: [
        { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
        { date: '2026-02-16', from: 'Kandy', to: 'Sigiriya day trip', distanceKm: 200 },
        { date: '2026-02-17', from: 'Kandy', to: 'Ella', distanceKm: 140 },
        { date: '2026-02-19', from: 'Ella', to: 'Bentota', distanceKm: 230 },
        { date: '2026-02-22', from: 'Bentota', to: 'Airport', distanceKm: 110 },
      ],
    });
    expect(r.subtotalCents).toBe(70892);
    expect(r.totalCents).toBe(69900);
    expect(r.amountDueNowCents).toBe(69900);
    // day 9×$31.05=27945 + distance: per-leg buffered travel is 132+215+154+245+121=867, plus 4 idle × 50 min (car) = 1067 → 1067×40.25¢=42947
    // costCents: 9×2700 day-cost + Math.round(1067 × 35¢/km) = 24300 + 37345 = 61645 → margin = 69900 − 61645 = 8255
    expect(r.marginEstimateCents).toBe(8255);
  });

  it('chauffeur: sightseeing + waiting are included in day rate → total unchanged, warnings note both', () => {
    const base = {
      product: 'chauffeur' as const, vehicle: 'car' as const, firstDate: '2026-02-14', lastDate: '2026-02-22',
      travelDays: [
        { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
      ],
    };
    const withExtras = quote({ ...base, extras: ['sightseeing', 'waiting'] });
    const withoutExtras = quote(base);
    expect(withExtras.totalCents).toBe(withoutExtras.totalCents);
    expect(withExtras.warnings.some((w) => w.includes('sightseeing') && w.includes('included in chauffeur day rate'))).toBe(true);
    expect(withExtras.warnings.some((w) => w.includes('waiting') && w.includes('included in chauffeur day rate'))).toBe(true);
  });

  it('chauffeur: luggage is still charged (not an included extra)', () => {
    const base = {
      product: 'chauffeur' as const, vehicle: 'car' as const, firstDate: '2026-02-14', lastDate: '2026-02-22',
      travelDays: [
        { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
      ],
    };
    const withoutExtras = quote(base);
    const withLuggage = quote({ ...base, extras: ['luggage'] });
    expect(withLuggage.subtotalCents).toBe(withoutExtras.subtotalCents + RATE_CARD.extras.luggage);
  });

  it('chauffeur: sightseeing + luggage → only luggage added, sightseeing warned as included', () => {
    const base = {
      product: 'chauffeur' as const, vehicle: 'car' as const, firstDate: '2026-02-14', lastDate: '2026-02-22',
      travelDays: [
        { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
      ],
    };
    const withoutExtras = quote(base);
    const r = quote({ ...base, extras: ['sightseeing', 'luggage'] });
    expect(r.subtotalCents).toBe(withoutExtras.subtotalCents + RATE_CARD.extras.luggage);
    expect(r.warnings.some((w) => w.includes('sightseeing') && w.includes('included in chauffeur day rate'))).toBe(true);
  });

  it('chauffeur: safari-wait is included and not charged', () => {
    const base = {
      product: 'chauffeur' as const, vehicle: 'car' as const, firstDate: '2026-02-14', lastDate: '2026-02-22',
      travelDays: [
        { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
      ],
    };
    const withoutExtras = quote(base);
    const r = quote({ ...base, extras: ['safari-wait'] });
    expect(r.totalCents).toBe(withoutExtras.totalCents);
    expect(r.warnings.some((w) => w.includes('safari-wait') && w.includes('included in chauffeur day rate'))).toBe(true);
  });

  it('private: sightseeing is still charged (included-in-chauffeur rule does not apply to private)', () => {
    const r = quote({ product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }], extras: ['sightseeing'] });
    expect(r.subtotalCents).toBe(3542 + 1000);
    expect(r.totalCents).toBe(4550);
    expect(r.warnings.some((w) => w.includes('included in chauffeur day rate'))).toBe(false);
  });

  it('shared total (Hakan $22 incl pickup)', () => {
    const r = quote({ product: 'shared', legs: [{ routeId: 'negombo->sigiriya', seats: 1, seatPriceCents: 1900, colomboPickup: true }] });
    expect(r.totalCents).toBe(2200);
  });

  it('throws TOO_BIG only when pax exceeds custom capacity (>99)', () => {
    expect(() => quote({ product: 'private', vehicle: 'custom', pax: 120, bags: 1, legs: [{ from: 'A', to: 'B', distanceKm: 10 }] })).toThrow('TOO_BIG');
  });

  it('never undercharges: car requested for 6 pax is priced as the required van', () => {
    const r = quote({ product: 'private', vehicle: 'car', pax: 6, bags: 1, legs: [{ from: 'A', to: 'B', distanceKm: 100 }] });
    expect(r.subtotalCents).toBe(5946); // core: 100km → bill 110km × van 54.05¢
    expect(r.totalCents).toBe(5900);
    expect(r.warnings.some((w) => w.includes('vehicle set to van'))).toBe(true);
  });

  // New van9 / van14 / custom tier tests
  it('van9: 140km private (1 leg, pax under cap) → 154 billableKm × 54.05¢ = 8324¢', () => {
    const r = quote({ product: 'private', vehicle: 'van9', pax: 8, bags: 4, legs: [{ from: 'A', to: 'B', distanceKm: 140 }] });
    expect(r.subtotalCents).toBe(8324); // core: 154km × 54.05¢ sell
    expect(r.totalCents).toBe(8300);
    expect(r.marginEstimateCents).toBe(8300 - Math.round(154 * 47)); // 154 × 47¢ cost
  });

  it('van14: 140km private → 154 billableKm × 55.2¢ = 8501¢ (just over $85 floor)', () => {
    const r = quote({ product: 'private', vehicle: 'van14', pax: 12, bags: 8, legs: [{ from: 'A', to: 'B', distanceKm: 140 }] });
    expect(r.subtotalCents).toBe(8501); // core: round(154 × 55.2) = 8501
    expect(r.totalCents).toBe(8500);
  });

  it('custom: 140km private → 154 billableKm × 201.25¢ = 30993¢', () => {
    const r = quote({ product: 'private', vehicle: 'custom', pax: 20, bags: 15, legs: [{ from: 'A', to: 'B', distanceKm: 140 }] });
    expect(r.subtotalCents).toBe(30993); // core: 154km × 201.25¢
    expect(r.totalCents).toBe(30900);
  });

  it('van9: 20km private → floor 5000¢ applies (raw 25km × 54.05¢ = 1351 < 5000)', () => {
    const r = quote({ product: 'private', vehicle: 'van9', pax: 8, bags: 4, legs: [{ from: 'A', to: 'B', distanceKm: 20 }] });
    expect(r.subtotalCents).toBe(5000); // core minimum fare remains intact
    expect(r.totalCents).toBe(5000); // final-price policy must not undercut the configured floor
    expect(r.marginEstimateCents).toBe(5000 - Math.round(25 * 47));
  });

  it('preserves the sum of per-leg minimum fares when finishing a multi-leg private quote', () => {
    const r = quote({
      product: 'private', vehicle: 'van', pax: 4, bags: 2,
      legs: [
        { from: 'A', to: 'B', distanceKm: 10 },
        { from: 'B', to: 'C', distanceKm: 10 },
      ],
    });
    expect(r.subtotalCents).toBe(10000);
    expect(r.totalCents).toBe(10000);
  });

  it('anti-tamper: car requested for 8 pax is priced as van9 with warning', () => {
    const r = quote({ product: 'private', vehicle: 'car', pax: 8, bags: 2, legs: [{ from: 'A', to: 'B', distanceKm: 140 }] });
    expect(r.subtotalCents).toBe(8324); // core van9 price ($0.5405/km)
    expect(r.totalCents).toBe(8300);
    expect(r.warnings.some((w) => w.includes('vehicle set to van9'))).toBe(true);
  });

  it('anti-tamper: custom requested for 2 pax is priced as custom (no downgrade)', () => {
    const r = quote({ product: 'private', vehicle: 'custom', pax: 2, bags: 0, legs: [{ from: 'A', to: 'B', distanceKm: 140 }] });
    expect(r.subtotalCents).toBe(30993); // core custom 154km × 201.25¢
    expect(r.totalCents).toBe(30900);
    expect(r.warnings.filter((w) => w.includes('vehicle set to'))).toHaveLength(0); // no warning — custom is already >= required (car)
  });

  // GL-1d: van14/custom have no fixed owner rate — they are custom-priced per quote
  // (owner decision 2026-07-02). The operator supplies customPerKmCents; the rate-card
  // values remain only prefill defaults.
  describe('customPerKmCents (van14/custom are custom-priced per quote)', () => {
    it('van14 private: overridden rate replaces the rate-card per-km', () => {
      const r = quote({ product: 'private', vehicle: 'van14', pax: 12, bags: 8, legs: [{ from: 'A', to: 'B', distanceKm: 140 }], customPerKmCents: 90 });
      expect(r.subtotalCents).toBe(154 * 90); // core: 13860, not the placeholder 130¢
      expect(r.totalCents).toBe(13850);
      // margin: cost/km = round(override / 1.15) (15% markup)
      expect(r.marginEstimateCents).toBe(13850 - Math.round(154 * Math.round(90 / 1.15)));
    });

    it('custom chauffeur: overridden rate drives the distance charge', () => {
      const r = quote({
        product: 'chauffeur', vehicle: 'custom', firstDate: '2026-08-01', lastDate: '2026-08-02',
        travelDays: [
          { date: '2026-08-01', from: 'A', to: 'B', distanceKm: 100 },
          { date: '2026-08-02', from: 'B', to: 'C', distanceKm: 50 },
        ],
        customPerKmCents: 200,
      });
      // 2 days × $31.05 + billable 165km (100→110 and 50→55) × $2.00 = 6210 + 33000
      expect(r.subtotalCents).toBe(6210 + 33000);
      expect(r.totalCents).toBe(38900);
    });

    it('chauffeur upgrades an undersized vehicle to fit pax/bags (like private)', () => {
      const r = quote({
        product: 'chauffeur', vehicle: 'car', pax: 6, bags: 6, firstDate: '2026-08-01', lastDate: '2026-08-02',
        travelDays: [
          { date: '2026-08-01', from: 'A', to: 'B', distanceKm: 100 },
          { date: '2026-08-02', from: 'B', to: 'C', distanceKm: 50 },
        ],
      });
      // car (3 pax/bags) can't hold 6 → priced as van. distance uses van 54.05¢, not car 40.25¢.
      expect(r.warnings.some((w) => /vehicle set to van/.test(w))).toBe(true);
      // 2 days × $31.05 + billable 165km (100→110 and 50→55, 0 idle) × van 54.05¢ = 6210 + round(165×54.05)=8918
      expect(r.subtotalCents).toBe(6210 + 8918);
      expect(r.totalCents).toBe(14900);
    });

    it('does not upgrade a chauffeur vehicle that already fits', () => {
      const r = quote({
        product: 'chauffeur', vehicle: 'van', pax: 4, bags: 4, firstDate: '2026-08-01', lastDate: '2026-08-02',
        travelDays: [{ date: '2026-08-01', from: 'A', to: 'B', distanceKm: 100 }, { date: '2026-08-02', from: 'B', to: 'C', distanceKm: 50 }],
      });
      expect(r.warnings.some((w) => /vehicle set to/.test(w))).toBe(false);
    });

    it('floor still applies under an overridden rate', () => {
      const r = quote({ product: 'private', vehicle: 'van14', pax: 12, bags: 8, legs: [{ from: 'A', to: 'B', distanceKm: 10 }], customPerKmCents: 90 });
      expect(r.totalCents).toBe(8500); // 15km × 90¢ = 1350 < van14 floor $85
    });

    it('throws when the priced vehicle is not van14/custom', () => {
      expect(() => quote({ product: 'private', vehicle: 'car', pax: 2, bags: 1, legs: [{ from: 'A', to: 'B', distanceKm: 100 }], customPerKmCents: 90 }))
        .toThrow('CUSTOM_RATE_ONLY_FOR_CUSTOM_TIERS');
    });

    it('anti-tamper upgrade INTO van14 keeps the override (rate set for the trip, tier is capacity)', () => {
      const r = quote({ product: 'private', vehicle: 'van9', pax: 12, bags: 8, legs: [{ from: 'A', to: 'B', distanceKm: 140 }], customPerKmCents: 90 });
      expect(r.subtotalCents).toBe(154 * 90);
      expect(r.totalCents).toBe(13850);
      expect(r.warnings.some((w) => w.includes('vehicle set to van14'))).toBe(true);
    });
  });

  // ── Multi-stop rides (phase 1): the engine accepts Ride-shaped legs/days alongside the
  // old point-to-point shape, normalizing once at entry. Floors + protected minimum are
  // counted PER RIDE (a 3-stop ride is ONE ride, not two legs). ──────────────────────────
  describe('multi-stop rides', () => {
    it('private: a 3-stop ride is buffered ONCE as a single ride (not per segment)', () => {
      const r = quote({ product: 'private', vehicle: 'car', pax: 2, bags: 2,
        legs: [{ stops: ['Kandy', 'Dambulla', 'Habarana'], segmentKms: [72, 23] }] });
      // raw 95km buffered once → +10 → billable 105; round(105 × 40.25¢) = 4226 (one leg line, above floor).
      // (The old 2-leg spelling of the same day buffers each leg → 79+28 = 107 billable, 6080¢ — see goldens.)
      expect(r.subtotalCents).toBe(4226);
      expect(r.lineItems[0].label).toBe('Kandy → Dambulla → Habarana (car)');
      expect(r.marginEstimateCents).toBe(r.totalCents - Math.round(105 * 35)); // cost per RIDE, single buffer
    });

    it('private: mixing an old-shape leg and a 3-stop ride — floors + protected minimum counted per ride (2)', () => {
      // Two rides that both price to the van floor. subtotal = 2 × 5000. The charm candidate
      // (9900, a 1% cut within the 2.5% cap) is blocked ONLY by protectedMinimum = 2 rides × 5000.
      // If the engine miscounted rides (e.g. 1), the finish would slip to 9900.
      const r = quote({ product: 'private', vehicle: 'van', pax: 4, bags: 4, legs: [
        { from: 'A', to: 'B', distanceKm: 10 },                        // old-shape ride → floor 5000
        { stops: ['C', 'D', 'E'], segmentKms: [5, 5] },               // 3-stop ride, raw 10 → floor 5000
      ] });
      expect(r.subtotalCents).toBe(10000);
      expect(r.totalCents).toBe(10000); // protected minimum (2 × 5000) forbids the downward finish
    });

    it('private: an invalid ride (segment count mismatch) surfaces INVALID_RIDE from quote()', () => {
      expect(() => quote({ product: 'private', vehicle: 'car', pax: 2, bags: 2,
        legs: [{ stops: ['A', 'B', 'C'], segmentKms: [10] }] })).toThrow('INVALID_RIDE');
    });

    it('chauffeur: an invalid ride day (repeated consecutive stop) surfaces INVALID_RIDE', () => {
      expect(() => quote({ product: 'chauffeur', vehicle: 'car', firstDate: '2026-08-01', lastDate: '2026-08-01',
        travelDays: [{ date: '2026-08-01', stops: ['A', 'A'], segmentKms: [10] }] })).toThrow('INVALID_RIDE');
    });

    it('chauffeur: a multi-stop ride day prices off its summed segments (single travel buffer)', () => {
      const r = quote({ product: 'chauffeur', vehicle: 'car', firstDate: '2026-08-01', lastDate: '2026-08-01',
        travelDays: [{ date: '2026-08-01', stops: ['A', 'B', 'C'], segmentKms: [100, 50] }] });
      // 1 day × $31.05 + billable 165km (raw 150 + 15 max buffer) × 40.25¢ = 3105 + 6641
      expect(r.subtotalCents).toBe(3105 + 6641);
    });
  });

  it('throws NO_LEGS on an empty private request', () => {
    expect(() => quote({ product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [] })).toThrow('NO_LEGS');
  });

  it('throws NO_LEGS on an empty chauffeur request', () => {
    expect(() => quote({ product: 'chauffeur', vehicle: 'car', firstDate: '2026-01-01', lastDate: '2026-01-01', travelDays: [] })).toThrow('NO_LEGS');
  });

  it('shared product has marginEstimateCents === null (cost not modelled)', () => {
    const r = quote({ product: 'shared', legs: [{ routeId: 'negombo->sigiriya', seats: 1, seatPriceCents: 1900, colomboPickup: false }] });
    expect(r.marginEstimateCents).toBeNull();
  });
});

describe('invariants', () => {
  const CASES: { label: string; req: QuoteRequest }[] = [
    {
      label: 'private (car, 2 pax, 80 km)',
      req: { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }] },
    },
    {
      label: 'chauffeur (car, Emma)',
      req: {
        product: 'chauffeur', vehicle: 'car', firstDate: '2026-02-14', lastDate: '2026-02-22',
        travelDays: [
          { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
          { date: '2026-02-16', from: 'Kandy', to: 'Sigiriya day trip', distanceKm: 200 },
          { date: '2026-02-17', from: 'Kandy', to: 'Ella', distanceKm: 140 },
          { date: '2026-02-19', from: 'Ella', to: 'Bentota', distanceKm: 230 },
          { date: '2026-02-22', from: 'Bentota', to: 'Airport', distanceKm: 110 },
        ],
      },
    },
    {
      label: 'shared (Hakan, 1 seat + pickup)',
      req: { product: 'shared', legs: [{ routeId: 'negombo->sigiriya', seats: 1, seatPriceCents: 1900, colomboPickup: true }] },
    },
  ];

  for (const { label, req } of CASES) {
    it(`${label}: totalCents is a non-negative integer`, () => {
      const r = quote(req);
      expect(r.totalCents).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.totalCents)).toBe(true);
    });
    it(`${label}: depositCents does not exceed RATE_CARD cap`, () => {
      const r = quote(req);
      expect(r.depositCents).toBeLessThanOrEqual(RATE_CARD.deposit.capCents);
    });
    it(`${label}: amountDueNowCents does not exceed totalCents`, () => {
      const r = quote(req);
      expect(r.amountDueNowCents).toBeLessThanOrEqual(r.totalCents);
    });
    it(`${label}: every lineItem.amountCents is an integer`, () => {
      const r = quote(req);
      for (const item of r.lineItems) {
        expect(Number.isInteger(item.amountCents)).toBe(true);
      }
    });
  }
});
