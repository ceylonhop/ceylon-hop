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
