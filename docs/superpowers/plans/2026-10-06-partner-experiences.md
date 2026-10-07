# Partner Experiences (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show partner experiences near a customer's drop-off on the booking page and the quote page, record "I'm interested" (never charged), and give ops a page to maintain the catalogue and work the leads.

**Architecture:** Two new Postgres tables (`experiences`, `experience_interests`) behind repo interfaces with in-memory fakes. One pure matcher (`matchExperiences`, haversine ≤ per-experience radius) used by a public `GET /experiences/near` (booking page) and in-process by `GET /quote-view` (quote page). Ops CRUD under `/admin/experiences` with a new `experiences:manage` capability; an ops-ui page with Catalogue + Interests tabs. Photos are repo files on GitHub Pages, referenced by stem.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Drizzle + Postgres · Vitest · Playwright (web-tests) · classic-script browser JS (booking.js, quote.html, ops-ui.html).

**Spec:** `docs/superpowers/specs/2026-10-06-partner-experiences-design.md` — every decision (D1–D17) and its reason lives there; tasks cite them instead of repeating the argument.

## Global Constraints

- Money = integer minor units + ISO currency; currency is `'USD'` only (matches `bookings_currency_supported`).
- Code name is **experience(s)** — never "add-on"/"extra" (spec D2).
- Customer copy is exactly spec D14. The button never says "free" or "no charge".
- Interests must never fail a booking, a quote page, or a payment: write after, catch, log (spec D15).
- `partner_contact` never leaves an `/admin/*` route.
- Photos: `https://ceylonhop.com/img/experiences/<stem>-900.jpg` and `-1800.jpg`; stems match `^[a-z0-9-]+/[a-z0-9-]+$`.
- Coordinates must fall inside Sri Lanka: lat 5.8–10.0, lng 79.4–82.0 (catches a swapped "lng, lat" paste).
- No changes to `rateCard.ts`, `departureRepo.ts`, `config.ts`, env, or any `@generated:` block (maintenance rule 3).
- Gate before every commit: `cd api && npm run check` and `npm --prefix <abs>/web-tests run test:all` both green (maintenance rule 4).
- Stage files by path only; never `git add -A` (maintenance rule 6). Work in a worktree.

## Why these PRs, in this order

One step = one branch = one PR (Hard rule 1). Each PR below leaves `main` green and shippable:

| PR | Delivers | Why here |
|---|---|---|
| 1 | Migration 0065, schema, repos, matcher | Everything else reads these. Lands the migration alone, so its release (auto-apply on staging at merge) is reviewed on its own (CLAUDE.md rule 7). |
| 2 | Ops API `/admin/experiences` + capability + public `GET /experiences/near` | API before UI, so the UI PRs test against a real contract. No customer-visible change. |
| 3 | Ops page: Catalogue tab | Ops can enter real experiences before customers see anything. With zero active rows, PRs 4–5 show nothing (spec D16), so the order is safe. |
| 4 | Booking page section + `experienceIds` write | Highest-traffic surface first. |
| 5 | Quote page section + `POST /quote-view/interest` + quote→booking linking | Depends on PR 1's interests table and PR 2's matcher; separate because it reverses the quote page's "no POST" decision and deserves its own review. |
| 6 | Ops Interests tab + booking-sheet block + email rows | Ops visibility. Ships before ops activates any experience (launch checklist §L). |

