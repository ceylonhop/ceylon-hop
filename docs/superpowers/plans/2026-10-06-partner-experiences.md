# Partner Experiences (phase 1) Implementation Plan — revision 2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show partner experiences near a customer's drop-off on the booking page and the quote page, record "I'm interested" (never charged), and give ops a page to maintain the catalogue and work each lead through to a PayHere link and "paid".

**Architecture:** Two new Postgres tables (`experiences`, `experience_interests`) behind repo interfaces with in-memory fakes. One pure matcher (`matchExperiences`: haversine ≤ each experience's own radius) used by a public `GET /experiences/near` (booking page) and in-process by `GET /quote-view` (quote page). Ops CRUD and a leads queue under `/admin/experiences` with a new `experiences:manage` capability; an ops-ui page with Catalogue + Leads tabs. Photos are repo files on GitHub Pages, referenced by stem. Experience payments happen outside the system (PayHere portal links); ops records the reference and amount.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Drizzle + Postgres · Vitest · Playwright (web-tests) · classic-script browser JS (`booking.js`, `quote.html`, `ops-ui.html`).

**Spec:** `docs/superpowers/specs/2026-10-06-partner-experiences-design.md` (revision 2). Decisions D1–D19 and their reasons live there; tasks cite them.
**Grounding:** file:line anchors are `origin/main` @ 06caf849 (2026-10-06). Lines drift daily — every PR re-reads its anchors on `origin/main` before editing.

## Global Constraints

- Money = integer minor units + ISO currency. Experience price currency: `'USD'` only. Recorded payment currency: `'USD'` or `'LKR'`.
- Code name is **experience(s)** — never "add-on"/"extra" (spec D2).
- Customer copy is exactly spec D16. The button never says "free" or "no charge".
- The browser sends **only experience uuids**; every label shown in the ops tool comes from the server (spec D11).
- Interests must never fail a booking, a quote page, or a conversion: write after, catch, `console.error` (spec D17).
- `partner_contact`, `lat`, `lng` never leave an `/admin/*` route.
- Photos: a path under `img/` without the size suffix, matching `^[a-z0-9-]+(/[a-z0-9-]+){1,3}$`; served as `https://ceylonhop.com/img/<path>-900.jpg` / `-1800.jpg` (spec D8).
- Staging test data = the three Sigiriya placeholders only, seeded into the **staging** DB by SQL paste; never a migration, never prod (spec D20).
- Pins inside Sri Lanka: lat 5.8–10.0, lng 79.4–82.0.
- No changes to `rateCard.ts`, `departureRepo.ts`, `config.ts`, env, or any `@generated:` block (maintenance rule 3).
- Gate before every commit: `cd api && npm run check` and `npm --prefix <abs>/web-tests run test:all`, both read from the runner's own summary line and exit code (maintenance rule 4).
- Stage files by path, never `git add -A`; work in a worktree, not the shared tree (maintenance rule 6).
- DB tests use `DATABASE_URL_TEST` only — `api/.env`'s `DATABASE_URL` is prod.

## PR order, and why

One step = one branch = one PR (Hard rule 1). Each PR leaves `main` green and shippable.

| PR | Delivers | Why in this position |
|---|---|---|
| 1 | Migration 0065, schema, domain types, matcher, repos, wiring | Everything reads these. The migration's release (auto-apply on staging at merge) gets reviewed on its own (CLAUDE.md rule 7). |
| 2 | Capability; ops API (catalogue, leads, lead status); public `GET /experiences/near` | API before UI so UI PRs test against a real contract. Nothing customer-visible. |
| 3 | Ops page — Catalogue tab | Ops can enter experiences (inactive) before customers can see any. |
| 4 | Ops page — Leads tab; booking-sheet block; team paid email row | **Ops visibility before any customer surface**, so no lead can arrive where nobody sees it. |
| 5 | Booking page section + `experienceIds` write + customer confirmation email row | Highest-traffic surface. |
| 6 | Quote page — **gated on the coverage check** — section, `POST /quote-view/interest`, quote→booking linking | Reverses the quote page's no-POST decision; worth building only if quote stops resolve to points. |

**Detail level:** PRs 1–2 carry complete code. PRs 3–6 edit `ops-ui.html`, `booking.js` and `quote.html`, which change on `main` almost daily (`ops-ui.html` is the repo's hottest file). For those, this plan fixes the behaviour, interfaces, anchors and tests; **each of PRs 3–6 starts with a short planning pass** that reads the anchors on current `origin/main` and writes the DOM code into the PR's task list before coding. Pre-written DOM code against today's lines would be stale before it merged.

---

## PR 1 — Data model, matcher, repos

Branch: `feat/experiences-data`

### Task 1.1: Migration 0065 + Drizzle schema

**Files:** Create `api/drizzle/0065_experiences.sql`; Modify `api/drizzle/meta/_journal.json`; Modify `api/src/db/schema.ts` (append after `promoCodes`); Test `api/src/db/experiencesMigration.test.ts`.

**Produces:** Drizzle tables `experiences`, `experienceInterests`.

- [ ] **Step 1: Re-check the number.** `git fetch origin && git ls-tree --name-only origin/main api/drizzle/ | grep sql | tail -2` and `gh pr list --state open --search drizzle`. If 0065 is taken or pending, use the next free number and a `when` above the newest journal entry.

- [ ] **Step 2: Failing test**

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
    expect(sql).toMatch(/"amount_paid_currency" in \('USD', 'LKR'\)/);
  });
  it('refuses "paid" without a payment reference', () => {
    expect(sql).toMatch(/experience_interests_paid_has_ref/);
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
      INSERT INTO experiences (slug, name, partner_name, area_label, summary, price_cents, price_unit, lat, lng)
      VALUES (${'mig-test-' + Date.now()}, 'x', 'y', 'Sigiriya', 'z', 100, 'per_person', 7.95, 80.76) RETURNING id`;
    await expect(db`
      INSERT INTO experience_interests (experience_id, source, name_snapshot, price_cents_snapshot, price_unit_snapshot)
      VALUES (${e!.id}, 'booking_page', 'x', 100, 'per_person')`).rejects.toThrow(/experience_interests_has_owner/);
  });
});
```

- [ ] **Step 3: Run → FAIL** — `cd api && npx vitest run src/db/experiencesMigration.test.ts` (ENOENT on the .sql).

- [ ] **Step 4: Implement**

```sql
-- api/drizzle/0065_experiences.sql
-- Partner experiences (spec 2026-10-06). Hand-written: drizzle-kit generate needs a TTY.
CREATE TABLE "experiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"partner_name" text NOT NULL,
	"area_label" text NOT NULL,
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
	"source" text NOT NULL,
	"name_snapshot" text NOT NULL,
	"price_cents_snapshot" integer NOT NULL,
	"price_unit_snapshot" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"payment_ref" text,
	"amount_paid_cents" integer,
	"amount_paid_currency" text,
	"ops_note" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experience_interests_has_owner" CHECK ("booking_id" is not null or "quote_id" is not null),
	CONSTRAINT "experience_interests_source_valid" CHECK ("source" in ('booking_page', 'quote_page')),
	CONSTRAINT "experience_interests_status_valid" CHECK ("status" in ('new', 'contacted', 'link_sent', 'paid', 'declined')),
	CONSTRAINT "experience_interests_paid_has_ref" CHECK ("status" <> 'paid' or "payment_ref" is not null),
	CONSTRAINT "experience_interests_amount_valid" CHECK ("amount_paid_cents" is null or "amount_paid_cents" >= 0),
	CONSTRAINT "experience_interests_amount_currency_valid" CHECK ("amount_paid_currency" is null or "amount_paid_currency" in ('USD', 'LKR')),
	CONSTRAINT "experience_interests_ref_length" CHECK ("payment_ref" is null or char_length("payment_ref") <= 100),
	CONSTRAINT "experience_interests_note_length" CHECK ("ops_note" is null or char_length("ops_note") <= 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "experience_interests_booking_uq" ON "experience_interests" ("experience_id", "booking_id") WHERE "booking_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "experience_interests_quote_uq" ON "experience_interests" ("experience_id", "quote_id") WHERE "quote_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "experience_interests_status_idx" ON "experience_interests" ("status");
```

Journal entry (append after idx 64; `when` = previous + 86 400 000):

```json
    {
      "idx": 65,
      "version": "7",
      "when": 1791158400000,
      "tag": "0065_experiences",
      "breakpoints": true
    }
```

Schema (append to `api/src/db/schema.ts`; every helper used is already imported — `pg-core` helpers on line 1, `sql` on line 2):

```ts
// Partner experiences (spec 2026-10-06 D4; migration 0065). The catalogue ops maintains on the
// Experiences page. Money is cents + currency; open days and start times are structured so a later
// paid phase can use them. partner_contact and the pin are ops-only.
export const experiences = pgTable('experiences', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  partnerName: text('partner_name').notNull(),
  areaLabel: text('area_label').notNull(),
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
  createdBy: text('created_by'),
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// One row per customer × experience (spec D5). Snapshots keep the price THIS customer was shown —
// the amount ops puts on their PayHere link. Payment happens outside our system (spec D13), so
// payment_ref + amount are the only record of it. A quote interest gains booking_id at conversion.
export const experienceInterests = pgTable('experience_interests', {
  id: uuid('id').primaryKey().defaultRandom(),
  experienceId: uuid('experience_id').notNull().references(() => experiences.id),
  bookingId: uuid('booking_id').references(() => bookings.id),
  quoteId: uuid('quote_id').references(() => quotes.id),
  source: text('source').notNull(),
  nameSnapshot: text('name_snapshot').notNull(),
  priceCentsSnapshot: integer('price_cents_snapshot').notNull(),
  priceUnitSnapshot: text('price_unit_snapshot').notNull(),
  status: text('status').notNull().default('new'),
  paymentRef: text('payment_ref'),
  amountPaidCents: integer('amount_paid_cents'),
  amountPaidCurrency: text('amount_paid_currency'),
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

- [ ] **Step 5: Run → PASS** (the DB block runs with `DATABASE_URL_TEST` set to the local test DB).
- [ ] **Step 6: Commit** — `git add api/drizzle/0065_experiences.sql api/drizzle/meta/_journal.json api/src/db/schema.ts api/src/db/experiencesMigration.test.ts && git commit -m "feat(db): experiences + experience_interests tables (0065)"`

### Task 1.2: Domain types + matcher

**Files:** Create `api/src/experiences/experience.ts`, `api/src/experiences/match.ts`; Tests `api/src/experiences/experience.test.ts`, `api/src/experiences/match.test.ts`.

**Produces:**
```ts
// experience.ts
export type PriceUnit = 'per_person' | 'per_group';
export const PHOTO_ORIGIN = 'https://ceylonhop.com';
export const ROAD_FACTOR = 1.35;
export const ExperienceInputSchema; // z.object({...}).strict() — the create body
export type ExperienceInput = z.output<typeof ExperienceInputSchema>;
export interface Experience extends ExperienceInput { id; currency: 'USD'; createdBy; updatedBy; createdAt: Date; updatedAt: Date }
export interface PublicExperience { id; slug; name; partnerName; areaLabel; summary; details; priceCents; currency: 'USD';
  priceUnit; durationText; openWeekdays; startTimes; photos: Array<{ small: string; large: string }> }
export function photoUrls(stem: string): { small: string; large: string };
export function toPublicExperience(e: Experience): PublicExperience;
export function aboutKm(straightLineKm: number): number;
// match.ts
export interface StopPoint { label: string; lat: number; lng: number }
export interface StopMatch<E> { place: string; items: Array<{ experience: E; distanceKm: number }> }
export const MAX_PER_STOP = 6;
export function matchExperiences<E extends Pick<Experience, 'id' | 'lat' | 'lng' | 'radiusKm' | 'active'>>(stops: StopPoint[], experiences: E[]): StopMatch<E>[];
```

- [ ] **Step 1: Failing matcher test**

```ts
// api/src/experiences/match.test.ts
import { describe, expect, it } from 'vitest';
import { MAX_PER_STOP, matchExperiences } from './match';

// Sigiriya catalogue point (transfers-data.js) and pins due north at known offsets; 0.009° lat ≈ 1 km.
const SIGIRIYA = { label: 'Sigiriya', lat: 7.95, lng: 80.76 };
const KANDY = { label: 'Kandy', lat: 7.2906, lng: 80.6337 };
const exp = (id: string, kmNorth: number, radiusKm: number, active = true) =>
  ({ id, lat: 7.95 + kmNorth * 0.009, lng: 80.76, radiusKm, active });

describe('matchExperiences (spec D6)', () => {
  it('shows an experience inside its own radius and hides one outside it', () => {
    const r = matchExperiences([SIGIRIYA], [exp('near', 3, 5), exp('far', 8, 5)]);
    expect(r[0]!.items.map((m) => m.experience.id)).toEqual(['near']);
    expect(r[0]!.items[0]!.distanceKm).toBeCloseTo(3, 0);
  });
  it('uses each experience’s own reach: 25 km out with a 30 km radius matches', () => {
    expect(matchExperiences([SIGIRIYA], [exp('safari', 25, 30)])[0]!.items[0]!.experience.id).toBe('safari');
  });
  it('sorts nearest first', () => {
    const r = matchExperiences([SIGIRIYA], [exp('a', 4, 10), exp('b', 1, 10), exp('c', 2, 10)]);
    expect(r[0]!.items.map((m) => m.experience.id)).toEqual(['b', 'c', 'a']);
  });
  it('ignores inactive experiences', () => {
    expect(matchExperiences([SIGIRIYA], [exp('off', 1, 5, false)])).toEqual([]);
  });
  it(`caps a stop at ${MAX_PER_STOP}`, () => {
    const many = Array.from({ length: 9 }, (_, i) => exp(`e${i}`, 1, 5));
    expect(matchExperiences([SIGIRIYA], many)[0]!.items).toHaveLength(MAX_PER_STOP);
  });
  it('never repeats an experience under a later stop', () => {
    const r = matchExperiences([SIGIRIYA, KANDY], [exp('both', 1, 200)]);
    expect(r).toHaveLength(1);
    expect(r[0]!.place).toBe('Sigiriya');
  });
  it('omits stops with no matches', () => {
    expect(matchExperiences([KANDY], [exp('near-sigiriya', 1, 5)])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement**

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

type Matchable = Pick<Experience, 'id' | 'lat' | 'lng' | 'radiusKm' | 'active'>;

export function matchExperiences<E extends Matchable>(stops: StopPoint[], experiences: E[]): StopMatch<E>[] {
  const shown = new Set<string>();
  const out: StopMatch<E>[] = [];
  for (const stop of stops) {
    const items = experiences
      .filter((e) => e.active && !shown.has(e.id))
      .map((e) => ({ experience: e, distanceKm: haversineKm([stop.lat, stop.lng], [e.lat, e.lng]) }))
      .filter((m) => m.distanceKm <= m.experience.radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, MAX_PER_STOP);
    for (const m of items) shown.add(m.experience.id);
    if (items.length) out.push({ place: stop.label, items });
  }
  return out;
}
```

- [ ] **Step 4: Failing input/projection test**

```ts
// api/src/experiences/experience.test.ts
import { describe, expect, it } from 'vitest';
import { ExperienceInputSchema, aboutKm, toPublicExperience, type Experience } from './experience';

const valid = {
  slug: 'atherya-massage', name: 'Ayurvedic massage', partnerName: 'Atherya Spa', areaLabel: 'Sigiriya',
  summary: 'Full-body herbal oil massage and steam bath.', details: '', priceCents: 3500,
  priceUnit: 'per_person', durationText: '90 min', openWeekdays: [6, 1, 1, 0], startTimes: ['14:30', '09:00'],
  lat: 7.977, lng: 80.76, radiusKm: 5, photos: ['experiences/atherya-massage/treatment'], partnerContact: '+94 77 000 0000',
  active: true,
};

describe('ExperienceInputSchema', () => {
  it('accepts a valid experience and normalises weekdays and times (unique, sorted)', () => {
    const r = ExperienceInputSchema.parse(valid);
    expect(r.openWeekdays).toEqual([0, 1, 6]);
    expect(r.startTimes).toEqual(['09:00', '14:30']);
  });
  it('refuses a swapped "lng, lat" paste (outside Sri Lanka)', () => {
    expect(ExperienceInputSchema.safeParse({ ...valid, lat: 80.76, lng: 7.977 }).success).toBe(false);
  });
  it('refuses a bad time, a bad photo stem, a negative price and unknown fields', () => {
    expect(ExperienceInputSchema.safeParse({ ...valid, startTimes: ['9am'] }).success).toBe(false);
    expect(ExperienceInputSchema.safeParse({ ...valid, photos: ['../x'] }).success).toBe(false);
    expect(ExperienceInputSchema.safeParse({ ...valid, photos: ['treatment'] }).success).toBe(false);
    expect(ExperienceInputSchema.safeParse({ ...valid, priceCents: -1 }).success).toBe(false);
    expect(ExperienceInputSchema.safeParse({ ...valid, priority: 1 }).success).toBe(false);
  });
  it('a partial (PATCH) leaves omitted fields undefined — defaults do not fire', () => {
    expect(ExperienceInputSchema.partial().strict().parse({ active: false })).toEqual({ active: false });
  });
});

describe('toPublicExperience', () => {
  it('never exposes partner contact, the pin or audit fields, and builds absolute photo URLs', () => {
    const e: Experience = { ...ExperienceInputSchema.parse(valid), id: 'x', currency: 'USD',
      createdBy: 'a@b', updatedBy: null, createdAt: new Date(), updatedAt: new Date() };
    const json = JSON.stringify(toPublicExperience(e));
    expect(json).not.toContain('+94');
    expect(json).not.toContain('"lat"');
    expect(json).not.toContain('createdBy');
    expect(toPublicExperience(e).photos).toEqual([{
      small: 'https://ceylonhop.com/img/experiences/atherya-massage/treatment-900.jpg',
      large: 'https://ceylonhop.com/img/experiences/atherya-massage/treatment-1800.jpg',
    }]);
  });
});

describe('aboutKm', () => {
  it('road-adjusts straight-line km with the codebase’s own 1.35 factor (maps.ts fallback)', () => {
    expect(aboutKm(3)).toBe(4);
    expect(aboutKm(25)).toBe(34);
  });
});
```

- [ ] **Step 5: Run → FAIL, then implement**

```ts
// api/src/experiences/experience.ts
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
```

- [ ] **Step 6: Run both → PASS. Commit** — `git add api/src/experiences/ && git commit -m "feat(experiences): domain types, input schema and distance matcher"`

### Task 1.3: Experience repo (in-memory + Postgres)

**Files:** Create `api/src/db/experienceRepo.ts`, `api/src/db/postgresExperienceRepo.ts`; Test `api/src/db/experienceRepo.test.ts`.

**Produces:**
```ts
export class SlugTakenError extends Error {}
export interface ExperiencePatch extends Partial<ExperienceInput> { updatedBy?: string | null }
export interface ExperienceRepo {
  list(): Promise<Experience[]>;           // active first, then name
  listActive(): Promise<Experience[]>;
  get(id: string): Promise<Experience | null>;
  getMany(ids: string[]): Promise<Experience[]>;
  create(e: ExperienceInput & { createdBy?: string | null }): Promise<Experience>;  // SlugTakenError
  patch(id: string, p: ExperiencePatch): Promise<Experience | null>;                // SlugTakenError
}
export class InMemoryExperienceRepo implements ExperienceRepo {}
export class PostgresExperienceRepo implements ExperienceRepo { constructor(db: Db) }
```
No `remove` (spec D14).

- [ ] **Step 1: Contract test** — `function contract(name: string, make: () => Promise<ExperienceRepo>)` run for in-memory and (`describe.skipIf(!process.env.DATABASE_URL_TEST)`) Postgres after `migrate()` (setup copied from `api/src/db/experiencesMigration.test.ts`). Cases: create → get round-trips every field incl. arrays and `currency:'USD'`; `listActive` excludes inactive; `list` orders active first then name; `getMany` returns only the asked ids; `patch` changes only given fields and bumps `updatedAt`; unknown id → `null`; duplicate slug on create and patch → `SlugTakenError`. Postgres rows use a per-run slug prefix (`t${Date.now()}-`) since the test DB is shared.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**, mirroring `api/src/db/zonesRepo.ts` (in-memory Map) and `api/src/db/postgresZonesRepo.ts` (`toRow` mapper; `patch` builds its SET from provided fields only). Postgres maps a unique violation on `experiences_slug_unique` to `SlugTakenError` — **walk the error's `.cause` chain** like `api/src/db/postgresBookingRepo.ts:131-136` (Drizzle wraps the driver error, so a bare `err.code === '23505'` check misses it and the route returns 500 instead of 409). `postgresZonesRepo.ts` has no such handling to copy. `getMany` uses `inArray(experiences.id, ids)` and returns `[]` for empty input without querying.
- [ ] **Step 4: Run → PASS. Commit** — `feat(db): experience repo (in-memory + Postgres)`.

### Task 1.4: Interest repo (in-memory + Postgres)

**Files:** Create `api/src/db/experienceInterestRepo.ts`, `api/src/db/postgresExperienceInterestRepo.ts`; Test `api/src/db/experienceInterestRepo.test.ts`.

**Produces:**
```ts
export type InterestStatus = 'new' | 'contacted' | 'link_sent' | 'paid' | 'declined';
export type InterestSource = 'booking_page' | 'quote_page';
export const OPEN_STATUSES: InterestStatus[] = ['new', 'contacted', 'link_sent'];
export const PAID_BOOKING_STATUSES = ['paid', 'confirmed', 'in_progress', 'completed'] as const; // api/src/domain/status.ts
export interface ExperienceInterest { id; experienceId; bookingId: string | null; quoteId: string | null; source: InterestSource;
  nameSnapshot: string; priceCentsSnapshot: number; priceUnitSnapshot: PriceUnit; status: InterestStatus;
  paymentRef: string | null; amountPaidCents: number | null; amountPaidCurrency: 'USD' | 'LKR' | null;
  opsNote: string | null; updatedBy: string | null; createdAt: Date; updatedAt: Date }
export interface Lead extends ExperienceInterest { areaLabel: string; experienceName: string;
  ownerKind: 'booking' | 'quote'; reference: string; customerName: string; contact: string | null;
  travelDate: string | null }
export interface InterestPatch { status?: InterestStatus; opsNote?: string | null; paymentRef?: string | null;
  amountPaidCents?: number | null; amountPaidCurrency?: 'USD' | 'LKR' | null; updatedBy: string }
export interface ExperienceStats { experienceId: string; interested: number; paid: number;
  paidCents: { USD: number; LKR: number } }
export interface ExperienceInterestRepo {
  record(i: { experience: Experience; source: InterestSource; bookingId?: string; quoteId?: string }): Promise<ExperienceInterest>; // idempotent
  get(id: string): Promise<ExperienceInterest | null>;
  withdrawFromQuote(experienceId: string, quoteId: string): Promise<boolean>; // deletes only while 'new'
  linkQuoteToBooking(quoteId: string, bookingId: string): Promise<number>;
  listForBooking(bookingId: string): Promise<ExperienceInterest[]>;
  listForQuote(quoteId: string): Promise<ExperienceInterest[]>;
  listLeads(limit: number): Promise<Lead[]>;   // ONE query; spec D10 + D15 filter
  stats(): Promise<ExperienceStats[]>;
  patch(id: string, p: InterestPatch): Promise<ExperienceInterest | null>;
}
```
The in-memory class takes `{ bookings?: BookingRepo; quotes?: QuoteRepo; experiences?: ExperienceRepo }` in its constructor so `listLeads` can be faked in route tests; it is test-only.

- [ ] **Step 1: Contract tests** — `record` twice for the same (experience, booking) returns the **same** id; snapshots come from the experience and stay unchanged after its price changes; `withdrawFromQuote` deletes a `new` row, and returns `false` and keeps it once `contacted`; `linkQuoteToBooking` sets `bookingId` and is a no-op the second time; `patch` to `paid` without a ref rejects (Postgres: the CHECK; in-memory: throw `Error('paid_requires_ref')`); `listLeads`:
  - includes a lead on a booking in `paid` and one on a quote in `sent`;
  - **excludes** a lead on a `draft` booking, on a `cancelled` booking, on a `lost` quote, on a **deleted** quote (`deleted_at` set), and any lead already `paid`/`declined`;
  - returns `reference`, `customerName` (booking: `first_name last_name`; quote: `customer_name`), `contact` (booking: `whatsapp`; quote: `customer_contact`), `travelDate` (booking: earliest `booking_legs.travel_date`; quote: first dated leg in `request_json.tool.legs`);
  - `stats` counts interested/paid and sums paid cents per currency.
  Seeding real bookings and quotes for the Postgres block: copy the setup in `api/src/db/postgresPaymentLookup.test.ts` (it builds `PostgresBookingRepo` and `PostgresQuoteRepo` on the test DB at :35–36 and creates bookings from :43). There is **no** shared seeding helper — `api/src/testSupport/` holds only `dates.ts`; anchor dates with it.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Postgres `record`: `insert … onConflictDoNothing()` then select by `(experience_id, booking_id|quote_id)`. `linkQuoteToBooking` (Drizzle `sql` template):
```sql
UPDATE experience_interests i SET booking_id = ${bookingId}, updated_at = now()
WHERE i.quote_id = ${quoteId} AND i.booking_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM experience_interests x WHERE x.experience_id = i.experience_id AND x.booking_id = ${bookingId})
```
`listLeads` — one statement (spec D15):
```sql
SELECT i.*, e.area_label, e.name AS experience_name,
       b.reference AS booking_ref, c.first_name, c.last_name, c.whatsapp,
       (SELECT min(l.travel_date) FROM booking_legs l WHERE l.booking_id = b.id) AS booking_travel_date,
       q.reference AS quote_ref, q.customer_name AS quote_customer, q.customer_contact AS quote_contact,
       q.request_json AS quote_request
FROM experience_interests i
JOIN experiences e ON e.id = i.experience_id
LEFT JOIN bookings b ON b.id = i.booking_id
LEFT JOIN customers c ON c.id = b.customer_id
LEFT JOIN quotes q ON q.id = i.quote_id
WHERE i.status IN ('new', 'contacted', 'link_sent')
  AND ( (i.booking_id IS NOT NULL AND b.status IN ('paid', 'confirmed', 'in_progress', 'completed'))
     OR (i.booking_id IS NULL AND q.status IN ('ready', 'sent') AND q.deleted_at IS NULL) )
ORDER BY i.created_at DESC
LIMIT ${limit}
```
The quote travel date is derived in TypeScript from `quote_request`: the **first** leg with a `date`, read through `requestLegs()` (`api/src/db/quoteRouteText.ts:14-27`, which falls back to the top-level `legs` older rows use). Don't reuse `quoteTravelDate` (`api/src/db/quoteTravelDate.ts`) — it returns the **last** date.
- [ ] **Step 4: Run → PASS. Commit** — `feat(db): experience interest repo with the leads query`.

### Task 1.5: Wire the repos

**Files:** Modify `api/src/app.ts` (`AppDeps`: `experiences?`, `experienceInterests?`, defaulting to in-memory next to `zones` — `AppDeps.zones` at `:110`, its default at `:242`); `api/src/server.ts` (construct both Postgres repos beside `new PostgresZonesRepo(db)` at `:173`; the warning at `:166-181` is why); `api/src/serverWiring.test.ts` (assert prod passes the Postgres classes).
- [ ] Failing wiring test → implement → `cd api && npm run check` → commit `feat(api): wire experience repos`.

**PR 1 gate:** both gates green (summary lines pasted). PR body: **"Contains migration 0065 — auto-applies on staging at merge; prod only at the next promote, which needs the owner's OK."** Red→green evidence pasted.

---

## PR 2 — Capability, ops API, public matcher endpoint

Branch: `feat/experiences-api`

### Task 2.1: Capability `experiences:manage`
**Files:** `api/src/lib/opsAuth.ts` (add to `OpsAction` at `:4-7`; add to the **founder** and **ops** sets in `CAPABILITIES` at `:30-35`; one comment line above the matrix: display-only price, owner wants ops to maintain it — spec D14); extend the existing opsAuth test.
- [ ] Failing test (`can('ops','experiences:manage')` true; finance false; system false; `ALL_OPS_ACTIONS` includes it) → implement → PASS → commit. (Owner decided 2026-10-06: ops holds it.)

### Task 2.2: `/admin/experiences` routes
**Files:** Create `api/src/routes/opsExperiences.ts`; Modify `api/src/app.ts` (mount beside `/admin/rates`, `:642`); Test `api/src/routes/opsExperiences.test.ts` (pattern: `api/src/routes/hotZonesRoutes.test.ts` — `signSession` cookies, `sec-fetch-site` on writes).

| Route | Guard | Behaviour |
|---|---|---|
| `GET /admin/experiences` | `experiences:manage` | `{ experiences, stats }` |
| `POST /admin/experiences` | csrf + `experiences:manage` | create → 201; 400 `{error:'bad_request',issues}`; 409 `slug_taken` |
| `PATCH /admin/experiences/:id` | csrf + `experiences:manage` | partial → 200 / 400 / 404 / 409 |
| `GET /admin/experiences/leads?limit=` | `experiences:manage` | `{ leads }` (default 200, max 500) |
| `PATCH /admin/experiences/leads/:id` | csrf + `bookings:operate` | `{status?, opsNote?, paymentRef?, amountPaidCents?, amountPaidCurrency?}` → 200 / 400 / 404; `paid` without a ref (in the body or already stored) → 400 `{error:'paid_requires_ref'}` |

- [ ] **Step 1: Failing tests:** 401 without a session; finance 403 on the catalogue; ops can create; `createdBy` = identity email; cross-site write → 403 `bad_origin`; bad body → 400 with issues; duplicate slug → 409; partial PATCH leaves `radiusKm`/`photos`/`details` unchanged; lead → `paid` without a ref → 400, with one → 200; finance PATCHing a lead → 403.
- [ ] **Step 2: Run → FAIL. Step 3: Implement**

```ts
// api/src/routes/opsExperiences.ts
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware';
import { ExperienceInputSchema, type Experience } from '../experiences/experience';
import { SlugTakenError, type ExperienceRepo } from '../db/experienceRepo';
import type { ExperienceInterestRepo } from '../db/experienceInterestRepo';

// Ops Experiences page (spec 2026-10-06 D14/D15). Catalogue writes need experiences:manage
// (founder + ops: the price is display-only); moving a lead is booking work, so bookings:operate.
// .partial() wraps each field in ZodOptional, so an omitted field stays undefined and its default
// never fires — a PATCH changes only what it names.
const PatchExperience = ExperienceInputSchema.partial().strict();
const PatchLead = z.object({
  status: z.enum(['new', 'contacted', 'link_sent', 'paid', 'declined']).optional(),
  opsNote: z.string().trim().max(1000).nullable().optional(),
  paymentRef: z.string().trim().min(3).max(100).nullable().optional(),
  amountPaidCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  amountPaidCurrency: z.enum(['USD', 'LKR']).nullable().optional(),
}).strict();

const serialize = (e: Experience) => ({ ...e, createdAt: e.createdAt.toISOString(), updatedAt: e.updatedAt.toISOString() });

export function opsExperiencesRoutes(deps: {
  experiences: ExperienceRepo;
  interests: ExperienceInterestRepo;
  auth: OpsAuthConfig;
  allowedOrigins?: string[];
}) {
  const r = new Hono();
  // Same CSRF rule as /admin/rates (opsRates.ts): the ch_ops cookie is ambient browser state.
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
    const [list, stats] = await Promise.all([deps.experiences.list(), deps.interests.stats()]);
    return c.json({ experiences: list.map(serialize), stats });
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

  r.get('/leads', requireCap('experiences:manage'), async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 200, 1), 500);
    return c.json({ leads: await deps.interests.listLeads(limit) });
  });

  r.patch('/leads/:id', csrf, requireCap('bookings:operate'), async (c) => {
    const parsed = PatchLead.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
    const current = await deps.interests.get(c.req.param('id'));
    if (!current) return c.json({ error: 'not_found' }, 404);
    // A "paid" with no PayHere reference can't be reconciled (spec D5); the DB checks it too.
    const ref = parsed.data.paymentRef !== undefined ? parsed.data.paymentRef : current.paymentRef;
    if ((parsed.data.status ?? current.status) === 'paid' && !ref) return c.json({ error: 'paid_requires_ref' }, 400);
    const row = await deps.interests.patch(current.id, { ...parsed.data, updatedBy: c.get('identity').email });
    return row ? c.json({ lead: row }) : c.json({ error: 'not_found' }, 404);
  });

  return r;
}
```
- [ ] **Step 4: PASS → commit** `feat(api): ops experiences catalogue + leads`.

### Task 2.3: Public `GET /experiences/near`
**Files:** Create `api/src/routes/publicExperiences.ts`; Modify `api/src/app.ts` (mount `/experiences`; add `app.use('/experiences/*', rateLimit({ ...rl, methods: ['GET', 'HEAD'] }))` — `rateLimit` counts only POST unless told otherwise (`api/src/lib/rateLimit.ts:20-23`), and `/s/*` sets GET+HEAD for the same reason (`app.ts:394-396`)); Test `api/src/routes/publicExperiences.test.ts`.

**Contract:** `GET /experiences/near?at=Sigiriya@7.95,80.76` (1–8 `at`; label 1–60 chars; coordinates inside the Sri Lanka box) → `200 { stops: [{ place, items: [PublicExperience & { aboutKm: number }] }] }`, header `cache-control: public, max-age=300`. Missing, malformed or too many `at` → `400 {error:'bad_request'}`.

- [ ] **Step 1: Failing tests:** grouping and order; repeated GETs past the limit get a 429; `aboutKm` equals `aboutKm(distance)`; the raw response text contains no `partnerContact` value, no `"lat"`, no `createdBy`; 9 `at` → 400; malformed → 400; inactive excluded; cache header set; `Origin: https://ceylonhop.com` gets `access-control-allow-origin` (global CORS, `app.ts:373-387`).
- [ ] **Step 2: FAIL → Step 3: implement** (parse each `at` with `/^(.{1,60})@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/`; `matchExperiences(stops, await repo.listActive())`; items through `toPublicExperience` plus `aboutKm`) **→ Step 4: PASS → commit** `feat(api): public experiences-near endpoint`.

### Task 2.4: Sigiriya placeholders for staging (spec D20)

**Files:** Create `api/src/experiences/placeholders.ts` (`PLACEHOLDERS: ExperienceInput[]` + `placeholderSql(): string`), `api/scripts/experience-placeholders.sql` (generated, committed), Test `api/src/experiences/placeholders.test.ts`.

- [ ] **Failing test** — reads every catalogue place from `transfers-data.js` (`{ id: '…', name: '…', … lat: N, lng: N }` entries; ≥ 19 places; `sigiriya` = 7.95, 80.76) and asserts: exactly 3 placeholders, all valid `ExperienceInputSchema`, slugs `placeholder-*`, reach ≤ 10 km; all 3 match a Sigiriya drop-off; **none** matches any other catalogue place; the committed SQL equals `placeholderSql()`; the SQL contains `STAGING ONLY` and `ON CONFLICT ("slug") DO NOTHING` and no `delete|update|drop|alter|truncate`.
- [ ] **Implement** — the three mockup experiences: Ayurvedic massage (Atherya Spa, $35 pp, 90 min, daily, 09:00/11:00/14:00/16:00, pin 7.977, 80.76, reach 5, photo `guides/sigiriya/ayurveda`); Village cooking lesson (Suwee, $25 pp, 3 hrs, Mon–Sat, 10:00/16:00, pin 7.95, 80.796, reach 5, photos `guides/sigiriya/family-food`, `guides/sigiriya/village`); Elephant jeep safari (Sample jeep partner, $45 per group, 3–4 hrs, daily, 14:00, pin 7.92, 80.81, reach 10, photo `guides/sigiriya/elephants`). Details text starts "PLACEHOLDER for staging tests." `placeholderSql()` emits one header comment (STAGING ONLY, never prod, generated — don't hand-edit) and one `INSERT INTO "experiences" (…) VALUES … ON CONFLICT ("slug") DO NOTHING;` with `created_by = 'placeholder-seed'`. Generate the file with `npx tsx` and commit it.

**PR 2 gate** as PR 1. No migration; nothing customer-visible.

## Staging test plan

Staging (`staging.ceylonhop.com`, `ops.staging.ceylonhop.com`) deploys from `main` — every merged PR is testable there with no promote.

| After PR | On staging | Expect |
|---|---|---|
| 1 | — | Migration 0065 applied on boot |
| 2 | Seed: paste `api/scripts/experience-placeholders.sql` into the **staging** Supabase SQL Editor (or create the three through the ops page after PR 3) | 3 rows; re-run adds 0 |
| 3 | Ops → Experiences | The three placeholders; edit one; switch one off/on |
| 4 | Ops → Experiences → Leads | Empty until leads exist |
| 5 | Book CMB → Sigiriya, tap one, pay with a test card; then try CMB → Kandy and CMB → Ella | Sigiriya: 3 cards, lead in Leads + booking sheet. Kandy/Ella: **no** section |
| 6 | A staging quote to Sigiriya; tap one | Section on the quote; lead in Leads |

---

## PR 3 — Ops page: Catalogue tab

Branch: `feat/experiences-ops-catalogue`. File `api/src/routes/ops-ui.html` + e2e. **Starts with the planning pass** (read anchors on `origin/main`, write the DOM code into this task list).

**Behaviour (spec D14):**
- Nav entry **Experiences** shown when `caps.includes('experiences:manage')`; hash `#experiences`; wired exactly like `#rates` — `routeStateFromUrl` (`:2298`), `syncUrl` (`:2310`), `setNav`/`NAV_ICONS` (`:2441-2468`), the `render()` bounce (`:4190`), the dispatcher (`:4237-4245`), the nav click (`:4288-4296`).
- Catalogue list: thumb (first photo `small`), name, partner, area, `$35 pp`, reach, days ("Daily" / "Closed Sun"), active toggle, stats (interested · paid · paid amount).
- Form: every `ExperienceInput` field. Weekdays as 7 checkboxes (Sun…Sat). Start times as a comma list. Up to 6 photo stems, each with a preview from `photoUrls(stem).small` and, on image error, "Not live yet — photos appear after the site promote" (spec D8). Price typed in dollars, sent as cents (`Math.round(d*100)`).
- **Location box:** accepts `7.977, 80.76` or a Google Maps URL (`/@lat,lng,` or `?q=lat,lng`), parsed by a named `parseLatLng(text)` → `{lat,lng}|null`; inline error when null or outside Sri Lanka; "Open in Google Maps" check link.
- Save → POST/PATCH; 400 issues mapped to fields; 409 → "That slug is taken".
- Every `await` guarded by a sequence counter (`var seq=++_expSeq; … if (seq!==_expSeq) return;`) — the `_openSeq` idiom (`:6218`, `:6298-6300`).
- The page renders inside the QuoteView module, as Rates does (`showRates`/`hideRates` are exported from QuoteView; the dispatcher comment near `:4191`), so it uses QuoteView's `esc` (`:4806`). Every value goes through it.

**Tasks:**
- [ ] 3.1 e2e first: `web-tests/e2e/ops-experiences-page.spec.js`, offline like `ops-rates-page.spec.js` (stubs at `:54-59`): nav shown for founder/ops caps, hidden for finance; create → row appears; "80.76, 7.977" shows the location error and sends nothing; a Maps URL fills lat/lng; toggling active sends `PATCH {active:false}`. Run → FAIL.
- [ ] 3.2 Routing + nav + list. 3.3 Form + `parseLatLng`. 3.4 Gates → commit → PR (rebase first; `ops-ui.html` is the hot file — merge smallest-first).

---

## PR 4 — Ops visibility: Leads tab, booking sheet, team email

Branch: `feat/experiences-ops-leads`. **Starts with the planning pass.**

- [ ] 4.1 **Leads tab** on `#experiences`: rows from `GET /admin/experiences/leads` — date, customer, contact, ref (booking → opens the existing booking sheet; quote → opens the quote), travel date, area, experience, quoted price, status `<select>` (new / contacted / link sent / paid / declined), payment ref + amount + currency (shown for link sent and paid), note (save on blur → PATCH). Choosing **paid** without a ref shows "Add the PayHere reference first" and sends nothing. e2e first (extend `ops-experiences-page.spec.js`), then implement.
- [ ] 4.2 **Booking sheet:** the ops booking detail route `GET /admin/ops/bookings/:id` (`api/src/routes/ops.ts:294`; `opsRoutes` is mounted at `/admin/ops`, `app.ts:590`) adds `experienceInterests` (from `listForBooking`, with each experience's area and name via `getMany`). Pass `experiences` and `experienceInterests` into the `opsRoutes(...)` call at `app.ts:590`. Failing API test first. Then `renderSheet()` (`ops-ui.html:3951`; body blocks `:4012-4045`) shows an "Interested in" block after Trip. This code is in the **dashboard script**, whose `esc` (`:2208`) doesn't escape `'` — double-quoted attributes only. The route's guard is `bookings:read`, which finance holds, so show the status control only when `caps.includes('bookings:operate')`.
- [ ] 4.3 **Team paid email:** `teamPaidEmail` (`api/src/services/opsNotifications.ts:342`) gains an "Interested in" row in its own `bookingFacts` (around `:271`) — **not** in the shared `factRows` — when the booking has interests; the webhook (`api/src/routes/webhooks.ts:438`) loads them with `listForBooking` inside a try/catch (failure → email without the row). Failing test asserting the row in HTML and text, and its absence when none; `emailBrand.test.ts` stays green. The team-email preview fixture (`api/src/routes/devEmails.ts:92`) gets one interest.
- [ ] 4.4 Gates → commit → PR.

---

## PR 5 — Booking page + customer email row

Branch: `feat/experiences-booking-page`. Files `booking.html`, `booking.js`, `api/src/routes/bookings.ts`, `api/src/services/notifications.ts`, `api/src/routes/webhooks.ts`, tests. **Starts with the planning pass.** Run `npm run stamp` after editing `booking.js` (enforced by `web-tests/unit/asset-versions.test.js` and CI `codegen-fresh`).

### Task 5.1: Server — accept `experienceIds`
**Files:** `api/src/routes/bookings.ts`, `api/src/app.ts` (pass `experiences`, `experienceInterests` into `bookingRoutes`); extend `api/src/routes/bookings.test.ts`.
- [ ] **Failing tests** (single, trip, shared): `experienceIds: [id]` creates one interest (`source:'booking_page'`, this booking, snapshot from the experience); unknown and inactive ids dropped and the booking still 201s; > 10 ids → first 10; a non-array → ignored (not 400); an interest repo that throws → still 201 and `console.error` called; replaying the idempotency key doesn't duplicate; **no label from the body is stored anywhere**.
- [ ] **Implement:**
```ts
// Partner experiences the customer tapped "I'm interested" on (spec 2026-10-06 D10/D11). Only
// uuids come from the browser — every label ops sees is the server's. Read off the raw body like
// customerNotes so the domain inputs (stable interfaces) don't change. Never a 400: a malformed
// list from an old cached page must not cost us a booking.
const MAX_EXPERIENCE_IDS = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function experienceIdsFrom(body: unknown): string[] {
  const raw = (body as { experienceIds?: unknown } | null)?.experienceIds;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x): x is string => typeof x === 'string' && UUID.test(x)))].slice(0, MAX_EXPERIENCE_IDS);
}

// Best-effort, after the booking exists — the flagForOps shape. A lead is never a reason to fail
// the booking the customer is about to pay for.
async function recordInterests(booking: Booking, ids: string[]): Promise<void> {
  if (!ids.length || !deps.experiences || !deps.experienceInterests) return;
  try {
    for (const experience of (await deps.experiences.getMany(ids)).filter((e) => e.active)) {
      await deps.experienceInterests.record({ experience, source: 'booking_page', bookingId: booking.id });
    }
  } catch (err) {
    console.error(`experience interests failed for ${booking.reference}:`, err);
  }
}
```
`experienceIdsFrom` sits beside `customerNotesFrom` (module level, `bookings.ts:470-484`); `recordInterests` inside `bookingRoutes` beside `flagForOps` (`bookings.ts:402-411`). Call `await recordInterests(booking, experienceIdsFrom(body))` right before each mode's `return c.json(withCheckoutToken(booking), 201)` (single at `:608`; trip and shared at their equivalents). Deps type gains optional `experiences?: ExperienceRepo; experienceInterests?: ExperienceInterestRepo;` (unset → nothing recorded; existing tests unchanged).
- [ ] PASS → commit.

### Task 5.2: Page — section, toggle, payload
**Behaviour (spec D9, D10, D16, D17):**
- `booking.html`: `<div id="experiences-block" hidden></div>` after `#extras-block` (`:948-951`); card CSS from the approved mockup using existing tokens (`--line`, `--accent`, `--accent-rgb`, `--ok`, `--ok-bg`, `--ok-line`, `--btn-accent`, `--ink-soft`, `--pc-sky`); on phones the price/button row stacks under the description. A `#sum-experiences` box after the Total row inside `#summary` (which is also the mobile sheet).
- `booking.js`:
  - `state.experiences = new Map()` (id → `{name, partnerName}`) next to `state.addons` (`:288`).
  - `experienceStops()` per the spec D9 table; labels cut at " / "; coordinates rounded to 3 dp.
  - `syncExperiences()` from `render()` when step 3 shows: same `at=` query as last time → nothing; else fetch `${window.CEYLON_HOP_API}/experiences/near?…` (`credentials:'omit'`, 3 s `AbortController`; pattern `quote.html` `fetchJson` `:133-141`); error/timeout/empty → block stays `hidden`; a sequence number drops stale responses.
  - `renderExperiences(stops)`: per stop "While you're in {place}"; the D16 box once; cards with "about N km away" from `aboutKm`; every API string through `acEsc` (`booking.js:372`) — it doesn't escape `'`, so attribute values use double quotes only. Images `loading="lazy"`, `onerror` hides the img. Details & photos: an inline expandable panel (details, all photos with `srcset` small/large, "Open: Mon–Sat", "Times: 09:00 · 14:30").
  - `toggleExperience(btn)`: mirrors `toggleAddon` (`:1339-1347`) for the button state but **never touches pricing** — updates `state.experiences`, the button ("I'm interested" ↔ "✓ Interested"), the under-card note, `#sum-experiences`; `window.chTrack('experience_interest', {experience_slug, place, source:'booking_page', interested})` guarded like `:442`.
  - Payload (`createApiBooking` `:3087`, after the `customerNotes` line `:3209-3210`, all modes): `if (state.experiences.size) payload.experienceIds = [...state.experiences.keys()];`
- **Must not change:** totals, `calcTotal`, the estimate request, the pay button.
- [ ] 5.2.1 e2e first: `web-tests/e2e/booking-experiences.spec.js` with `gotoBooking` (`web-tests/e2e/_stubs.js:177`) and a `**/experiences/near*` route. Cases: private CMB→Sigiriya shows "While you're in Sigiriya" and 2 cards; a tap flips the button, shows "Noted — you won't be charged for this." and the summary box; **the Total text is identical before and after**; the `/bookings/single` body carries `experienceIds` and nothing else new; stub 500 → no visible block and the booking completes; trip `Sigiriya|Kandy` sends two `at=`; no button text contains "free". → FAIL.
- [ ] 5.2.2 Markup/CSS → 5.2.3 JS → `npm run stamp` → 5.2.4 browser-preview check at 375 px and desktop → gates → commit.

### Task 5.3: Customer confirmation email row
`sendBookingConfirmation` (`api/src/services/notifications.ts:622`; called from `api/src/routes/webhooks.ts:393`) receives the booking's interests (loaded in the webhook, try/catch → none) and adds "Interested in: {name} ({partner}), … — not charged; our Pro team will reach out" to **its own** rows when non-empty. **Do not touch the shared `factRows`** (`notifications.ts:214-261`): about a dozen templates reuse it (e.g. `:444`, `:608`, `:658`, `opsNotifications.ts:271`), and the line would leak into cancellation, refund and reminder emails. Preview fixtures `api/src/routes/devEmails.ts:74` and `:76` (the confirmation and its partial-trip variant) get one interest. Add a test that a cancellation email does **not** show the row.
- [ ] Failing tests (row in HTML and text; absent when none) → implement → gates → commit → PR.

---

## PR 6 — Quote page (gated)

Branch: `feat/experiences-quote-page`. **Starts with the gate, then the planning pass.**

### Gate 6.0: measure quote-stop coverage (the owner runs the read)
Prod reads need the owner's OK, so hand over this read-only SQL:
```sql
-- Driving-leg destinations on quotes from the last 90 days, by frequency.
-- Older rows keep legs at the top level (requestLegs(), api/src/db/quoteRouteText.ts:14-27).
SELECT leg->>'to' AS stop, count(*) AS n
FROM quotes q, jsonb_array_elements(coalesce(q.request_json->'tool'->'legs', q.request_json->'legs')) AS leg
WHERE q.created_at > now() - interval '90 days' AND q.deleted_at IS NULL
  AND coalesce(leg->>'category', 'transfer') <> 'stay_day'
GROUP BY 1 ORDER BY n DESC LIMIT 300;

SELECT canon_key FROM place_resolutions;
```
Then, locally, run each stop through `knownCoords` (`api/src/adapters/maps.ts:179`) and check `canonPlace(stop)` (`maps.ts:146`) against the `place_resolutions` keys. Report the **frequency-weighted share that resolves**.
- **≥ 60 %** (the owner may move the bar): build PR 6.
- **Lower:** the owner chose the full version (spec §7.2), so don't drop the quote page — first write and build its own small spec — store coordinates on each quote leg when ops picks a place (the ops tool already gets lat/lng candidates from `GET /admin/quote/place-candidates`, `api/src/routes/internalQuote.ts:750`) — then build PR 6 after it.

### Task 6.1: Stops for a quote + experiences in `/quote-view`
`api/src/experiences/quoteStops.ts` → `quoteStopPoints(request: unknown, placeResolutions: PlaceResolutionRepo): Promise<StopPoint[]>`: each driving leg's `to` in order (legs via `requestLegs()`, `api/src/db/quoteRouteText.ts:14-27`; stay legs skipped like `drives` in `customerQuoteView.ts:177`), de-duplicated by `canonPlace`; point = `knownCoords(name)` else `placeResolutions.get(canonPlace(name))`; unresolved skipped; labels cut at " / ".
- [ ] Failing unit tests (the airport origin is never a stop; `CMB → Sigiriya → Kandy` → `[Sigiriya, Kandy]`; a literal "7.9,80.7" resolves via `knownCoords`; unknown names skipped).
- [ ] Failing route tests (the existing quote-view test file): a live quote returns `view.experiences` with public fields only and `interested` flags from `listForQuote`; matcher throws → `experiences: []`, still 200; `booked`/`unavailable` carry none.
- [ ] Implement: optional deps `experiences`, `experienceInterests`, `placeResolutions` on `quoteViewRoutes` (mounted `api/src/app.ts:606`); compute after `customerQuoteView(...)` (`quoteView.ts:190-195`) inside try/catch; `customerQuoteView` stays pure and unchanged. Commit.

### Task 6.2: `POST /quote-view/interest`
Body `{ t, experienceId, interested }` strict. `verifyQuoteViewToken` (`api/src/lib/bookingToken.ts:208`); quote must be `ready`/`sent` and not deleted (as `quoteView.ts:186-188`) — **lapsed quotes are accepted** (spec D12); the experience must be in this quote's computed matches. `true` → `record({source:'quote_page', quoteId})`; `false` → `withdrawFromQuote`. Responses: `200 {interested}`; `400` bad body; `409 {error:'quote_unavailable'}`; `422 {error:'not_offered'}`. `app.use('/quote-view/*', rateLimit(rl))` (covers `/quote-view/interest`, not the GET). Rewrite the header comment at `quoteView.ts:12-13` to record the exception and why (spec D12).
- [ ] Failing tests for every response, a lapsed quote → 200, double-tap idempotency, and withdraw-after-`contacted` → `200 {interested:true}` → implement → commit.

### Task 6.3: Link quote interests at conversion
`linkQuoteToBooking(quote.id, booking.id)` in try/catch (log, never fail) at: the `from-quote-v2` route after `convert()` resolves (`api/src/routes/quoteConversion.ts:33`; the repo stays single-purpose), `api/src/routes/quotePay.ts` after `quotes.patch(…convertedBookingId)` (`:345`), and `api/src/routes/internalQuote.ts` after its patch (`:1157-1159`) and in the re-link branch (`:1094`).
- [ ] One failing test per path → implement → commit.

### Task 6.4: `quote.html` section
After the Day-by-day ticket (`quote.html:410-413`), before `pp-note`: same cards and copy as the booking page; initial state from `item.interested`; tap → POST with `t`, optimistic toggle, revert + "Couldn't save — try again" on failure; `track('experience_interest', {…, source:'quote_page'})` (`quote.html:103-105`). Every string through the page's `esc` (`quote.html:112`).
- [ ] e2e first: extend `web-tests/e2e/quote-page.spec.js` (`stubQuoteView`, `:72-79`) with `experiences` and a `**/quote-view/interest` route — renders after "Day by day"; tap POSTs and flips; 500 reverts with the retry line; `[]` renders nothing → implement → `npm run stamp` if needed → gates → commit → PR (body: "reverses the quote page's no-POST decision — spec D12").

---

## PR 7 — Experience confirmation email (spec D21)

Branch: `feat/experiences-confirmation-email`, stacked on PR 6. **Contains migration 0067. Release order: #930 → #940 → this PR.** If this merges before #940, re-stamp 0067's `when` or 0066 is skipped.

- [ ] **Migration** `0067_experience_confirmation` (journal idx 67, `when` 1791331200000 — later than #940's 0066 at 1791244800000): four nullable columns on `experience_interests` + the HH:MM and ≤ 200 CHECKs. Test reads the journal entry **by tag** (idx 66 comes from #940, so this branch has a gap).
- [ ] **Repo** (both implementations): `patch` takes `scheduledDate`/`scheduledTime`/`meetingPoint`; `markConfirmationSent(id, at)`; `listLeads` keeps a paid lead until its confirmation is sent.
- [ ] **Routes:** `PATCH /admin/experiences/leads/:id` accepts the three fields; `POST …/leads/:id/confirmation` (404 / 409 `not_paid` / 400 `schedule_required` / 422 `no_email` / 502 `send_failed`); the ops booking sheet payload carries the schedule and `confirmationSentAt`.
- [ ] **Email** `experienceConfirmedEmail()` in `notifications.ts` (HTML + text), dev preview `/dev/emails/experience-confirmed`.
- [ ] **Ops UI:** Leads tab schedule inputs + Send confirmation / Resend; booking sheet read-only lines. e2e in `ops-experiences-page.spec.js` and `ops-sheet-experience-interests.spec.js`.

---

## PR 8 — Live Tripadvisor ratings (spec D22)

Branch: `feat/experiences-tripadvisor`, stacked on PR 7. **Contains migration 0068. Release order: #930 → #940 → #950 → this PR.** Dormant until the owner sets `TRIPADVISOR_API_KEY` on Render (and Tripadvisor approves the account).

- [ ] **Migration** `0068_experience_tripadvisor` (journal idx 68, `when` 1791417600000 — later than #950's 0067 at 1791331200000): `experiences.tripadvisor_location_id` text + CHECK `^[0-9]{1,15}$` or null. Test reads the journal entry **by tag**.
- [ ] **Catalogue:** `ExperienceInput.tripadvisorLocationId` (digits only, nullable), both repos; the public projection is unchanged.
- [ ] **Adapter:** `TripadvisorAdapter` + `HttpTripadvisorAdapter` (2 s timeout, `Referer`, host-checked URLs, any failure -> null) + `NullTripadvisorAdapter` + `FakeTripadvisorAdapter`; config `TRIPADVISOR_API_KEY`, `TRIPADVISOR_REFERER`; wired in `server.ts` only when the key is set.
- [ ] **Route:** `GET /experiences/ratings?ids=` (<= 6 uuids, live and parallel, `no-store`, GET+HEAD rate limit; `{ ratings: [] }` with no DB read when dormant).
- [ ] **Pages:** `booking.js` + `quote.html` fetch once after the rows render and add the rating link under the meta line. Phones: Request >= 44px, "Details >" 32px tap area.
- [ ] **Ops form:** "Tripadvisor listing" field (paste address or bare number, inline error, "Open listing" link). e2e in `ops-experiences-page.spec.js`, `booking-experiences.spec.js`, `quote-page.spec.js`.

---

## Launch checklist (owner + ops)

- [ ] **L1** ~~Owner answers open items~~ — done 2026-10-06 (spec §7). Ops payment message template states: "Free cancellation up to 24 hours before the experience date."
- [ ] **L2** (deferred by the owner; do before the first real link) Test one PayHere portal link (small amount) and approve the read that checks `booking_checkout_event` for an `unknown_order` row (spec D13).
- [ ] **L3** Photos first: resize to `-1800`/`-900` (`sips -Z 900 x-1800.jpg --out x-900.jpg`), commit under `img/experiences/<slug>/`, credit photos that aren't our own in `credits.html`, **promote to `production`** — before ops enters the experience, or the previews show "not live yet".
- [ ] **L4** Owner approves the promote that carries migration 0065.
- [ ] **L5** Ops enters each experience **inactive**, checks the pin with "Open in Google Maps", then activates.
- [ ] **L6** Staging check: CMB → Sigiriya shows the section; tap; pay with a test card; the lead appears in ops Leads.
- [ ] **L7** Record the 14-day "before" numbers (spec D19) the day before go-live; check GTM forwards `experience_interest` if GA4 numbers are wanted.

## Self-review

- Spec coverage: D1 → 5.2.1 "total unchanged"; D2 → constraints; D3–D5 → 1.1, 1.4; D6–D7 → 1.2, 2.3; D8 → 1.2 `photoUrls`, 3 preview, L3; D9 → 5.2, 6.1, Gate 6.0; D10 → 5.1, 1.4 `listLeads`; D11 → 5.1 (ids only), 3/4 `esc`; D12 → 6.1–6.4; D13 → 2.2 payment fields, L2; D14 → 2.1–2.2, 3; D15 → 1.4 one query, 4; D16 → 5.2/6.4 copy asserts; D17 → 5.1, 5.2, 6.1 failure tests; D18 → no flag anywhere; D19 → L7.
- Names used across tasks are each defined once: `ExperienceRepo` (incl. `getMany`), `ExperienceInterestRepo` (`record`, `get`, `withdrawFromQuote`, `linkQuoteToBooking`, `listForBooking`, `listForQuote`, `listLeads`, `stats`, `patch`), `matchExperiences`, `StopPoint`, `toPublicExperience`, `photoUrls`, `aboutKm`, `quoteStopPoints`, `experienceIdsFrom`, `recordInterests`.
- Deliberate exception to "complete code in every step": PRs 3–6's DOM code, written in each PR's planning pass (reason at the top).
