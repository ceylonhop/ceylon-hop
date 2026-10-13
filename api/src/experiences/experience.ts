import { z } from 'zod';

// Partner experiences (spec 2026-10-06). Display-only price; experience money moves through
// PayHere portal links outside this system (spec D13). Photos are repo files on GitHub Pages
// (spec D8) — absolute URLs because the API host serves only an allow-list of root assets.
export type PriceUnit = 'per_person' | 'per_group';
export const PHOTO_ORIGIN = 'https://ceylonhop.com';
// Straight-line understates road distance; the maps adapter's own no-Google fallback uses the
// same factor (api/src/adapters/maps.ts, the `haversineKm(a, b) * 1.35` estimate).
export const ROAD_FACTOR = 1.35;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM');
// A path under img/ without the -900/-1800 suffix: experiences/<slug>/<name>, or an existing live photo
// such as guides/sigiriya/ayurveda (spec D8, D20).
const PHOTO_STEM = z.string().regex(/^[a-z0-9-]+(\/[a-z0-9-]+){1,3}$/, 'use a path under img/, e.g. experiences/slug/name');

export const ExperienceInputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,60}$/, 'lowercase letters, digits and dashes'),
  name: z.string().trim().min(1).max(80),
  partnerName: z.string().trim().min(1).max(80),
  areaLabel: z.string().trim().min(1).max(40),
  summary: z.string().trim().min(1).max(160),
  details: z.string().trim().max(2000).default(''),
  priceCents: z.number().int().min(0).max(1_000_000),
  priceUnit: z.enum(['per_person', 'per_group']),
  durationText: z.string().trim().max(40).nullable().default(null),
  openWeekdays: z.array(z.number().int().min(0).max(6)).max(14)
    .transform((d) => [...new Set(d)].sort((a, b) => a - b)),
  startTimes: z.array(HHMM).max(12).transform((t) => [...new Set(t)].sort()),
  // Sri Lanka's bounding box: a "lng, lat" paste lands in the ocean and would silently match nothing.
  lat: z.number().min(5.8).max(10.0),
  lng: z.number().min(79.4).max(82.0),
  radiusKm: z.number().gt(0).max(60).default(5),
  photos: z.array(PHOTO_STEM).max(6).default([]),
  partnerContact: z.string().trim().max(200).nullable().default(null),
  active: z.boolean().default(true),
}).strict();

export type ExperienceInput = z.output<typeof ExperienceInputSchema>;

export interface Experience extends ExperienceInput {
  id: string;
  currency: 'USD';
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicExperience {
  id: string; slug: string; name: string; partnerName: string; areaLabel: string; summary: string;
  details: string; priceCents: number; currency: 'USD'; priceUnit: PriceUnit; durationText: string | null;
  openWeekdays: number[]; startTimes: string[]; photos: Array<{ small: string; large: string }>;
}

export function photoUrls(stem: string): { small: string; large: string } {
  const base = `${PHOTO_ORIGIN}/img/${stem}`;
  return { small: `${base}-900.jpg`, large: `${base}-1800.jpg` };
}

export function aboutKm(straightLineKm: number): number {
  return Math.round(straightLineKm * ROAD_FACTOR);
}

// What a customer page may see: no partner contact, no pin, no audit trail.
export function toPublicExperience(e: Experience): PublicExperience {
  return {
    id: e.id, slug: e.slug, name: e.name, partnerName: e.partnerName, areaLabel: e.areaLabel,
    summary: e.summary, details: e.details, priceCents: e.priceCents, currency: e.currency,
    priceUnit: e.priceUnit, durationText: e.durationText, openWeekdays: e.openWeekdays,
    startTimes: e.startTimes, photos: e.photos.map(photoUrls),
  };
}