**Plan detail:** PRs 1–2 carry complete code. PRs 3–6 touch `ops-ui.html`, `booking.js` and `quote.html`, which change on `main` almost daily (`ops-ui.html` is the repo's hottest file). For those, the plan fixes the interface, the behaviour, the exact anchors and the tests, and the implementer writes the DOM code against `origin/main` at the start of that PR. Pre-writing 300 lines of DOM code against today's line numbers would be stale before it merged.

---

## PR 1 — Data model, repos, matcher

Branch: `feat/experiences-data`

### Task 1.1: Migration 0065 + Drizzle schema

**Files:**
- Create: `api/drizzle/0065_experiences.sql`
- Modify: `api/drizzle/meta/_journal.json` (append entry)
- Modify: `api/src/db/schema.ts` (append two tables after `promoCodes`)
- Test: `api/src/db/experiencesMigration.test.ts`

**Interfaces:**
- Produces: Drizzle tables `experiences`, `experienceInterests` exported from `api/src/db/schema.ts`.

- [ ] **Step 1: Re-check the migration number.** Run `git fetch origin && git ls-tree --name-only origin/main api/drizzle/ | tail -3` and `gh pr list --state open --search "drizzle"`. If `0065` is taken or an open PR adds one, renumber to the next free number and use a `when` larger than the newest journal entry (drizzle skips an older `when`).

- [ ] **Step 2: Write the failing test**

```ts
// api/src/db/experiencesMigration.test.ts
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

// Partner experiences (spec 2026-10-06 D3–D5): the catalogue and one row per customer interest.
// Additive only — no existing table changes, so the auto-apply on Render boot can't touch data.
const migration = readFileSync(new URL('../../drizzle/0065_experiences.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe('0065_experiences', () => {
  it('creates both tables', () => {
    expect(sql).toMatch(/create table "experiences"/i);
    expect(sql).toMatch(/create table "experience_interests"/i);
  });
  it('touches no existing table and moves no data', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+|alter\s+table)\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
  });
  it('keeps money as cents + a supported currency', () => {
    expect(sql).toMatch(/"price_cents" integer NOT NULL/);
    expect(sql).toMatch(/"currency" in \('USD'\)/);
  });
  it('makes a repeated tap idempotent per booking and per quote', () => {
    expect(sql).toMatch(/unique index "experience_interests_booking_uq"/i);
    expect(sql).toMatch(/unique index "experience_interests_quote_uq"/i);
  });
  it('is journalled after 0064', () => {
    const i = journal.entries.findIndex((e) => e.tag === '0065_experiences');
    expect(journal.entries[i]!.idx).toBe(65);
    expect(journal.entries[i]!.when).toBeGreaterThan(journal.entries[i - 1]!.when);
  });
});

const TEST_URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!TEST_URL)('experiences tables on a migrated database', () => {
  let db: ReturnType<typeof createDb>['sql'];
  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    db = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
  });

  it('refuses an interest that belongs to neither a booking nor a quote', async () => {
    const [e] = await db<{ id: string }[]>`
      INSERT INTO experiences (slug, name, partner_name, summary, price_cents, price_unit, lat, lng)
      VALUES (${'mig-test-' + Date.now()}, 'x', 'y', 'z', 100, 'per_person', 7.95, 80.76) RETURNING id`;
    await expect(db`
      INSERT INTO experience_interests (experience_id, place_label, source, name_snapshot, price_cents_snapshot, price_unit_snapshot)
      VALUES (${e!.id}, 'Sigiriya', 'booking_page', 'x', 100, 'per_person')`).rejects.toThrow(/experience_interests_has_owner/);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd api && npx vitest run src/db/experiencesMigration.test.ts`
Expected: FAIL — `ENOENT … 0065_experiences.sql`.

- [ ] **Step 4: Write the migration**

```sql
-- api/drizzle/0065_experiences.sql
-- Partner experiences (spec 2026-10-06). Hand-written: drizzle-kit generate needs a TTY.
CREATE TABLE "experiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"partner_name" text NOT NULL,
	"summary" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"price_unit" text NOT NULL,
	"duration_text" text,
	"open_weekdays" integer[] DEFAULT '{0,1,2,3,4,5,6}' NOT NULL,
	"start_times" text[] DEFAULT '{}' NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"radius_km" double precision DEFAULT 5 NOT NULL,
	"photos" text[] DEFAULT '{}' NOT NULL,
	"partner_contact" text,
	"active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiences_slug_unique" UNIQUE("slug"),
	CONSTRAINT "experiences_price_nonnegative" CHECK ("price_cents" >= 0),
	CONSTRAINT "experiences_currency_supported" CHECK ("currency" in ('USD')),
	CONSTRAINT "experiences_price_unit_valid" CHECK ("price_unit" in ('per_person', 'per_group')),
	CONSTRAINT "experiences_radius_valid" CHECK ("radius_km" > 0 and "radius_km" <= 60)
);
--> statement-breakpoint
CREATE TABLE "experience_interests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experience_id" uuid NOT NULL REFERENCES "experiences"("id"),
	"booking_id" uuid REFERENCES "bookings"("id"),
	"quote_id" uuid REFERENCES "quotes"("id"),
	"place_label" text NOT NULL,
	"source" text NOT NULL,
	"name_snapshot" text NOT NULL,
	"price_cents_snapshot" integer NOT NULL,
	"price_unit_snapshot" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"ops_note" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experience_interests_has_owner" CHECK ("booking_id" is not null or "quote_id" is not null),
	CONSTRAINT "experience_interests_source_valid" CHECK ("source" in ('booking_page', 'quote_page')),
	CONSTRAINT "experience_interests_status_valid" CHECK ("status" in ('new', 'contacted', 'booked', 'declined')),
	CONSTRAINT "experience_interests_note_length" CHECK ("ops_note" is null or char_length("ops_note") <= 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "experience_interests_booking_uq" ON "experience_interests" ("experience_id", "booking_id") WHERE "booking_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "experience_interests_quote_uq" ON "experience_interests" ("experience_id", "quote_id") WHERE "quote_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "experience_interests_status_idx" ON "experience_interests" ("status");
```

Append to `api/drizzle/meta/_journal.json` `entries` (after idx 64; `when` = previous + one day):

```json
    {
      "idx": 65,
      "version": "7",
      "when": 1791158400000,
      "tag": "0065_experiences",
      "breakpoints": true
    }
```

Append to `api/src/db/schema.ts`:

```ts
// Partner experiences (spec 2026-10-06 D4; migration 0065). The catalogue ops maintains on the
// Experiences page. Money is cents + currency so phase 3 can charge it without a data migration;
// open days and start times are structured for the same reason. partner_contact is ops-only.
export const experiences = pgTable('experiences', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  partnerName: text('partner_name').notNull(),
  summary: text('summary').notNull(),
  details: text('details').notNull().default(''),
  priceCents: integer('price_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  priceUnit: text('price_unit').notNull(),
  durationText: text('duration_text'),
  openWeekdays: integer('open_weekdays').array().notNull().default(sql`'{0,1,2,3,4,5,6}'::integer[]`),
  startTimes: text('start_times').array().notNull().default(sql`'{}'::text[]`),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  radiusKm: doublePrecision('radius_km').notNull().default(5),
  photos: text('photos').array().notNull().default(sql`'{}'::text[]`),
  partnerContact: text('partner_contact'),
  active: boolean('active').notNull().default(true),
  priority: integer('priority').notNull().default(0),
  createdBy: text('created_by'),
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// One row per customer × experience (spec D5). Snapshots keep what THIS customer was shown when
// ops later edits the price. A quote interest gains booking_id when the quote becomes a booking.
export const experienceInterests = pgTable('experience_interests', {
  id: uuid('id').primaryKey().defaultRandom(),
  experienceId: uuid('experience_id').notNull().references(() => experiences.id),
  bookingId: uuid('booking_id').references(() => bookings.id),
  quoteId: uuid('quote_id').references(() => quotes.id),
  placeLabel: text('place_label').notNull(),
  source: text('source').notNull(),
  nameSnapshot: text('name_snapshot').notNull(),
  priceCentsSnapshot: integer('price_cents_snapshot').notNull(),
  priceUnitSnapshot: text('price_unit_snapshot').notNull(),
  status: text('status').notNull().default('new'),
  opsNote: text('ops_note'),
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('experience_interests_booking_uq').on(t.experienceId, t.bookingId).where(sql`${t.bookingId} IS NOT NULL`),
  uniqueIndex('experience_interests_quote_uq').on(t.experienceId, t.quoteId).where(sql`${t.quoteId} IS NOT NULL`),
  index('experience_interests_status_idx').on(t.status),
]);
```

- [ ] **Step 5: Run to see it pass** — `cd api && npx vitest run src/db/experiencesMigration.test.ts` → PASS (the DB block runs only with `DATABASE_URL_TEST`; set it locally to the test DB, **never** `api/.env`'s `DATABASE_URL`, which is prod).

- [ ] **Step 6: Commit** — `git add api/drizzle/0065_experiences.sql api/drizzle/meta/_journal.json api/src/db/schema.ts api/src/db/experiencesMigration.test.ts && git commit -m "feat(db): experiences + experience_interests tables (0065)"`

### Task 1.2: Domain types + the matcher

**Files:**
- Create: `api/src/experiences/experience.ts` (types, Zod input, public projection, photo URLs)
- Create: `api/src/experiences/match.ts`
- Test: `api/src/experiences/match.test.ts`, `api/src/experiences/experience.test.ts`

**Interfaces — Produces:**
```ts
// experience.ts
export type PriceUnit = 'per_person' | 'per_group';
export interface Experience { id: string; slug: string; name: string; partnerName: string; summary: string;
  details: string; priceCents: number; currency: 'USD'; priceUnit: PriceUnit; durationText: string | null;
  openWeekdays: number[]; startTimes: string[]; lat: number; lng: number; radiusKm: number; photos: string[];
  partnerContact: string | null; active: boolean; priority: number; createdBy: string | null;
  updatedBy: string | null; createdAt: Date; updatedAt: Date; }
export const ExperienceInputSchema; // z.object({...}).strict() — the create body
export type ExperienceInput = z.output<typeof ExperienceInputSchema>;
export interface PublicExperience { id: string; slug: string; name: string; partnerName: string; summary: string;
  details: string; priceCents: number; currency: 'USD'; priceUnit: PriceUnit; durationText: string | null;
  openWeekdays: number[]; startTimes: string[]; photos: Array<{ small: string; large: string }>; }
export function toPublicExperience(e: Experience): PublicExperience;
export const PHOTO_ORIGIN = 'https://ceylonhop.com';
// match.ts
export interface StopPoint { label: string; lat: number; lng: number }
export interface StopMatch<E> { place: string; items: Array<{ experience: E; distanceKm: number }> }
export const MAX_PER_STOP = 6;
export function matchExperiences<E extends Pick<Experience, 'id' | 'lat' | 'lng' | 'radiusKm' | 'priority' | 'active'>>(
  stops: StopPoint[], experiences: E[]): StopMatch<E>[];
```

- [ ] **Step 1: Write the failing matcher test**

```ts
// api/src/experiences/match.test.ts
import { describe, expect, it } from 'vitest';
import { MAX_PER_STOP, matchExperiences } from './match';

// Sigiriya catalogue point (transfers-data.js) and pins at known offsets. 0.009° lat ≈ 1 km.
const SIGIRIYA = { label: 'Sigiriya', lat: 7.95, lng: 80.76 };
const KANDY = { label: 'Kandy', lat: 7.2906, lng: 80.6337 };
const exp = (id: string, dLatKm: number, radiusKm: number, extra: Partial<{ priority: number; active: boolean }> = {}) => ({
  id, lat: 7.95 + dLatKm * 0.009, lng: 80.76, radiusKm, priority: 0, active: true, ...extra,
});

describe('matchExperiences (spec D6)', () => {
  it('shows an experience inside its own radius and hides one outside it', () => {
    const r = matchExperiences([SIGIRIYA], [exp('near', 3, 5), exp('far', 8, 5)]);
    expect(r).toHaveLength(1);
    expect(r[0]!.items.map((m) => m.experience.id)).toEqual(['near']);
    expect(r[0]!.items[0]!.distanceKm).toBeCloseTo(3, 0);
  });
  it('uses each experience’s own reach: a safari 25 km out with a 30 km radius matches', () => {
    const r = matchExperiences([SIGIRIYA], [exp('safari', 25, 30)]);
    expect(r[0]!.items[0]!.experience.id).toBe('safari');
  });
  it('sorts by priority first, then nearest', () => {
    const r = matchExperiences([SIGIRIYA], [exp('a', 4, 10), exp('b', 1, 10), exp('pinned', 6, 10, { priority: 5 })]);
    expect(r[0]!.items.map((m) => m.experience.id)).toEqual(['pinned', 'b', 'a']);
  });
  it('ignores inactive experiences', () => {
    expect(matchExperiences([SIGIRIYA], [exp('off', 1, 5, { active: false })])).toEqual([]);
  });
  it(`caps a stop at ${MAX_PER_STOP}`, () => {
    const many = Array.from({ length: 9 }, (_, i) => exp(`e${i}`, 1, 5));
    expect(matchExperiences([SIGIRIYA], many)[0]!.items).toHaveLength(MAX_PER_STOP);
  });
  it('never repeats an experience under a later stop', () => {
    const both = exp('both', 1, 200);
    const r = matchExperiences([SIGIRIYA, KANDY], [both]);
    expect(r).toHaveLength(1);
    expect(r[0]!.place).toBe('Sigiriya');
  });
  it('omits stops with no matches', () => {
    expect(matchExperiences([KANDY], [exp('near-sigiriya', 1, 5)])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see it fail** — `cd api && npx vitest run src/experiences/match.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// api/src/experiences/match.ts
import { haversineKm } from '../adapters/maps';
import type { Experience } from './experience';

// Spec D6/D7: an experience shows for a stop when the straight-line distance from the stop to its
// pin is within ITS OWN radius (a spa 3 km out and a safari 25 km out both belong to "Sigiriya").
// One function for both pages — the booking page reaches it via GET /experiences/near, the quote
// page in-process — so the two can never disagree about what is "near".
export interface StopPoint { label: string; lat: number; lng: number }
export interface StopMatch<E> { place: string; items: Array<{ experience: E; distanceKm: number }> }
export const MAX_PER_STOP = 6;

type Matchable = Pick<Experience, 'id' | 'lat' | 'lng' | 'radiusKm' | 'priority' | 'active'>;

export function matchExperiences<E extends Matchable>(stops: StopPoint[], experiences: E[]): StopMatch<E>[] {
  const shown = new Set<string>();
  const out: StopMatch<E>[] = [];
  for (const stop of stops) {
    const items = experiences
      .filter((e) => e.active && !shown.has(e.id))
      .map((e) => ({ experience: e, distanceKm: haversineKm([stop.lat, stop.lng], [e.lat, e.lng]) }))
      .filter((m) => m.distanceKm <= m.experience.radiusKm)
      .sort((a, b) => b.experience.priority - a.experience.priority || a.distanceKm - b.distanceKm)
      .slice(0, MAX_PER_STOP);
    for (const m of items) shown.add(m.experience.id);
    if (items.length) out.push({ place: stop.label, items });
  }
  return out;
}
```

- [ ] **Step 4: Write the failing input/projection test**

```ts
// api/src/experiences/experience.test.ts
import { describe, expect, it } from 'vitest';
import { ExperienceInputSchema, toPublicExperience, type Experience } from './experience';

const valid = {
  slug: 'atherya-massage', name: 'Ayurvedic massage', partnerName: 'Atherya Spa',
  summary: 'Full-body herbal oil massage and steam bath.', details: '', priceCents: 3500,
  priceUnit: 'per_person', durationText: '90 min', openWeekdays: [6, 1, 1, 0], startTimes: ['09:00', '14:30'],
  lat: 7.977, lng: 80.76, radiusKm: 5, photos: ['atherya-spa/massage'], partnerContact: '+94 77 000 0000',
  active: true, priority: 0,
};

describe('ExperienceInputSchema', () => {
  it('accepts a valid experience and normalises weekdays (unique, sorted)', () => {
    const r = ExperienceInputSchema.parse(valid);
    expect(r.openWeekdays).toEqual([0, 1, 6]);
  });
  it('refuses a swapped "lng, lat" paste (outside Sri Lanka)', () => {
    expect(ExperienceInputSchema.safeParse({ ...valid, lat: 80.76, lng: 7.977 }).success).toBe(false);
  });
  it('refuses a bad start time, a bad photo stem, a negative price and unknown fields', () => {
    expect(ExperienceInputSchema.safeParse({ ...valid, startTimes: ['9am'] }).success).toBe(false);
    expect(ExperienceInputSchema.safeParse({ ...valid, photos: ['../x'] }).success).toBe(false);
    expect(ExperienceInputSchema.safeParse({ ...valid, priceCents: -1 }).success).toBe(false);
    expect(ExperienceInputSchema.safeParse({ ...valid, commission: 10 }).success).toBe(false);
  });
});

describe('toPublicExperience', () => {
  it('never exposes partner contact or audit fields, and builds absolute photo URLs', () => {
    const e: Experience = { ...ExperienceInputSchema.parse(valid), id: 'x', currency: 'USD',
      createdBy: 'a@b', updatedBy: null, createdAt: new Date(), updatedAt: new Date() };
    const p = toPublicExperience(e) as unknown as Record<string, unknown>;
    expect(p.partnerContact).toBeUndefined();
    expect(p.createdBy).toBeUndefined();
    expect(p.lat).toBeUndefined();
    expect(p.photos).toEqual([{
      small: 'https://ceylonhop.com/img/experiences/atherya-spa/massage-900.jpg',
      large: 'https://ceylonhop.com/img/experiences/atherya-spa/massage-1800.jpg',
    }]);
  });
});
```

- [ ] **Step 5: Run it to see it fail**, then implement:

```ts
// api/src/experiences/experience.ts
import { z } from 'zod';

// Partner experiences (spec 2026-10-06). Display-only price in phase 1; stored as cents + currency
// so phase 3 can charge it. Photos are repo files on GitHub Pages (spec D8): absolute URLs because
// the API host serves only an allow-list of root assets (customerPages.ts ASSETS).
export type PriceUnit = 'per_person' | 'per_group';
export const PHOTO_ORIGIN = 'https://ceylonhop.com';

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM');
const PHOTO_STEM = z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/, 'use folder/name');

export const ExperienceInputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,60}$/, 'lowercase letters, digits and dashes'),
  name: z.string().trim().min(1).max(80),
  partnerName: z.string().trim().min(1).max(80),
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
  priority: z.number().int().min(-100).max(100).default(0),
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
  id: string; slug: string; name: string; partnerName: string; summary: string; details: string;
  priceCents: number; currency: 'USD'; priceUnit: PriceUnit; durationText: string | null;
  openWeekdays: number[]; startTimes: string[]; photos: Array<{ small: string; large: string }>;
}

