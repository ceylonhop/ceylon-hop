import { describe, it, expect } from 'vitest';
import { RATE_CARD } from './rateCard';
import { quote } from './engine';
import {
  rateInputsSchema, ratesFromCard, applyRates, readStoredRates, revisionVersion, previewSamples, PREVIEW_SAMPLES,
} from './rateRevision';

const DEFAULTS = ratesFromCard(RATE_CARD);

describe('the editable rate set', () => {
  it('today\'s code card is a valid rate set', () => {
    expect(rateInputsSchema.safeParse(DEFAULTS).success).toBe(true);
    expect(DEFAULTS.perKmCents).toEqual({ car: 40.25, van: 54.05, van9: 54.05, van14: 55.2, custom: 201.25 });
    expect(DEFAULTS.dayRateCents).toBe(3105);
    expect(DEFAULTS.extrasCents).toEqual({ sightseeing: 1000, 'safari-wait': 1900, luggage: 500, front: 800, flex: 1200, waiting: 1000 });
  });

  it('applying the code card\'s own rates gives back the code card exactly', () => {
    expect(applyRates(RATE_CARD, DEFAULTS, RATE_CARD.version)).toEqual(RATE_CARD);
  });

  it('a saved price is used as typed — no margin is added — and what is not editable stays', () => {
    const card = applyRates(RATE_CARD, { ...DEFAULTS, perKmCents: { ...DEFAULTS.perKmCents, car: 45 } }, '2026-09-27.1');
    expect(card.perKmCents.car).toBe(45);
    expect(card.version).toBe('2026-09-27.1');
    expect(card.markupPct).toBe(RATE_CARD.markupPct);
    expect(card.deposit).toEqual(RATE_CARD.deposit);
    expect(card.vehicle).toEqual(RATE_CARD.vehicle);
    expect(card.chauffeur.idleMinKm).toEqual(RATE_CARD.chauffeur.idleMinKm);
    expect(card.priceFinishing).toEqual(RATE_CARD.priceFinishing);
    expect(card.shared).toEqual(RATE_CARD.shared);
  });

  it.each([
    ['a per-km price with 3 decimal places', { perKmCents: { ...DEFAULTS.perKmCents, car: 40.255 } }],
    ['a zero per-km price', { perKmCents: { ...DEFAULTS.perKmCents, car: 0 } }],
    ['a per-km price over $10', { perKmCents: { ...DEFAULTS.perKmCents, van: 1000.01 } }],
    ['a fractional minimum fare', { floorCents: { ...DEFAULTS.floorCents, car: 2900.5 } }],
    ['a buffer over 50%', { bufferPct: 51 }],
    ['a fractional buffer', { bufferPct: 10.5 }],
    ['an FX with 3 decimal places', { fxUsdToLkr: 330.125 }],
    ['a zero add-on', { extrasCents: { ...DEFAULTS.extrasCents, luggage: 0 } }],
    ['an unknown field', { depositPct: 20 }],
  ])('rejects %s', (_label, patch) => {
    expect(rateInputsSchema.safeParse({ ...DEFAULTS, ...patch }).success).toBe(false);
  });

  it('accepts today\'s fractional per-km prices and a two-decimal FX', () => {
    expect(rateInputsSchema.safeParse({ ...DEFAULTS, fxUsdToLkr: 330.5 }).success).toBe(true);
  });

  it('reads an older stored row: a missing field is the code default, an unknown key is dropped', () => {
    const older: Record<string, unknown> = { ...DEFAULTS };
    delete older.bufferPct; // saved before buffer became editable
    const stored = { ...older, perKmCents: { car: 45 }, somethingRetired: 1 };
    const rates = readStoredRates(stored, DEFAULTS);
    expect(rates.bufferPct).toBe(DEFAULTS.bufferPct);
    expect(rates.perKmCents).toEqual({ ...DEFAULTS.perKmCents, car: 45 });
    expect(rates).not.toHaveProperty('somethingRetired');
  });

  it('names a revision by its UTC save date and number', () => {
    expect(revisionVersion(new Date('2026-09-27T23:30:00Z'), 3)).toBe('2026-09-27.3');
  });
});

describe('preview samples', () => {
  it('prices the same four trips the engine would, at both cards', () => {
    const raised = applyRates(RATE_CARD, { ...DEFAULTS, perKmCents: { ...DEFAULTS.perKmCents, car: 60 } }, 'preview');
    const rows = previewSamples(RATE_CARD, raised);
    expect(rows.map((r) => r.label)).toEqual(PREVIEW_SAMPLES.map((s) => s.label));
    rows.forEach((r, i) => {
      expect(r.currentCents).toBe(quote(PREVIEW_SAMPLES[i].req, RATE_CARD).totalCents);
      expect(r.proposedCents).toBe(quote(PREVIEW_SAMPLES[i].req, raised).totalCents);
    });
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(byLabel['150 km car transfer'].proposedCents).toBeGreaterThan(byLabel['150 km car transfer'].currentCents);
    expect(byLabel['150 km van transfer'].proposedCents).toBe(byLabel['150 km van transfer'].currentCents);
  });

  it('ignores hot zones on either card', () => {
    const zoned = { ...RATE_CARD, hotZones: [{ placeName: 'Sample B', boostPct: 50 }] };
    expect(previewSamples(zoned, zoned)).toEqual(previewSamples(RATE_CARD, RATE_CARD));
  });
});
