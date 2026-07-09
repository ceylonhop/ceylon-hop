import { describe, it, expect } from 'vitest';
import {
  renderPricingBlock,
  injectPricingBlock,
  PRICING_BEGIN,
  PRICING_END,
} from '../../tools/generate-pricing.mjs';

const payload = {
  perKm: { car: 0.35, van: 0.47 },
  floors: { car: 29, van: 50 },
  bufferPct: 10,
  chauffeurDayFee: 35,
  depositPct: 0.1,
  depositCap: 50,
  extras: { sightseeing: 10, 'safari-wait': 19, luggage: 5, front: 8, flex: 12, waiting: 10 },
  corridorSeat: { 'airport-cultural': 19, 'ella-east': 23 },
};

describe('injectPricingBlock', () => {
  it('replaces the fenced block and is idempotent', () => {
    const src = `head\n  ${PRICING_BEGIN}\n  const PER_KM = {"car":0.01};\n  ${PRICING_END}\ntail`;
    const once = injectPricingBlock(src, payload);
    expect(once).toContain('"car":0.35');
    expect(once).toContain('head');
    expect(once).toContain('tail');
    // running the generator on already-generated output must be a no-op
    expect(injectPricingBlock(once, payload)).toBe(once);
  });

  it('throws when the sentinels are missing', () => {
    expect(() => injectPricingBlock('no markers here', payload)).toThrow(/sentinel/i);
  });
});

describe('renderPricingBlock', () => {
  it('renders EXTRAS and CORRIDOR_SEAT with quoted keys', () => {
    const block = renderPricingBlock(payload);
    expect(block).toContain('"safari-wait":19');
    expect(block).toContain('"ella-east":23');
    expect(block).toContain('const BUFFER_PCT = 10;');
  });
});