export function photoUrls(stem: string): { small: string; large: string } {
  const base = `${PHOTO_ORIGIN}/img/experiences/${stem}`;
  return { small: `${base}-900.jpg`, large: `${base}-1800.jpg` };
}

// What a customer page may see: no partner contact, no pin, no audit trail.
export function toPublicExperience(e: Experience): PublicExperience {
  return {
    id: e.id, slug: e.slug, name: e.name, partnerName: e.partnerName, summary: e.summary,
    details: e.details, priceCents: e.priceCents, currency: e.currency, priceUnit: e.priceUnit,
    durationText: e.durationText, openWeekdays: e.openWeekdays, startTimes: e.startTimes,
    photos: e.photos.map(photoUrls),
  };
}
```

- [ ] **Step 6: Run both tests → PASS. Commit** — `git add api/src/experiences/ && git commit -m "feat(experiences): domain types, input schema and distance matcher"`

### Task 1.3: Experience repo (in-memory + Postgres)

**Files:**
- Create: `api/src/db/experienceRepo.ts`, `api/src/db/postgresExperienceRepo.ts`
- Test: `api/src/db/experienceRepo.test.ts` (runs the same contract against both; Postgres block behind `DATABASE_URL_TEST`)

**Interfaces — Produces:**
```ts
export interface ExperiencePatch extends Partial<ExperienceInput> { updatedBy?: string | null }
export interface ExperienceRepo {
  list(): Promise<Experience[]>;            // all, active first, then name
  listActive(): Promise<Experience[]>;
  get(id: string): Promise<Experience | null>;
  create(e: ExperienceInput & { createdBy?: string | null }): Promise<Experience>; // throws SlugTakenError
  patch(id: string, p: ExperiencePatch): Promise<Experience | null>;               // throws SlugTakenError
}
export class SlugTakenError extends Error {}
export class InMemoryExperienceRepo implements ExperienceRepo {}
export class PostgresExperienceRepo implements ExperienceRepo { constructor(db: Db) }
```
No `remove` on purpose (spec D12: switch off, never delete).

- [ ] **Step 1: Write the contract test** — one `function contract(name, make: () => ExperienceRepo)` exercised with `InMemoryExperienceRepo` and (skipIf no `DATABASE_URL_TEST`) `PostgresExperienceRepo` after `migrate()`. Cases: create → get round-trips every field incl. arrays and `currency: 'USD'`; `listActive` excludes `active:false`; `list` orders active first then name; `patch` changes only provided fields and bumps `updatedAt`; `patch` of unknown id → `null`; duplicate slug on `create` and on `patch` → `SlugTakenError`. Postgres runs use a unique slug prefix per run (`test-${Date.now()}-`) because the test DB is shared.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** both classes, modelled line-for-line on `zonesRepo.ts` / `postgresZonesRepo.ts` (`toRow` mapper; `patch` builds its SET from provided fields only). Postgres maps unique-violation code `23505` on `experiences_slug_unique` to `SlugTakenError`. `currency` is always `'USD'` (DB default; mapper narrows with `r.currency as 'USD'`).
- [ ] **Step 4: Run → PASS. Commit** — `feat(db): experience repo (in-memory + Postgres)`.

### Task 1.4: Interest repo (in-memory + Postgres)

**Files:**
- Create: `api/src/db/experienceInterestRepo.ts`, `api/src/db/postgresExperienceInterestRepo.ts`
- Test: `api/src/db/experienceInterestRepo.test.ts` (same contract pattern)

**Interfaces — Produces:**
```ts
export type InterestStatus = 'new' | 'contacted' | 'booked' | 'declined';
export type InterestSource = 'booking_page' | 'quote_page';
export interface ExperienceInterest { id: string; experienceId: string; bookingId: string | null; quoteId: string | null;
  placeLabel: string; source: InterestSource; nameSnapshot: string; priceCentsSnapshot: number;
  priceUnitSnapshot: PriceUnit; status: InterestStatus; opsNote: string | null; updatedBy: string | null;
  createdAt: Date; updatedAt: Date; }
