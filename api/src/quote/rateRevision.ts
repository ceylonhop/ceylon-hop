// Founder-editable rates (spec docs/superpowers/specs/2026-09-26-ops-rates-page-design.md §6).
// The owner sets the CUSTOMER price per km and per chauffeur day directly — not cost + margin % —
// and keeps our costs beside them for the margin figure only. Minimum fares and add-ons are final
// prices. A saved revision holds this whole set; the newest one overrides the code defaults in
// rateCard.ts, which stay the answer until the first save (liveCard.ts).
//
// Not editable, on purpose: deposit % and cap (no booking charges a deposit — engine.ts:171), seat
// and bag limits, idle-day km, price finishing, shared-ride fees, currency, and markupPct (which
// now only estimates our cost for a hand-set $/km, engine.ts:64).
import { z } from 'zod';
import { EXTRA_CODES, type ExtraCode, type RateCard } from './rateCard';
import type { QuoteRequest } from './types';
import { quote } from './engine';

// At most two decimal places: a per-km price in cents (40.25) or an FX rate (330.5). Floats such
// as 54.05 are not exact, so compare against the nearest hundredth with a tolerance.
const hundredths = (n: number): boolean => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
const perKm = z.number().finite().positive().max(1000).refine(hundredths, 'at most 2 decimal places of a cent');
const whole = (max: number) => z.number().int().positive().max(max);
const byVehicle = <T extends z.ZodTypeAny>(v: T) => z.object({ car: v, van: v, van9: v, van14: v, custom: v }).strict();
const extrasShape = Object.fromEntries(EXTRA_CODES.map((c) => [c, whole(50_000)])) as Record<ExtraCode, z.ZodNumber>;

export const rateInputsSchema = z.object({
  perKmCents: byVehicle(perKm),
  costPerKmCents: byVehicle(perKm),
  floorCents: byVehicle(whole(100_000)),
  dayRateCents: whole(100_000),
  dayRateCostCents: whole(100_000),
  extrasCents: z.object(extrasShape).strict(),
  bufferPct: z.number().int().min(0).max(50),
  fxUsdToLkr: z.number().finite().positive().max(1000).refine(hundredths, 'at most 2 decimal places'),
}).strict();

export type RateInputs = z.infer<typeof rateInputsSchema>;

// The editable set as a card carries it — the code defaults when given RATE_CARD.
export function ratesFromCard(card: RateCard): RateInputs {
  return {
    perKmCents: { ...card.perKmCents },
    costPerKmCents: { ...card.costPerKmCents },
    floorCents: { ...card.floorCents },
    dayRateCents: card.chauffeur.dayRateCents,
    dayRateCostCents: card.chauffeur.dayRateCostCents,
    extrasCents: Object.fromEntries(EXTRA_CODES.map((c) => [c, card.extras[c]])) as Record<ExtraCode, number>,
    bufferPct: card.bufferPct,
    fxUsdToLkr: card.fxUsdToLkr,
  };
}

// `base` with the editable set replaced wholesale. Prices are used exactly as saved (no markup).
export function applyRates(base: RateCard, rates: RateInputs, version: string): RateCard {
  return {
    ...base,
    version,
    perKmCents: { ...rates.perKmCents },
    costPerKmCents: { ...rates.costPerKmCents },
    floorCents: { ...rates.floorCents },
    chauffeur: { ...base.chauffeur, dayRateCents: rates.dayRateCents, dayRateCostCents: rates.dayRateCostCents },
    extras: { ...base.extras, ...rates.extrasCents },
    bufferPct: rates.bufferPct,
    fxUsdToLkr: rates.fxUsdToLkr,
  };
}

// A stored row, read defensively: a field that became editable after the row was saved reads as
// the code default, and a key that is no longer editable is dropped. Still validated — a row edited
// by hand into nonsense throws rather than prices.
export function readStoredRates(stored: unknown, defaults: RateInputs): RateInputs {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<Record<keyof RateInputs, unknown>>;
  const pick = <K extends string>(d: Record<K, number>, v: unknown): Record<K, number> => {
    const src = (v && typeof v === 'object' ? v : {}) as Partial<Record<K, number>>;
    return Object.fromEntries(Object.keys(d).map((k) => [k, src[k as K] ?? d[k as K]])) as Record<K, number>;
  };
  return rateInputsSchema.parse({
    perKmCents: pick(defaults.perKmCents, s.perKmCents),
    costPerKmCents: pick(defaults.costPerKmCents, s.costPerKmCents),
    floorCents: pick(defaults.floorCents, s.floorCents),
    dayRateCents: s.dayRateCents ?? defaults.dayRateCents,
    dayRateCostCents: s.dayRateCostCents ?? defaults.dayRateCostCents,
    extrasCents: pick(defaults.extrasCents, s.extrasCents),
    bufferPct: s.bufferPct ?? defaults.bufferPct,
    fxUsdToLkr: s.fxUsdToLkr ?? defaults.fxUsdToLkr,
  });
}

// "2026-09-27.3": the UTC day it was saved and its revision number (quotes record this as
// rateCardVersion, beside the code card's "2026-07-14").
export function revisionVersion(savedAt: Date, seq: number): string {
  return `${savedAt.toISOString().slice(0, 10)}.${seq}`;
}

// The four trips the review step prices at the current and proposed rates (spec §7.1): fixed
// distances and made-up place names, so no Google call and no hot zone can match.
export const PREVIEW_SAMPLES: ReadonlyArray<{ label: string; req: QuoteRequest }> = [
  { label: '30 km car transfer', req: { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Sample A', to: 'Sample B', distanceKm: 30 }] } },
  { label: '150 km car transfer', req: { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Sample A', to: 'Sample B', distanceKm: 150 }] } },
  { label: '150 km van transfer', req: { product: 'private', vehicle: 'van', pax: 5, bags: 5, legs: [{ from: 'Sample A', to: 'Sample B', distanceKm: 150 }] } },
  {
    label: '3-day car chauffeur trip, 3 × 100 km',
    req: {
      product: 'chauffeur', vehicle: 'car', pax: 2, bags: 2, firstDate: '2030-01-01', lastDate: '2030-01-03',
      travelDays: [
        { date: '2030-01-01', from: 'Sample A', to: 'Sample B', distanceKm: 100 },
        { date: '2030-01-02', from: 'Sample B', to: 'Sample C', distanceKm: 100 },
        { date: '2030-01-03', from: 'Sample C', to: 'Sample D', distanceKm: 100 },
      ],
    },
  },
];

export function previewSamples(current: RateCard, proposed: RateCard): { label: string; currentCents: number; proposedCents: number }[] {
  const noZones = (c: RateCard): RateCard => ({ ...c, hotZones: [] });
  return PREVIEW_SAMPLES.map((s) => ({
    label: s.label,
    currentCents: quote(s.req, noZones(current)).totalCents,
    proposedCents: quote(s.req, noZones(proposed)).totalCents,
  }));
}
