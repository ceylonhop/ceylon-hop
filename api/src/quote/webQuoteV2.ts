import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { EXTRA_CODES } from './rateCard';
import { ROUTE_VARIANTS } from './routeChoice';

const Identity = {
  routeId: z.string().trim().min(1).max(120).optional(),
  tourId: z.string().trim().min(1).max(120).optional(),
};
const Extras = z.array(z.enum(EXTRA_CODES)).max(EXTRA_CODES.length).default([]);
const Vehicle = z.enum(['car', 'van']);
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const Place = z.string().trim().min(1).max(500);
// Stops on the way inside ONE leg (spec 2026-10-30-planner-stops-within-a-leg-design.md §4.1).
// Optional, never defaulted: an intent's fingerprint is canonicalJson(parsed.data), so a default
// `[]` would re-fingerprint every stored quote. Clients send `via` only when it is non-empty.
export const MAX_VIA_PER_LEG = 4;
// Every segment (consecutive pair in a leg's chain) is a billed distance lookup. Until via,
// 8 legs × 1 segment bounded one request; this keeps that bound with stops in the chain.
export const MAX_SEGMENTS_PER_INTENT = 12;
const Via = z.array(Place).max(MAX_VIA_PER_LEG);

const PrivateLegIntent = z
  .object({
    from: Place,
    to: Place,
    via: Via.optional(),
    // Customer route choice (spec 2026-09-26 §4.1): ASK for a road, never send a distance.
    routeVariant: z.enum(ROUTE_VARIANTS).optional(),
  })
  .strict();

const ChauffeurDayIntent = z
  .object({
    date: DateOnly,
    from: Place,
    to: Place,
    via: Via.optional(),
  })
  .strict();

const IntentUnion = z.discriminatedUnion('product', [
  z
    .object({
      product: z.literal('private'),
      ...Identity,
      vehicle: Vehicle,
      pax: z.number().int().min(1).max(14),
      bags: z.number().int().min(0).max(30),
      date: DateOnly.optional(),
      time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      legs: z
        .array(PrivateLegIntent)
        .min(1)
        .max(8), // Each leg is at least one billed lookup — a no_tolls leg can cost up to 3 Google elements (1 distance + 2 comparison) — and the per-IP limiter counts REQUESTS, not lookups. With stops on the way the money bound is MAX_SEGMENTS_PER_INTENT (refined below); the leg cap stays as the shape bound (2026-08-12, 2026-10-30).
      extras: Extras,
    })
    .strict(),
  z
    .object({
      product: z.literal('chauffeur'),
      ...Identity,
      vehicle: Vehicle,
      pax: z.number().int().min(1).max(14),
      bags: z.number().int().min(0).max(30),
      firstDate: DateOnly,
      lastDate: DateOnly,
      travelDays: z
        .array(ChauffeurDayIntent)
        .min(1)
        .max(14), // Same reasoning as legs above: the shape bound; MAX_SEGMENTS_PER_INTENT is the money bound.
      extras: Extras,
    })
    .strict(),
]);

export type WebQuoteIntent = z.infer<typeof IntentUnion>;

/** Billed segments in an intent: one per consecutive pair of each leg's chain. */
export function intentSegments(intent: WebQuoteIntent): number {
  const legs = intent.product === 'private' ? intent.legs : intent.travelDays;
  return legs.reduce((n, l) => n + 1 + (l.via?.length ?? 0), 0);
}

export const WebQuoteIntentSchema = IntentUnion.superRefine((intent, ctx) => {
  // The money bound applies only once stops are in play; an intent without any parsed before this cap existed.
  const legs = intent.product === 'private' ? intent.legs : intent.travelDays;
  if (!legs.some((l) => l.via?.length)) return;
  if (intentSegments(intent) > MAX_SEGMENTS_PER_INTENT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `at most ${MAX_SEGMENTS_PER_INTENT} segments per quote`,
      path: [intent.product === 'private' ? 'legs' : 'travelDays'],
    });
  }
});

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function fingerprintIntent(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function digestAccessToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeDigestEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