export interface RecordInterest { experience: Experience; placeLabel: string; source: InterestSource;
  bookingId?: string; quoteId?: string }   // exactly one of bookingId / quoteId
export interface ExperienceInterestRepo {
  record(i: RecordInterest): Promise<ExperienceInterest>;          // idempotent per (experience, owner)
  withdrawFromQuote(experienceId: string, quoteId: string): Promise<boolean>; // deletes only while status='new'
  linkQuoteToBooking(quoteId: string, bookingId: string): Promise<number>;    // rows linked; skips a pair the booking already has
  listForBooking(bookingId: string): Promise<ExperienceInterest[]>;
  listForQuote(quoteId: string): Promise<ExperienceInterest[]>;
  listOpen(limit: number): Promise<ExperienceInterest[]>;          // status new|contacted, newest first
  countsByExperience(): Promise<Array<{ experienceId: string; status: InterestStatus; n: number }>>;
  patch(id: string, p: { status?: InterestStatus; opsNote?: string | null; updatedBy: string }): Promise<ExperienceInterest | null>;
}
```

- [ ] **Step 1: Contract test cases:** `record` twice for the same (experience, booking) returns the **same** id (idempotent — a retried booking request replays it); `record` snapshots name/price/unit from the experience; changing the experience's price afterwards leaves the snapshot alone; `withdrawFromQuote` deletes a `new` row and returns `false` (row kept) once status is `contacted`; `linkQuoteToBooking` sets `bookingId` on the quote's rows and is a no-op the second time; `listOpen` excludes `booked`/`declined`; `patch` validates nothing itself (route does) but sets `updatedBy`/`updatedAt`. Postgres block seeds a real booking + quote row via the existing test helpers in `api/src/testSupport/` (FK targets must exist).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Postgres `record`: `insert … onConflictDoNothing()` then select the existing row by `(experience_id, booking_id|quote_id)` (the partial unique indexes are the conflict targets). `linkQuoteToBooking`:
```sql
UPDATE experience_interests i SET booking_id = $bookingId, updated_at = now()
WHERE i.quote_id = $quoteId AND i.booking_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM experience_interests x WHERE x.experience_id = i.experience_id AND x.booking_id = $bookingId)
```
(written with Drizzle `sql` template; the NOT EXISTS keeps the booking unique index from throwing).
- [ ] **Step 4: Run → PASS. Commit** — `feat(db): experience interest repo (in-memory + Postgres)`.

### Task 1.5: Wire the repos into the app (no routes yet)

**Files:** Modify `api/src/app.ts` (`AppDeps`: `experiences?: ExperienceRepo; experienceInterests?: ExperienceInterestRepo;` defaulting to in-memory, next to `zones` at `:110`/`:242`), `api/src/server.ts` (construct both Postgres repos next to `zones` at `:173`), `api/src/serverWiring.test.ts` (assert prod wiring passes Postgres instances — the comment at `server.ts:166-181` exists because a missed line silently falls back to in-memory).
- [ ] Failing test in `serverWiring.test.ts` → implement → `cd api && npm run check` green → commit `feat(api): wire experience repos`.

**PR 1 gate:** `cd api && npm run check`; `npm --prefix <abs>/web-tests run test:all`. PR body flags: **contains migration 0065 — auto-applies on staging at merge; prod only at the next promote.** Red→green evidence pasted.

---

## PR 2 — Ops API + public matcher endpoint

Branch: `feat/experiences-api`

### Task 2.1: Capability `experiences:manage`

**Files:** Modify `api/src/lib/opsAuth.ts` (type union + matrix rows: **founder** and **ops**, spec D12); Test: extend the existing opsAuth test (`can('ops','experiences:manage') === true`, `finance` false, `system` false; `ALL_OPS_ACTIONS` includes it).
- [ ] Failing test → add the one type member + two set entries + a comment line in the block above the matrix explaining why ops holds it (display-only price; owner wants ops to maintain it) → PASS → commit.

### Task 2.2: `/admin/experiences` routes

**Files:**
- Create: `api/src/routes/opsExperiences.ts`
- Modify: `api/src/app.ts` (mount next to `/admin/rates`, `:642`)
- Test: `api/src/routes/opsExperiences.test.ts` (pattern: `hotZonesRoutes.test.ts` — `signSession` cookies, `sec-fetch-site` header on writes)

**Routes:**
| Method + path | Guard | Body / result |
|---|---|---|
| `GET /admin/experiences` | `experiences:manage` | `{ experiences: Experience[] (ISO dates), counts: {experienceId,status,n}[] }` |
| `POST /admin/experiences` | csrf + `experiences:manage` | `ExperienceInputSchema` → 201 `{ experience }`; 409 `{error:'slug_taken'}`; 400 `{error:'bad_request', issues}` |
| `PATCH /admin/experiences/:id` | csrf + `experiences:manage` | `ExperienceInputSchema.partial().strict()` → 200; 404; 409; 400 |
| `GET /admin/experiences/interests?limit=200` | `experiences:manage` | `{ interests: ExperienceInterest[] }` (enriched in PR 6) |
| `PATCH /admin/experiences/interests/:id` | csrf + `bookings:operate` | `{ status?, opsNote? }` strict; note ≤ 1000 → 200 / 404 / 400 |

- [ ] **Step 1: Failing tests:** 401 without a session; 403 for `finance`; `ops` can create; `createdBy` stamped from the identity email; a cross-site write (`sec-fetch-site: cross-site`) → 403 `bad_origin`; bad body → 400 with issues; duplicate slug → 409; `PATCH` partial leaves other fields; `PATCH` interest status by `ops` works, by `finance` → 403.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**, copying the router shape of `opsRates.ts` (own Hono router, inline `csrf` middleware identical to `opsRates.ts:44-53`, `r.use('*', opsIdentity(deps.auth))`):

```ts
// api/src/routes/opsExperiences.ts
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware';
import { ExperienceInputSchema, type Experience } from '../experiences/experience';
import { SlugTakenError, type ExperienceRepo } from '../db/experienceRepo';
import type { ExperienceInterestRepo } from '../db/experienceInterestRepo';

