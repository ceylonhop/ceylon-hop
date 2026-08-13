import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { EXTRA_CODES } from './rateCard';

const Place = z.string().trim().min(1).max(500);
const Identity = {
  routeId: z.string().trim().min(1).max(120).optional(),
  tourId: z.string().trim().min(1).max(120).optional(),
};
const Extras = z.array(z.enum(EXTRA_CODES)).max(EXTRA_CODES.length).default([]);
const Vehicle = z.enum(['car', 'van']);
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const WebQuoteIntentSchema = z.discriminatedUnion('product', [
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
        .array(
          z
            .object({
              from: Place,
              to: Place,
            })
            .strict(),
        )
        .min(1)
        .max(8), // Each leg is a billed distance lookup, and the per-IP limiter counts REQUESTS, not lookups. Capping legs is what bounds the money one allowed request can spend (2026-08-12).
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
        .array(
          z
            .object({
              date: DateOnly,
              from: Place,
              to: Place,
            })
            .strict(),
        )
        .min(1)
        .max(14), // Each day is a billed distance lookup, and the per-IP limiter counts REQUESTS, not lookups. Capping travelDays is what bounds the money one allowed request can spend (2026-08-12).
      extras: Extras,
    })
    .strict(),
]);

export type WebQuoteIntent = z.infer<typeof WebQuoteIntentSchema>;

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
