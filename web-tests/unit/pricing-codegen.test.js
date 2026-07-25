import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  renderPricingBlock,
  injectPricingBlock,
  applySharedPrices,
  PRICING_BEGIN,
  PRICING_END,
} from '../../tools/generate-pricing.mjs';
import { loadTransfers } from './_load.js';
// Import the REAL payload builder straight from api/ — vitest/esbuild transpiles the TS, so this
// needs no `tsx` and no api node_modules (rateCard.ts + departureRepo.ts import nothing external).
// The generator's own readPayload() shells out to `npm run dump:pricing` at generate time, which is
// fine there (tsx is available); the CI web-tests job has no api deps, so the test must not shell out.
import { buildPricingPayload } from '../../api/src/quote/pricingPayload.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routesPath = path.resolve(__dirname, '../../routes-data.js');

const payload = {
  perKm: { car: 0.35, van: 0.47 },
  floors: { car: 29, van: 50 },
  bufferPct: 10,
  priceFinishing: { maxReductionBps: 250, roundToCents: 50 },
  chauffeurDayFee: 35,
  chauffeurIdleMinKm: { car: 55, van: 110 },
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
    expect(block).toContain('const PRICE_FINISHING = {"maxReductionBps":250,"roundToCents":50};');
    expect(block).toContain('const CHAUFFEUR_IDLE_MIN_KM = {"car":55,"van":110};');
  });
});

describe('applySharedPrices', () => {
  it('rewrites a tampered shared-route price back to its corridor seat', () => {
    const T = loadTransfers();
    const src = readFileSync(routesPath, 'utf8');
    // Tamper ella-yala's price; ella-yala is on the ella-east corridor (seat 23).
    const tampered = src.replace(/(id:'ella-yala',[\s\S]*?price:\s*)\d+/, '$1999');
    expect(tampered).toContain('price:999');
    const out = applySharedPrices(tampered, T);
    expect(out).not.toContain('price:999');
    expect(out).toMatch(/id:'ella-yala',[\s\S]*?price:23/);
  });

  it('leaves an already-correct catalogue untouched (idempotent)', () => {
    const T = loadTransfers();
    const src = readFileSync(routesPath, 'utf8');
    expect(applySharedPrices(src, T)).toBe(applySharedPrices(applySharedPrices(src, T), T));
  });
});

// The real enforcement: if someone edits the backend rate card and forgets `npm run generate`,
// or hand-edits a generated value, these fail in CI. `readPayload()` runs the actual api dump.
describe('codegen freshness + parity (enforcement)', () => {
  const transfersPath = path.resolve(__dirname, '../../transfers-data.js');
  const backendPayload = buildPricingPayload(); // pure, in-process — no subprocess, safe at collection

  it('FRESHNESS: committed transfers-data.js pricing block matches the backend', () => {
    const src = readFileSync(transfersPath, 'utf8');
    expect(injectPricingBlock(src, backendPayload)).toBe(src);
  });

  it('FRESHNESS: committed routes-data.js shared prices match the corridors', () => {
    const src = readFileSync(routesPath, 'utf8');
    expect(applySharedPrices(src, loadTransfers())).toBe(src);
  });

  it('PARITY: window.TRANSFERS constants equal the backend payload', () => {
    const T = loadTransfers();
    expect(T.PER_KM).toEqual(backendPayload.perKm);
    expect(T.FLOORS).toEqual(backendPayload.floors);
    expect(T.BUFFER_PCT).toBe(backendPayload.bufferPct);
    expect(T.PRICE_FINISHING).toEqual(backendPayload.priceFinishing);
    expect(T.CHAUFFEUR_DAY_FEE).toBe(backendPayload.chauffeurDayFee);
    expect(T.CHAUFFEUR_IDLE_MIN_KM).toEqual(backendPayload.chauffeurIdleMinKm);
    expect(T.DEPOSIT_PCT).toBe(backendPayload.depositPct);
    expect(T.DEPOSIT_CAP).toBe(backendPayload.depositCap);
    // completeness: every backend extra is present with the right price (the booking.js
    // copy that once omitted safari-wait/waiting can never recur).
    expect(T.EXTRAS).toEqual(backendPayload.extras);
  });
});