// Ops Experiences page (spec 2026-10-06 D12). Catalogue writes need experiences:manage (founder +
// ops: the price is display-only); moving a lead's status is booking work, so bookings:operate.
// .partial() wraps each field in ZodOptional, so an omitted field stays undefined (its .default() does
// not fire) — a PATCH changes only what it names.
const PatchExperience = ExperienceInputSchema.partial().strict();
const PatchInterest = z.object({
  status: z.enum(['new', 'contacted', 'booked', 'declined']).optional(),
  opsNote: z.string().trim().max(1000).nullable().optional(),
}).strict();

const serialize = (e: Experience) => ({ ...e, createdAt: e.createdAt.toISOString(), updatedAt: e.updatedAt.toISOString() });

export function opsExperiencesRoutes(deps: {
  experiences: ExperienceRepo;
  interests: ExperienceInterestRepo;
  auth: OpsAuthConfig;
  allowedOrigins?: string[];
}) {
  const r = new Hono();
  const csrf: MiddlewareHandler = async (c, next) => {
    const site = c.req.header('sec-fetch-site');
    if (site) {
      if (site !== 'same-origin' && site !== 'none') return c.json({ error: 'bad_origin' }, 403);
      return next();
    }
    const origin = c.req.header('origin');
    if (origin && !(deps.allowedOrigins ?? []).includes(origin)) return c.json({ error: 'bad_origin' }, 403);
    return next();
  };
  r.use('*', opsIdentity(deps.auth));

  r.get('/', requireCap('experiences:manage'), async (c) => {
    const [list, counts] = await Promise.all([deps.experiences.list(), deps.interests.countsByExperience()]);
    return c.json({ experiences: list.map(serialize), counts });
  });

  r.post('/', csrf, requireCap('experiences:manage'), async (c) => {
    const parsed = ExperienceInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
    try {
      const e = await deps.experiences.create({ ...parsed.data, createdBy: c.get('identity').email });
      return c.json({ experience: serialize(e) }, 201);
    } catch (err) {
      if (err instanceof SlugTakenError) return c.json({ error: 'slug_taken' }, 409);
      throw err;
    }
  });

  r.patch('/:id', csrf, requireCap('experiences:manage'), async (c) => {
    const parsed = PatchExperience.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
    try {
      const e = await deps.experiences.patch(c.req.param('id'), { ...parsed.data, updatedBy: c.get('identity').email });
      return e ? c.json({ experience: serialize(e) }) : c.json({ error: 'not_found' }, 404);
    } catch (err) {
      if (err instanceof SlugTakenError) return c.json({ error: 'slug_taken' }, 409);
      throw err;
    }
  });

  r.get('/interests', requireCap('experiences:manage'), async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 200, 1), 500);
    return c.json({ interests: await deps.interests.listOpen(limit) });
  });

  r.patch('/interests/:id', csrf, requireCap('bookings:operate'), async (c) => {
    const parsed = PatchInterest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
    const row = await deps.interests.patch(c.req.param('id'), { ...parsed.data, updatedBy: c.get('identity').email });
    return row ? c.json({ interest: row }) : c.json({ error: 'not_found' }, 404);
  });

  return r;
}
```
Add a test that `PATCH {active:false}` leaves `radiusKm`, `photos` and `details` exactly as they were — it proves the defaults don't fire on a partial.
- [ ] **Step 4: Run → PASS. Commit** — `feat(api): ops experiences CRUD + interest status`.

### Task 2.3: Public `GET /experiences/near`

**Files:** Create `api/src/routes/publicExperiences.ts`; Modify `api/src/app.ts` (mount at `/experiences`; add `app.use('/experiences/*', rateLimit(rl))` next to `:388-399`); Test `api/src/routes/publicExperiences.test.ts`.

**Contract:** `GET /experiences/near?at=Sigiriya@7.95,80.76&at=Kandy@7.29,80.63` (1–8 `at`; label ≤ 60 chars, trimmed; lat/lng numeric in the Sri Lanka box) → `200 { stops: [{ place, items: [PublicExperience & { distanceKm: number /* 1 dp */ }] }] }` with `cache-control: public, max-age=300` (spec D7). Bad/missing `at` → `400 {error:'bad_request'}`. Zero matches → `{ stops: [] }`.

- [ ] **Step 1: Failing tests:** matches + grouping + `distanceKm` rounding; `partnerContact`, `lat`, `lng`, `createdBy` absent from every item (assert on the raw JSON string, e.g. `expect(text).not.toContain('+94')`); 9 `at` params → 400; malformed `at` → 400; inactive excluded; header present; CORS: `Origin: https://ceylonhop.com` gets `access-control-allow-origin` (global CORS, `app.ts:373-387`).
- [ ] **Step 2: Run → FAIL. Step 3: Implement** (parse `at` with `/^(.{1,60})@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/`, then `matchExperiences(stops, await repo.listActive())`, map items through `toPublicExperience`, round `distanceKm` to 1 dp). **Step 4: PASS. Commit** — `feat(api): public experiences-near endpoint`.

