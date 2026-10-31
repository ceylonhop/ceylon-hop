import { describe, expect, it } from 'vitest';
import {
  WebQuoteIntentSchema,
  canonicalJson,
  fingerprintIntent,
} from './webQuoteV2';

const privateIntent = {
  product: 'private',
  routeId: 'cmb-kandy',
  vehicle: 'car',
  pax: 2,
  bags: 1,
  legs: [{ from: 'Colombo Airport (CMB)', to: 'Kandy' }],
  extras: ['meet_greet'],
};

describe('web quote v2 canonical intent', () => {
  it('serializes object keys stably while preserving array order', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 }, list: ['b', 'a'] })).toBe(
      '{"a":{"x":3,"y":2},"list":["b","a"],"z":1}',
    );
    expect(
      fingerprintIntent(privateIntent),
    ).toBe(
      fingerprintIntent({
        extras: ['meet_greet'],
        legs: [{ to: 'Kandy', from: 'Colombo Airport (CMB)' }],
        bags: 1,
        pax: 2,
        vehicle: 'car',
        routeId: 'cmb-kandy',
        product: 'private',
      }),
    );
  });

  it.each([
    { ...privateIntent, vehicle: 'van' },
    { ...privateIntent, pax: 3 },
    { ...privateIntent, bags: 2 },
    { ...privateIntent, routeId: 'cmb-ella' },
    { ...privateIntent, extras: [] },
    { ...privateIntent, legs: [{ from: 'Colombo Airport (CMB)', to: 'Ella' }] },
  ])('changes the fingerprint when a price-bearing intent field changes', (changed) => {
    expect(fingerprintIntent(changed)).not.toBe(fingerprintIntent(privateIntent));
  });

  it.each([
    { distanceKm: 120 },
    { totalCents: 4_000 },
    { currency: 'USD' },
    { rateCardVersion: 'attacker-card' },
    { seatPriceCents: 1 },
    { customPerKmCents: 1 },
  ])('rejects client-authored pricing field %o', (extra) => {
    expect(WebQuoteIntentSchema.safeParse({ ...privateIntent, ...extra }).success).toBe(false);
  });

  it('normalizes omitted extras without changing later fingerprints', () => {
    const parsed = WebQuoteIntentSchema.parse({ ...privateIntent, extras: undefined });
    expect(parsed.extras).toEqual([]);
    expect(fingerprintIntent(parsed)).toBe(
      fingerprintIntent({ ...privateIntent, extras: [] }),
    );
  });
});

import { MAX_SEGMENTS_PER_INTENT, MAX_VIA_PER_LEG, intentSegments } from './webQuoteV2';

describe('web quote v2 — stops on the way (via)', () => {
  const leg = (via?: string[]) => ({ from: 'Kandy', to: 'Sigiriya / Dambulla', ...(via ? { via } : {}) });
  const intentWith = (legs: unknown[]) => ({ ...privateIntent, routeId: undefined, legs, extras: [] });

  it('accepts up to MAX_VIA_PER_LEG stops on a private leg and on a chauffeur day', () => {
    const four = ['Pinnawala', 'Kurunegala', 'Dambulla', 'Habarana'];
    expect(WebQuoteIntentSchema.safeParse(intentWith([leg(four)])).success).toBe(true);
    const day = { product: 'chauffeur', vehicle: 'car', pax: 2, bags: 1, firstDate: '2026-12-01', lastDate: '2026-12-01',
      travelDays: [{ date: '2026-12-01', from: 'Kandy', to: 'Ella', via: four }], extras: [] };
    expect(WebQuoteIntentSchema.safeParse(day).success).toBe(true);
    expect(MAX_VIA_PER_LEG).toBe(4);
  });

  it('refuses a fifth stop on one leg', () => {
    expect(WebQuoteIntentSchema.safeParse(intentWith([leg(['a', 'b', 'c', 'd', 'e'])])).success).toBe(false);
  });

  it('refuses a blank stop', () => {
    expect(WebQuoteIntentSchema.safeParse(intentWith([leg([' '])])).success).toBe(false);
  });

  it('caps the whole intent at MAX_SEGMENTS_PER_INTENT billed segments', () => {
    expect(MAX_SEGMENTS_PER_INTENT).toBe(12);
    const twelve = intentWith([leg(['a', 'b']), leg(['a', 'b']), leg(['a', 'b']), leg(['a', 'b'])]); // 4 × 3 = 12
    expect(WebQuoteIntentSchema.safeParse(twelve).success).toBe(true);
    const thirteen = intentWith([leg(['a', 'b']), leg(['a', 'b']), leg(['a', 'b']), leg(['a', 'b']), leg()]); // 13
    expect(WebQuoteIntentSchema.safeParse(thirteen).success).toBe(false);
    expect(intentSegments(WebQuoteIntentSchema.parse(twelve))).toBe(12);
  });

  it('keeps every existing intent fingerprint: an absent via is not written as []', () => {
    const existing = { ...privateIntent, extras: [] };
    expect(fingerprintIntent(WebQuoteIntentSchema.parse(existing))).toBe(fingerprintIntent(existing));
  });

  it('fingerprints stop order', () => {
    const a = fingerprintIntent(WebQuoteIntentSchema.parse(intentWith([leg(['Pinnawala', 'Dambulla'])])));
    const b = fingerprintIntent(WebQuoteIntentSchema.parse(intentWith([leg(['Dambulla', 'Pinnawala'])])));
    expect(a).not.toBe(b);
  });
});