**PR 2 gate** as PR 1. No migration. No customer-visible change.

---

## PR 3 — Ops page: Catalogue tab

Branch: `feat/experiences-ops-page`. File: `api/src/routes/ops-ui.html` (+ an e2e spec). Read `origin/main`'s current line numbers first; the anchors below are from 06caf849.

**Behaviour (spec D12):**
- Nav entry **Experiences** (shown when `caps.includes('experiences:manage')`), hash `#experiences`, routed exactly like `#rates`: `routeStateFromUrl` (`:2298`), `syncUrl` (`:2310`), `setNav` + `NAV_ICONS` (`:2441-2468`), the `render()` bounce (`:4190`) and dispatcher (`:4237-4245`), nav click (`:4288-4296`).
- Tabs: **Catalogue** (this PR) and **Interests** (PR 6 — render a placeholder-free empty tab only once PR 6 lands; in this PR, ship Catalogue alone).
- Catalogue list: one row per experience — photo thumb (first photo `small`), name, partner, `$35 pp`, radius, days summary ("Daily" / "Closed Sun"), active toggle, interest counts (new / booked) from `counts`.
- Edit form (new + edit): every `ExperienceInput` field. Weekdays as 7 checkboxes (Sun…Sat). Start times as a comma list (`09:00, 14:30`). Photos as up to 6 stem inputs, each with a live 900px preview from `https://ceylonhop.com/img/experiences/<stem>-900.jpg` and a "not live yet" note on image error (photos go live only after a Pages promote, spec D8). Price entered in dollars, sent as cents (`Math.round(dollars*100)`).
- **Location field:** one text box accepting `7.977, 80.76` or a Google Maps URL (`/@lat,lng,` or `?q=lat,lng`); parsed client-side into lat/lng with an inline error; an "Open in Google Maps" link to check the pin.
- Save → `POST`/`PATCH`; 400 issues mapped to field errors; 409 → "That slug is taken".
- Every `await` guarded with a sequence counter (`var seq=++_expSeq; … if (seq!==_expSeq) return;`) — the `_openSeq` idiom (`:6218`, `:6298-6300`) — so a slow save can't repaint a page the user left.

**Tasks:**
- [ ] 3.1 e2e first: `web-tests/e2e/ops-experiences-page.spec.js`, modelled on `ops-rates-page.spec.js` (same login/stub approach): nav visible for founder/ops, hidden for finance; create an experience → appears in list; swapped "80.76, 7.977" shows a location error and no request is sent; toggle active off → row greys and PATCH sent with `{active:false}`. Run → FAIL.
- [ ] 3.2 Implement routing + nav + list (smallest diff first; `ops-ui.html` is the hot file — rebase before pushing).
- [ ] 3.3 Implement the form + location parser. Put the parser in a small named function `parseLatLng(text)` returning `{lat,lng}|null` so the spec can unit-test it via `page.evaluate`.
- [ ] 3.4 `test:all` + `npm run check` green → commit → PR.

---

## PR 4 — Booking page

Branch: `feat/experiences-booking-page`. Files: `booking.html`, `booking.js`, `api/src/routes/bookings.ts`, tests. Run `npm run stamp` after editing `booking.js` (asset version stamping, enforced by `asset-versions.test.js` and CI `codegen-fresh`).

### Task 4.1: Server — accept `experienceIds` and record interests

**Files:** Modify `api/src/routes/bookings.ts`; Modify `api/src/app.ts` (pass `experiences`, `experienceInterests` into `bookingRoutes`); Test: extend `api/src/routes/bookings.test.ts`.

**Interfaces — Consumes:** `ExperienceRepo.listActive`, `ExperienceInterestRepo.record`.

- [ ] **Step 1: Failing tests** (single, trip, shared): a booking with `experienceIds: [id]` and `experiencePlaces: { [id]: 'Sigiriya' }` creates one interest with `source:'booking_page'`, the booking's id and the snapshot; unknown and inactive ids are dropped, the booking still 201s; > 10 ids → only the first 10 considered; a non-array `experienceIds` → ignored (not a 400 — a stale client must never lose a booking); an interest repo that throws → booking still 201s and `console.error` was called; replaying the same idempotency key doesn't duplicate the interest.
- [ ] **Step 2: Run → FAIL. Step 3: Implement:**

```ts
// in bookings.ts, next to customerNotesFrom
// Partner experiences the customer tapped "I'm interested" on (spec 2026-10-06 D10). Read off the
// raw body like customerNotes so the domain inputs (stable interfaces) don't change. Never a 400:
// a malformed list from an old cached page must not cost us a booking — it is simply ignored.
const MAX_EXPERIENCE_IDS = 10;
function experienceChoicesFrom(body: unknown): Array<{ id: string; place: string }> {
  const b = body as { experienceIds?: unknown; experiencePlaces?: unknown } | null;
  if (!Array.isArray(b?.experienceIds)) return [];
  const places = (b?.experiencePlaces && typeof b.experiencePlaces === 'object') ? b.experiencePlaces as Record<string, unknown> : {};
  return b.experienceIds
    .filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x))
    .slice(0, MAX_EXPERIENCE_IDS)
    .map((id) => ({ id, place: typeof places[id] === 'string' ? String(places[id]).trim().slice(0, 60) || 'your drop-off' : 'your drop-off' }));
}

// Best-effort, after the booking exists — the flagForOps shape (above). An interest is a lead,
// never a reason to fail the booking the customer is paying for.
async function recordInterests(booking: Booking, choices: Array<{ id: string; place: string }>): Promise<void> {
  if (!choices.length || !deps.experiences || !deps.experienceInterests) return;
  try {
    const active = new Map((await deps.experiences.listActive()).map((e) => [e.id, e]));
    for (const ch of choices) {
      const experience = active.get(ch.id);
      if (experience) await deps.experienceInterests.record({ experience, placeLabel: ch.place, source: 'booking_page', bookingId: booking.id });
    }
  } catch (err) {
    console.error(`experience interests failed for ${booking.reference}:`, err);
  }
}
```
Call `await recordInterests(booking, experienceChoicesFrom(body))` immediately before each of the three `return c.json(withCheckoutToken(booking), 201)` (single `:608`, trip, shared). Add `experiences?: ExperienceRepo; experienceInterests?: ExperienceInterestRepo;` to the deps type (optional: unset → nothing recorded, existing tests unchanged).
- [ ] **Step 4: PASS → commit** `feat(bookings): record experience interests from the booking page`.

### Task 4.2: Page — section, toggle, payload

**Behaviour (spec D9, D10, D14, D15):**
- `booking.html`: after `#extras-block` (`:948-951`) add `<div id="experiences-block" hidden></div>` (its own block — `#extras-block` is hidden for trips/shared, `booking.js:2371-2372`) and the card CSS (from the approved mockup; reuse `.addon` tokens: `--line`, `--accent`, `--ok-bg`, `--ok-line`, `--btn-accent`). Summary box `#sum-experiences` after the Total row (inside `#summary`, which is also the mobile sheet).
- `booking.js`:
  - `state.experiences = new Map()` (id → `{ place, name }`), next to `state.addons` (`:288`).
  - `experienceStops()` → `[{label, lat, lng}]` per spec D9 table: private single → `state.locToGeo` if set, else `T.place(routeToId)`, else `T.resolvePlace(toName)`; shared → `T.place(routeToId)`; trip → `tripStops.map(T.resolvePlace)` dropping nulls. Coordinates rounded to 3 dp. Labels: the catalogue place's `name` (or the stop name).
  - `syncExperiences()` called from `render()` when step 3 is shown: builds the `at=` query; if it equals the last query, do nothing; else fetch `${window.CEYLON_HOP_API}/experiences/near?…` with `credentials:'omit'` and a 3 s `AbortController` timeout (pattern: `quote.html` `fetchJson`, `:133-141`). On error/timeout/empty → keep the block `hidden`. Guard with a sequence number so a stale response can't overwrite a newer one.
  - `renderExperiences(stops)`: per stop "While you're in {place}" + the green "Nothing to pay now" box (once, first stop only) + cards. Every string from the API goes through the page's existing escaper (the code comment at `booking.js:192` explains why innerHTML input must be escaped). Images: `loading="lazy"`, `onerror` → hide the img.
  - Card button `data-experience-id`, `aria-pressed`; handler `toggleExperience(btn)` mirrors `toggleAddon` (`:1339-1347`) but **never calls the pricing path** — it updates `state.experiences`, the button ("I'm interested" ↔ "✓ Interested"), the under-card note, and `#sum-experiences`. Fires `track('experience_interest', { experience_slug, place, source:'booking_page', interested })` (spec D17).
  - Details & photos: a `<details>`-style expandable panel inside the card (no modal — keeps focus handling trivial and works in the mobile sheet): details text, all photos (`small` src, `large` in `srcset`), "Open: Mon–Sat", "Times: 09:00 · 14:30".
  - Payload (`createApiBooking`, `:3087`; after the `customerNotes` line `:3209-3210`, all modes): `if (state.experiences.size) { payload.experienceIds=[...state.experiences.keys()]; payload.experiencePlaces=Object.fromEntries([...state.experiences].map(([id,v])=>[id,v.place])); }`.
- **Must not change:** totals, `calcTotal`, the estimate request, the pay button. The e2e asserts it.

**Tasks:**
- [ ] 4.2.1 e2e first: `web-tests/e2e/booking-experiences.spec.js` using `gotoBooking` from `_stubs.js:177` and a `page.route('**/experiences/near*')` stub. Cases: private CMB→Sigiriya shows "While you're in Sigiriya / Dambulla" with 2 cards; tapping one → button "✓ Interested", note "Noted — you won't be charged for this.", summary box shows the name; **the Total text is identical before and after the tap**; the stubbed `/bookings/single` request body contains `experienceIds` and `experiencePlaces`; stub returns 500 → no `#experiences-block` visible and the booking still completes; trip mode with stops `Sigiriya|Kandy` sends two `at=` params; the button text never contains "free". Run → FAIL.
- [ ] 4.2.2 Implement markup + CSS. 4.2.3 Implement JS. 4.2.4 `npm run stamp`. 4.2.5 Browser-preview check at 375 px and desktop (the mockup's phone layout needed a stacked price row — keep it). 4.2.6 Gates green → commit → PR.

---

## PR 5 — Quote page

Branch: `feat/experiences-quote-page`. Files: `api/src/routes/quoteView.ts`, new `api/src/experiences/quoteStops.ts`, `quote.html`, the three conversion paths, tests.

### Task 5.1: Stops for a quote + experiences in `/quote-view`

**Interfaces — Produces:**
```ts
// api/src/experiences/quoteStops.ts
export async function quoteStopPoints(request: unknown, placeResolutions: PlaceResolutionRepo): Promise<StopPoint[]>;
// Each non-stay leg's `to` in order (the first `from` — usually the airport — is never a stop),
// de-duplicated by canonical name; point = knownCoords(name) ?? placeResolutions.get(canonPlace(name)); unresolved → skipped.
```
- [ ] Failing unit tests for `quoteStopPoints`: airport origin excluded; `Colombo Airport → Sigiriya → Kandy` gives `[Sigiriya, Kandy]`; a "7.9,80.7" literal stop resolves via `knownCoords`'s `parseLatLng`; an unknown name is skipped; labels use `shortPlace` like the stay titles (`quoteDays.ts:100`).
- [ ] Failing route tests in `quoteView.test` (existing file): a live quote with a Sigiriya leg returns `view.experiences = [{ place:'Sigiriya', items:[…public fields…] }]`; `partnerContact` absent; matcher throwing → `experiences: []` and still 200 (spec D15); `booked`/`unavailable` states carry no experiences; each item carries `interested: boolean` from `listForQuote`.
- [ ] Implement: add optional deps `experiences`, `experienceInterests`, `placeResolutions` to `quoteViewRoutes` (`app.ts:606`); build experiences after `customerQuoteView(...)` in a try/catch. Keep `customerQuoteView` itself pure and unchanged.
- [ ] PASS → commit `feat(quote-view): experiences near the quote's stops`.

### Task 5.2: `POST /quote-view/interest`

**Contract:** body `{ t: string, experienceId: uuid, interested: boolean }` (strict). Token → `verifyQuoteViewToken` (`bookingToken.ts:208`); quote must be `ready|sent` (live or lapsed — the same liveness `quoteView.ts:169-191` computes); the experience must be in this quote's computed matches (re-run `quoteStopPoints` + `matchExperiences`; this stops a token being used to attach arbitrary experiences). `interested:true` → `record({source:'quote_page', quoteId, placeLabel})`; `false` → `withdrawFromQuote`. Responses: `200 {interested}`; bad body `400`; bad token / dead quote `409 {error:'quote_unavailable'}`; not offered `422 {error:'not_offered'}`. Rate limit: `app.use('/quote-view/*', rateLimit(rl))`. Update the file header comment at `quoteView.ts:12-13` ("no POST") to state the exception and its reason (spec D11).
- [ ] Failing tests for each response + idempotent double-tap + withdraw after ops moved it to `contacted` returns `200 {interested:true}` (kept) → implement → PASS → commit.

### Task 5.3: Link quote interests when a quote becomes a booking

Call `experienceInterests.linkQuoteToBooking(quote.id, booking.id)` (try/catch + `console.error`, never fails the conversion) at all three conversion points:
1. `postgresQuoteConversionRepo.ts` after the transaction at `:82-91` (and the in-memory `quoteConversionRepo.ts:249-285`) — do it in the **route** (`quoteConversion.ts:33`) after `convert()` resolves, so the repo stays single-purpose.
2. `quotePay.ts` after the `quotes.patch(quote.id, { convertedBookingId })` at `:345`.
3. `internalQuote.ts` after the patch at `:1157-1159` (and the re-link branch at `:1094`).
- [ ] One failing test per path (interest recorded on the quote → after conversion, `listForBooking(booking.id)` contains it) → implement → PASS → commit.

### Task 5.4: `quote.html` section

- Render after the Day-by-day ticket (`quote.html:410-413`), before `pp-note`: per stop "While you're in {place}", the D14 box, cards identical in content to the booking page (same copy, same "✓ Interested" state, same under-card note). Initial state from `item.interested`.
- Tap → `POST ${API}/quote-view/interest` with `{t: token, experienceId, interested}`; optimistic toggle, revert + a small inline "Couldn't save — try again" on failure. `track('experience_interest', {…, source:'quote_page'})`.
- No pay/price change; the quote's option cards are untouched.
- [ ] e2e first: extend the `quote-page.spec.js` stubs (`stubQuoteView`, `:72-79`) with `experiences` in the view and a `**/quote-view/interest` route; cases: section renders after "Day by day"; tap sends the POST and flips the button; POST 500 reverts the button and shows the retry line; `experiences: []` renders nothing. → FAIL → implement → `npm run stamp` if needed → PASS → commit → PR (body: "reverses the quote page's no-POST decision — see spec D11").

---

## PR 6 — Ops visibility + emails

Branch: `feat/experiences-ops-visibility`.

### Task 6.1: Enrich the interests queue
`GET /admin/experiences/interests` returns each open interest with `{ reference, customerName, travelDate, ownerKind:'booking'|'quote' }`. Load bookings and quotes for the page's interests with **one batched read each** (collect ids → `Promise.all` over the repos' existing by-id reads, capped at the 500-row limit). Reason for not adding a join to the repo: it keeps the interest repo independent of booking/quote shapes. If the batched reads show up as slow (ops bookings list was N+1 before #703), add `getMany` to the booking repo then — not before.
- [ ] Failing route test → implement → PASS → commit.

### Task 6.2: Interests tab (ops-ui)
Second tab on `#experiences`: table of open interests (new first, then contacted; newest first), columns: date, customer, booking/quote ref (link to the existing booking sheet / quote), travel date, place, experience, status `<select>`, note (inline edit, save on blur → `PATCH`). Guard awaits with the sequence idiom.
- [ ] e2e first (`ops-experiences-page.spec.js` extended) → implement → commit.

### Task 6.3: Booking sheet block
In `renderSheet()` (`ops-ui.html:3951`, body blocks `:4012-4045`) add an "Interested in" block after "Trip" when `GET /bookings/:id` returns `experienceInterests` (add `listForBooking` to that route's response). Status select reuses 6.2's control.
- [ ] Failing API test (detail response includes interests) + e2e → implement → commit.

### Task 6.4: Email rows
- Customer confirmation (`sendBookingConfirmation`, `notifications.ts:622`, called from `webhooks.ts:393`): pass the booking's interests; `factRows` (`:214-261`) gains `['Interested in', 'Ayurvedic massage (Atherya Spa), … — not charged; our Pro team will reach out']` when non-empty. HTML and text both come from `factRows`.
- Team paid email (`teamPaidEmail`, `opsNotifications.ts:342`): same row in `bookingFacts`.
- Preview fixtures (`devEmails.ts:74`, `:92`) get one interest so the preview shows the row.
- [ ] Failing tests asserting the row in HTML + text, and its absence when there are none; the `emailBrand.test.ts` guards must stay green → implement → commit → PR.

---

## Launch checklist (owner + ops; not code)

- [ ] **L1** Owner approves the promote that carries migration 0065 (prod migration gate).
- [ ] **L2** Photos: for each partner, resize to `-1800`/`-900` (`sips -Z 900 x-1800.jpg --out x-900.jpg`), commit to `img/experiences/<slug>/`, add credits if not our own photos, promote to `production`.
- [ ] **L3** Ops enters the experiences **inactive**, checks each pin with "Open in Google Maps", then activates.
- [ ] **L4** Test booking on staging: CMB → Sigiriya shows the section; tap; booking appears with the interest in ops.
- [ ] **L5** Owner decides open item 1 (ops role holds `experiences:manage`).

## Self-review (done)

- Spec coverage: D1 → PR 4/5 e2e "total unchanged"; D2 naming → constraints; D3–D5 → PR 1; D6–D7 → 1.2, 2.3; D8 → 1.2 `photoUrls`, 3 preview, L2; D9 → 4.2, 5.1; D10 → 4.1–4.2; D11 → 5.2–5.4; D12 → 2.1–2.2, 3; D13 → 6; D14 → 4.2/5.4 e2e copy asserts; D15 → 4.1, 4.2, 5.1 failure tests; D16 → no flag anywhere; D17 → 4.2, 5.4 `track`.
- Names used across tasks: `ExperienceRepo`, `ExperienceInterestRepo`, `matchExperiences`, `StopPoint`, `toPublicExperience`, `photoUrls`, `quoteStopPoints`, `recordInterests`, `experienceChoicesFrom`, `linkQuoteToBooking`, `withdrawFromQuote`, `listOpen`, `countsByExperience` — each defined once above.
- Deliberate exception to "complete code in every step": PRs 3–6's DOM code (reason at the top).
