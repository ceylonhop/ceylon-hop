# Ops Rates page — PR 2 (stored rate revisions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prices become founder-editable data. An append-only `rate_card_revisions` table holds
each saved rate set. `liveRateCard()` applies the newest one, and every server price reads it: ops,
web estimates, bookings and the ride board. The founder gets a read/save/preview API, and the site
gets a public live price list. **No UI in this PR** (PR 4). **With no revision saved, every price
is byte-identical to today.**

**Architecture:**
- **Rate model.** A pure module, `quote/rateRevision.ts`, defines the editable set (Zod), extracts
  it from the code card, applies it back, and prices the preview samples.
- **Store.** A repo (in-memory and Postgres, like `zonesRepo`) stores revisions with an optimistic
  `baseVersion` check and a unique `seq` race guard.
- **Live card.** `liveCard.ts` gains `currentRateCard(revisions)`, which is the code card plus the
  newest revision, and `liveRateCard(zones, revisions)` adds hot zones on top.
- **Routers.** Each router takes an optional `rateRevisions` dep, defaulting to an empty in-memory
  repo, the same pattern as `zones`. The new founder router is `/admin/rates`, and the public list
  is `GET /quote/pricing`.

**Tech Stack:** Node 20, TypeScript strict, Hono, Zod, Vitest, Drizzle + Postgres (hand-written
migration).

**Spec:** `docs/superpowers/specs/2026-09-26-ops-rates-page-design.md` §6–§8, §10 (PR 2), §11.

## Global Constraints

- **No price change until the first save.** With no revision, `liveRateCard()` deep-equals
  `{ ...RATE_CARD, hotZones }`, and the existing snapshots (`quote/__snapshots__/goldens.test.ts.snap`)
  stay unchanged.
- **Editable set (spec §6):**
  - per-km price and our per-km cost for car, van, van9, van14 and custom (> 0, ≤ 1000¢, ≤ 2 decimal places)
  - minimum fare per vehicle (whole ¢, > 0, ≤ 100000)
  - driver day rate and day cost (whole ¢, > 0, ≤ 100000)
  - the six add-ons (whole ¢, > 0, ≤ 50000)
  - buffer % (whole, 0–50)
  - FX (> 0, ≤ 1000, ≤ 2 decimal places)
- **Stays in code:** deposit % and cap (owner decision 7), seat and bag limits, idle-day km, price
  finishing, shared fees, currency, and `markupPct`.
- **Permissions:** reads need `margin:view`. Writes need the new founder-only `rates:manage`, plus
  CSRF (the same rule as `promoCodes.ts`).
- **Migration `0057_rate_card_revisions`** is hand-written, because `drizzle-kit generate` is
  broken here. It enables RLS and revokes from PUBLIC, anon and authenticated, like `0055`. Its
  journal `when` must exceed `0056`'s (`1790409600000`). Re-check that `0057` is still free before
  committing (`gh pr list` plus `git fetch && ls api/drizzle`).
- **Two deliberate deviations from spec §8.3:**
  - `quoteView.ts` is **unchanged**. It prices only won, ready and sent quotes
    (`quoteView.ts:170-198`), and every move to `ready` stamps a no-expiry snapshot
    (`internalQuote.ts:1590`). Its code-card fallback therefore only reaches pre-rate-lock legacy
    rows, and those were priced on the code card.
  - The `$0` draft shell's version stamp (`internalQuote.ts:866`) is **unchanged**. The shell is
    not priced, and the first save overwrites the stamp.
- **Evidence:** red first, then green (CLAUDE.md Hard rule 2). Run
  `cd api && npm run check` with
  `DATABASE_URL_TEST='postgresql://postgres:postgres@localhost:5432/ceylonhop_test'` and
  `npm run migrate:test` first. Read the real exit code, never a piped tail.
- **Workspace:** the worktree
  `/private/tmp/claude-501/-Users-roshenw-claude-code-ceylon-hop/6f800f3b-5474-4fa1-b29e-e12f376cd3e6/scratchpad/wt-rates2`,
  branch `feat/rate-card-revisions`. Stage files by path.

---

### Task 1: The editable rate set (`quote/rateRevision.ts`)

**Files:**
- Create: `api/src/quote/rateRevision.ts`
- Test: `api/src/quote/rateRevision.test.ts`

**Interfaces — Produces:**
- `type RateInputs = z.infer<typeof rateInputsSchema>`, with fields `perKmCents`, `costPerKmCents` and `floorCents` (each a `Record<Vehicle, number>`), `dayRateCents`, `dayRateCostCents`, `extrasCents` (`Record<ExtraCode, number>`), `bufferPct` and `fxUsdToLkr`.
- `rateInputsSchema` (Zod, strict).
- `ratesFromCard(card: RateCard): RateInputs`
- `applyRates(base: RateCard, rates: RateInputs, version: string): RateCard`
- `readStoredRates(stored: unknown, defaults: RateInputs): RateInputs`
- `revisionVersion(savedAt: Date, seq: number): string`
- `previewSamples(current: RateCard, proposed: RateCard): { label: string; currentCents: number; proposedCents: number }[]`

- [ ] **Step 1: Write the failing tests** — `api/src/quote/rateRevision.test.ts`:

```ts
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
    const { bufferPct: _dropped, ...older } = DEFAULTS;
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd api && npx vitest run src/quote/rateRevision.test.ts; echo "exit=$?"`
Expected: FAIL, "Failed to resolve import ./rateRevision". Exit ≠ 0.

- [ ] **Step 3: Implement** — `api/src/quote/rateRevision.ts`:

```ts
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
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd api && npx vitest run src/quote/rateRevision.test.ts; echo "exit=$?"`
Expected: every test passes, `exit=0`.

If the "ignores hot zones" test fails on a zone match, check the engine: `winningZoneForStops`
matches whole tokens, so "Sample B" can only match a zone named exactly that. A `noZones()` copy
must override it.

- [ ] **Step 5: Commit**

```bash
git add api/src/quote/rateRevision.ts api/src/quote/rateRevision.test.ts
git commit -m "feat(pricing): the founder-editable rate set — schema, apply, preview samples

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The revision store (table, in-memory and Postgres repos)

**Files:**
- Create: `api/drizzle/0057_rate_card_revisions.sql`
- Modify: `api/drizzle/meta/_journal.json` (append idx 57)
- Modify: `api/src/db/schema.ts` (add `rateCardRevisions` after `pricingZones`)
- Create: `api/src/db/rateRevisionRepo.ts`, `api/src/db/postgresRateRevisionRepo.ts`
- Test: `api/src/db/rateRevisionRepo.test.ts`, `api/src/db/postgresRateRevisionRepo.test.ts`

**Interfaces:**
- Consumes: `RateInputs`, `revisionVersion`, `ratesFromCard` and `readStoredRates` (Task 1), and
  `pgUniqueViolation` (`db/postgresBookingRepo.ts:40`).
- Produces:
  - `interface RateRevision { id: string; seq: number; version: string; rates: RateInputs; revertedToVersion: string | null; createdBy: string; createdAt: Date }`
  - `interface NewRateRevision { rates: RateInputs; baseVersion: string | null; revertedToVersion?: string | null; createdBy: string }`
  - `class StaleRatesError extends Error { current: RateRevision | null }`
  - `interface RateRevisionRepo { latest(): Promise<RateRevision | null>; list(): Promise<RateRevision[]>; create(r: NewRateRevision, now?: Date): Promise<RateRevision> }`, where `list()` is newest first
  - `InMemoryRateRevisionRepo` and `PostgresRateRevisionRepo(db)`

- [ ] **Step 1: Write the failing tests**

`api/src/db/rateRevisionRepo.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryRateRevisionRepo, StaleRatesError } from './rateRevisionRepo';
import { ratesFromCard } from '../quote/rateRevision';
import { RATE_CARD } from '../quote/rateCard';

const RATES = ratesFromCard(RATE_CARD);

describe('InMemoryRateRevisionRepo', () => {
  it('starts empty: no latest, no history', async () => {
    const repo = new InMemoryRateRevisionRepo();
    expect(await repo.latest()).toBeNull();
    expect(await repo.list()).toEqual([]);
  });

  it('appends: each save is a new numbered row, the newest is latest, history is newest first', async () => {
    const repo = new InMemoryRateRevisionRepo();
    const a = await repo.create({ rates: RATES, baseVersion: null, createdBy: 'f@x.com' }, new Date('2026-09-27T08:00:00Z'));
    const b = await repo.create({ rates: { ...RATES, bufferPct: 12 }, baseVersion: a.version, createdBy: 'f@x.com' }, new Date('2026-09-28T08:00:00Z'));
    expect([a.seq, a.version, b.seq, b.version]).toEqual([1, '2026-09-27.1', 2, '2026-09-28.2']);
    expect(await repo.latest()).toEqual(b);
    expect((await repo.list()).map((r) => r.version)).toEqual(['2026-09-28.2', '2026-09-27.1']);
    expect(a.revertedToVersion).toBeNull();
  });

  it('refuses a save from a stale base and names what is current', async () => {
    const repo = new InMemoryRateRevisionRepo();
    const a = await repo.create({ rates: RATES, baseVersion: null, createdBy: 'f@x.com' });
    const err = await repo.create({ rates: RATES, baseVersion: null, createdBy: 'f@x.com' }).catch((e) => e);
    expect(err).toBeInstanceOf(StaleRatesError);
    expect((err as StaleRatesError).current?.id).toBe(a.id);
  });

  it('keeps its own copy of the rates', async () => {
    const repo = new InMemoryRateRevisionRepo();
    const rates = ratesFromCard(RATE_CARD);
    await repo.create({ rates, baseVersion: null, createdBy: 'f@x.com' });
    rates.perKmCents.car = 1;
    expect((await repo.latest())!.rates.perKmCents.car).toBe(40.25);
  });
});
```

`api/src/db/postgresRateRevisionRepo.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Sql } from './client';
import { PostgresRateRevisionRepo } from './postgresRateRevisionRepo';
import { StaleRatesError } from './rateRevisionRepo';
import { ratesFromCard } from '../quote/rateRevision';
import { RATE_CARD } from '../quote/rateCard';

const TEST_URL = process.env.DATABASE_URL_TEST;
const RATES = ratesFromCard(RATE_CARD);

// The in-memory repo backs every route test; only a real Postgres proves the migration, the jsonb
// round trip of fractional per-km cents, and the unique-seq race guard.
describe.skipIf(!TEST_URL)('PostgresRateRevisionRepo (integration)', () => {
  let repo: PostgresRateRevisionRepo;
  let sql: Sql;
  const marker = `rates-it-${Date.now()}@e2e.test`;

  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    sql = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    repo = new PostgresRateRevisionRepo(conn.db);
  });
  // The shared test DB outlives a run: leave no revision behind for the next one.
  afterAll(async () => {
    await sql`DELETE FROM rate_card_revisions WHERE created_by = ${marker}`;
  });

  it('appends numbered rows and reads the newest back exactly', async () => {
    const base = (await repo.latest())?.version ?? null;
    const a = await repo.create({ rates: RATES, baseVersion: base, createdBy: marker }, new Date('2026-09-27T08:00:00Z'));
    const b = await repo.create(
      { rates: { ...RATES, bufferPct: 12 }, baseVersion: a.version, revertedToVersion: '2026-07-14', createdBy: marker },
      new Date('2026-09-27T09:00:00Z'),
    );
    expect(b.seq).toBe(a.seq + 1);
    expect(b.version).toBe(`2026-09-27.${b.seq}`);
    const latest = await repo.latest();
    expect(latest).toMatchObject({ id: b.id, createdBy: marker, revertedToVersion: '2026-07-14' });
    expect(latest!.rates.bufferPct).toBe(12);
    expect(latest!.rates.perKmCents).toEqual(RATES.perKmCents); // 40.25, 54.05 … survive jsonb
    expect(latest!.createdAt.toISOString()).toBe('2026-09-27T09:00:00.000Z');
    expect((await repo.list()).slice(0, 2).map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it('refuses a stale base, and lets exactly one of two racing saves land', async () => {
    const base = (await repo.latest())?.version ?? null;
    await expect(repo.create({ rates: RATES, baseVersion: 'not-the-latest', createdBy: marker }))
      .rejects.toBeInstanceOf(StaleRatesError);
    const results = await Promise.allSettled([
      repo.create({ rates: RATES, baseVersion: base, createdBy: marker }),
      repo.create({ rates: RATES, baseVersion: base, createdBy: marker }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(StaleRatesError);
  });
});
```

- [ ] **Step 2: Run both and watch them fail**

Run: `cd api && DATABASE_URL_TEST='postgresql://postgres:postgres@localhost:5432/ceylonhop_test' npx vitest run src/db/rateRevisionRepo.test.ts src/db/postgresRateRevisionRepo.test.ts; echo "exit=$?"`
Expected: FAIL. Both files fail to resolve their repo import. Exit ≠ 0.

- [ ] **Step 3: Migration, journal and schema**

`api/drizzle/0057_rate_card_revisions.sql`:

```sql
-- Founder-set rate revisions (spec docs/superpowers/specs/2026-09-26-ops-rates-page-design.md §8.1).
-- Append-only: each save from the ops Rates page adds a row, and the newest (highest seq) is the
-- live rate card's editable set. rateCard.ts holds the defaults until the first save, so an empty
-- table is today's prices exactly. seq is UNIQUE so two saves racing from the same base cannot both
-- land; the API turns the loser into a 409.
CREATE TABLE IF NOT EXISTS "rate_card_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "seq" integer NOT NULL,
  "version" text NOT NULL,
  "rates" jsonb NOT NULL,
  "reverted_to_version" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "rate_card_revisions_seq_unique" UNIQUE("seq"),
  CONSTRAINT "rate_card_revisions_version_unique" UNIQUE("version")
);

-- 0048 enabled RLS on every table that existed then; a newer table must protect itself. No policy:
-- the rows carry our costs, which no PostgREST-facing role may read. The API connects as postgres,
-- which bypasses RLS.
ALTER TABLE "rate_card_revisions" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "rate_card_revisions" FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE rate_card_revisions FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE rate_card_revisions FROM authenticated';
  END IF;
END $$;
```

In `api/drizzle/meta/_journal.json`, append after the `0056_payment_event_idempotency` entry. Add
a comma after its closing `}`, then add:

```json
    {
      "idx": 57,
      "version": "7",
      "when": 1790496000000,
      "tag": "0057_rate_card_revisions",
      "breakpoints": true
    }
```

In `api/src/db/schema.ts`, directly after the `pricingZones` table, add:

```ts
// Founder-set rate revisions (spec 2026-09-26 §8.1; migration 0057). Append-only: the newest row
// (highest seq) is the live rate card's editable set — see quote/liveCard.ts. seq is unique so two
// saves racing from the same base cannot both land.
export const rateCardRevisions = pgTable('rate_card_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  seq: integer('seq').notNull().unique(),
  version: text('version').notNull().unique(),
  rates: jsonb('rates').notNull(),
  revertedToVersion: text('reverted_to_version'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
```

- [ ] **Step 4: The repos**

`api/src/db/rateRevisionRepo.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { revisionVersion, type RateInputs } from '../quote/rateRevision';

// One saved rate set (spec 2026-09-26 §8.1). Append-only: a change or a revert is a NEW row, so the
// history of who set which prices, and when, is never rewritten.
export interface RateRevision {
  id: string;
  seq: number;
  version: string;
  rates: RateInputs;
  revertedToVersion: string | null;
  createdBy: string;
  createdAt: Date;
}

export interface NewRateRevision {
  rates: RateInputs;
  // The version the editor opened (null = no revision yet, i.e. the code defaults). A save is
  // refused when a newer revision exists, so two editors can never silently overwrite each other.
  baseVersion: string | null;
  revertedToVersion?: string | null;
  createdBy: string;
}

export class StaleRatesError extends Error {
  constructor(readonly current: RateRevision | null) {
    super('stale_rates');
    this.name = 'StaleRatesError';
  }
}

export interface RateRevisionRepo {
  latest(): Promise<RateRevision | null>;
  list(): Promise<RateRevision[]>; // newest first
  create(r: NewRateRevision, now?: Date): Promise<RateRevision>;
}

export class InMemoryRateRevisionRepo implements RateRevisionRepo {
  private rows: RateRevision[] = [];

  async latest(): Promise<RateRevision | null> {
    return this.rows[this.rows.length - 1] ?? null;
  }

  async list(): Promise<RateRevision[]> {
    return [...this.rows].reverse();
  }

  async create(r: NewRateRevision, now: Date = new Date()): Promise<RateRevision> {
    const latest = await this.latest();
    if ((latest?.version ?? null) !== r.baseVersion) throw new StaleRatesError(latest);
    const seq = (latest?.seq ?? 0) + 1;
    const row: RateRevision = {
      id: randomUUID(),
      seq,
      version: revisionVersion(now, seq),
      rates: structuredClone(r.rates),
      revertedToVersion: r.revertedToVersion ?? null,
      createdBy: r.createdBy,
      createdAt: now,
    };
    this.rows.push(row);
    return row;
  }
}
```

`api/src/db/postgresRateRevisionRepo.ts`:

```ts
import { desc } from 'drizzle-orm';
import type { Db } from './client';
import { rateCardRevisions } from './schema';
import { pgUniqueViolation } from './postgresBookingRepo';
import { RATE_CARD } from '../quote/rateCard';
import { ratesFromCard, readStoredRates, revisionVersion } from '../quote/rateRevision';
import { StaleRatesError, type NewRateRevision, type RateRevision, type RateRevisionRepo } from './rateRevisionRepo';

type Row = typeof rateCardRevisions.$inferSelect;
const DEFAULTS = ratesFromCard(RATE_CARD);

function toRevision(r: Row): RateRevision {
  return {
    id: r.id,
    seq: r.seq,
    version: r.version,
    rates: readStoredRates(r.rates, DEFAULTS),
    revertedToVersion: r.revertedToVersion,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}

export class PostgresRateRevisionRepo implements RateRevisionRepo {
  constructor(private readonly db: Db) {}

  async latest(): Promise<RateRevision | null> {
    const rows = await this.db.select().from(rateCardRevisions).orderBy(desc(rateCardRevisions.seq)).limit(1);
    return rows[0] ? toRevision(rows[0]) : null;
  }

  async list(): Promise<RateRevision[]> {
    const rows = await this.db.select().from(rateCardRevisions).orderBy(desc(rateCardRevisions.seq));
    return rows.map(toRevision);
  }

  async create(r: NewRateRevision, now: Date = new Date()): Promise<RateRevision> {
    const latest = await this.latest();
    if ((latest?.version ?? null) !== r.baseVersion) throw new StaleRatesError(latest);
    const seq = (latest?.seq ?? 0) + 1;
    try {
      const rows = await this.db
        .insert(rateCardRevisions)
        .values({
          seq,
          version: revisionVersion(now, seq),
          rates: r.rates,
          revertedToVersion: r.revertedToVersion ?? null,
          createdBy: r.createdBy,
          createdAt: now,
        })
        .returning();
      return toRevision(rows[0]);
    } catch (e) {
      // Two saves raced from the same base: the unique seq lets exactly one in.
      if (pgUniqueViolation(e)) throw new StaleRatesError(await this.latest());
      throw e;
    }
  }
}
```

- [ ] **Step 5: Migrate the local test DB, then run both and watch them pass**

Run: `cd api && export DATABASE_URL_TEST='postgresql://postgres:postgres@localhost:5432/ceylonhop_test' && npm run migrate:test && npx vitest run src/db/rateRevisionRepo.test.ts src/db/postgresRateRevisionRepo.test.ts src/db/rlsEnabled.test.ts; echo "exit=$?"`
Expected: all pass, including `rlsEnabled` (the new table has RLS), `exit=0`.

The shared local test DB is at 0056. Migrating it to 0057 affects other sessions' branches only by
adding an unused table. Note this in the PR.

- [ ] **Step 6: Commit**

```bash
git add api/drizzle/0057_rate_card_revisions.sql api/drizzle/meta/_journal.json api/src/db/schema.ts \
  api/src/db/rateRevisionRepo.ts api/src/db/postgresRateRevisionRepo.ts \
  api/src/db/rateRevisionRepo.test.ts api/src/db/postgresRateRevisionRepo.test.ts
git commit -m "feat(db): rate_card_revisions — append-only founder rate revisions (migration 0057)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The live card applies the newest revision, everywhere

**Files:**
- Modify: `api/src/quote/liveCard.ts`, `api/src/quote/liveCard.test.ts`
- Modify: `api/src/routes/quote.ts:149-163`, `api/src/routes/internalQuote.ts` (`:337-340`, `:421-431`, `:449-483`, `:513-534`, `:540-568`, `:629-696`, `:831-842`, `:934-943`, `:1393-1404`, `:1483`), `api/src/routes/bookings.ts:230,252,339`, `api/src/routes/rideBoard.ts` (`RideBoardDeps`, `:553`)
- Modify: `api/src/app.ts` (`AppDeps`, `:202`, router calls), `api/src/server.ts:154`, `api/scripts/pricing-health.ts:40-45,95`
- Test: `api/src/routes/rateRevisionPricing.test.ts` (new), plus one case in `api/src/routes/rideBoard.write.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: `currentRateCard(revisions: RateRevisionRepo): Promise<RateCard>` and
  `liveRateCard(zones: ZonesRepo, revisions: RateRevisionRepo): Promise<RateCard>`. The second
  argument is now required, and the old `base` parameter is gone.
- Produces: `AppDeps.rateRevisions?: RateRevisionRepo`, and a `rateRevisions?` dep on
  `quoteRoutes`, `internalQuoteRoutes`, `bookingRoutes` and `RideBoardDeps`.

- [ ] **Step 1: Write the failing tests**

In `api/src/quote/liveCard.test.ts`, change every `liveRateCard(x)` call to
`liveRateCard(x, new InMemoryRateRevisionRepo())`. Import `InMemoryRateRevisionRepo` from
`'../db/rateRevisionRepo'`. Then add:

```ts
describe('liveRateCard with founder revisions (spec 2026-09-26 §8.2)', () => {
  it('no revision ⇒ the code card exactly, plus zones', async () => {
    const card = await liveRateCard(new InMemoryZonesRepo(), new InMemoryRateRevisionRepo());
    expect(card).toEqual({ ...RATE_CARD, hotZones: [] });
  });

  it('the newest revision replaces the editable set and names the version; zones still ride on top', async () => {
    const revisions = new InMemoryRateRevisionRepo();
    const rates = ratesFromCard(RATE_CARD);
    const a = await revisions.create({ rates: { ...rates, bufferPct: 11 }, baseVersion: null, createdBy: 'f@x.com' }, new Date('2026-09-27T08:00:00Z'));
    await revisions.create({ rates: { ...rates, perKmCents: { ...rates.perKmCents, car: 45 } }, baseVersion: a.version, createdBy: 'f@x.com' }, new Date('2026-09-27T09:00:00Z'));
    const card = await liveRateCard(await zonesWith({ placeName: 'Ella', boostPct: 15 }), revisions);
    expect(card.version).toBe('2026-09-27.2');
    expect(card.perKmCents.car).toBe(45);
    expect(card.bufferPct).toBe(RATE_CARD.bufferPct); // the newest row is the whole set, not a delta
    expect(card.hotZones).toHaveLength(1);
    expect(await currentRateCard(revisions)).toEqual(applyRates(RATE_CARD, (await revisions.latest())!.rates, '2026-09-27.2'));
  });
});
```

Add the imports: `currentRateCard` from `'./liveCard'`, and `ratesFromCard`/`applyRates` from
`'./rateRevision'`.

Create `api/src/routes/rateRevisionPricing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createApp, type AppDeps } from '../app';
import { InMemoryRateRevisionRepo } from '../db/rateRevisionRepo';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { ratesFromCard } from '../quote/rateRevision';
import { RATE_CARD } from '../quote/rateCard';
import { signSession } from '../lib/opsAuth';

// Spec 2026-09-26 §8.3: once the founder saves a revision, every server price reads it. Each case
// saves one revision straight into the repo (the API that does this in production is Task 4) and
// checks one call site against the same request with no revision.
const AUTH = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };
const FOUNDER = `ch_ops=${signSession({ email: 'f@x.com', exp: Date.now() + 60_000 }, AUTH.opsSessionSecret)}`;
const app = (deps: AppDeps = {}) => createApp({ auth: AUTH, adminApiKey: 'k', ...deps });
const post = (a: ReturnType<typeof app>, path: string, body: unknown) =>
  a.request(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: FOUNDER }, body: JSON.stringify(body) });
const patch = (a: ReturnType<typeof app>, path: string, body: unknown) =>
  a.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: FOUNDER }, body: JSON.stringify(body) });
const get = (a: ReturnType<typeof app>, path: string) => a.request(path, { headers: { cookie: FOUNDER } });

const TRIP = { service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 1, requestedService: 'private', legs: [{ category: 'transfer', from: 'Kandy', to: 'Galle', distanceKm: 200 }] };

async function withRevision(patchRates: Partial<ReturnType<typeof ratesFromCard>>) {
  const revisions = new InMemoryRateRevisionRepo();
  const rev = await revisions.create({ rates: { ...ratesFromCard(RATE_CARD), ...patchRates }, baseVersion: null, createdBy: 'f@x.com' });
  return { revisions, rev };
}
const doubleCar = () => ({ perKmCents: { ...ratesFromCard(RATE_CARD).perKmCents, car: 80.5 } });

describe('a saved revision reaches every server price', () => {
  it('ops estimate: the new per-km price, and LKR at the revision\'s FX', async () => {
    const before = await (await post(app(), '/admin/quote/estimate', TRIP)).json();
    const { revisions } = await withRevision({ ...doubleCar(), fxUsdToLkr: 300 });
    const after = await (await post(app({ rateRevisions: revisions }), '/admin/quote/estimate', TRIP)).json();
    expect(after.total.cents).toBeGreaterThan(before.total.cents);
    expect(after.fxUsdToLkr).toBe(300);
    expect(after.total.lkrAmount).toBe(Math.round((after.total.cents * 300) / 100));
  });

  it('ops save stamps the revision\'s version, and approval freezes it against a later revision', async () => {
    const { revisions, rev } = await withRevision(doubleCar());
    const quotes = new InMemoryQuoteRepo();
    const a = app({ rateRevisions: revisions, quotes });
    const saved = await (await post(a, '/admin/quote/save', TRIP)).json();
    expect((await quotes.get(saved.id))!.rateCardVersion).toBe(rev.version);
    await patch(a, `/admin/quote/${saved.id}`, { status: 'pending_review' });
    await patch(a, `/admin/quote/${saved.id}`, { status: 'ready' });
    const approvedTotal = (await quotes.get(saved.id))!.totalCents;
    await revisions.create({ rates: { ...ratesFromCard(RATE_CARD), perKmCents: { ...ratesFromCard(RATE_CARD).perKmCents, car: 200 } }, baseVersion: rev.version, createdBy: 'f@x.com' });
    const reopened = await (await get(a, `/admin/quote/${saved.id}`)).json();
    expect(reopened.estimate.total.cents).toBe(approvedTotal); // the lock holds
  });

  it('reopening a draft prices it on the live card, not the code card', async () => {
    const quotes = new InMemoryQuoteRepo();
    const { revisions } = await withRevision(doubleCar());
    const a = app({ rateRevisions: revisions, quotes });
    const saved = await (await post(a, '/admin/quote/save', TRIP)).json();
    const reopened = await (await get(a, `/admin/quote/${saved.id}`)).json();
    const live = await (await post(a, '/admin/quote/estimate', TRIP)).json();
    expect(reopened.estimate.total.cents).toBe(live.total.cents);
  });

  it('the builder\'s rate card read shows the revision', async () => {
    const { revisions, rev } = await withRevision(doubleCar());
    const card = await (await get(app({ rateRevisions: revisions }), '/admin/quote/rate-card')).json();
    expect(card).toMatchObject({ version: rev.version, perKmCents: { car: 80.5 } });
    expect(card).not.toHaveProperty('costPerKmCents');
  });

  it('website estimate: POST /quote/v2/estimate (what route pages, search and booking call) prices on the revision', async () => {
    const V2_PRIVATE = { product: 'private', routeId: 'kandy-ella', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Ella' }], extras: [] };
    const send = (a: ReturnType<typeof app>) => a.request('/quote/v2/estimate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(V2_PRIVATE) });
    const before = await (await send(app({ quoteV2Enabled: true }))).json();
    const { revisions } = await withRevision(doubleCar());
    const after = await (await send(app({ quoteV2Enabled: true, rateRevisions: revisions }))).json();
    expect(after.totalCents).toBeGreaterThan(before.totalCents);
  });

  it('checkout: a website booking is charged at the revision', async () => {
    const booking = { from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2,
      customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' } };
    const send = (a: ReturnType<typeof app>) => a.request('/bookings/single', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(booking) });
    expect((await (await send(app())).json()).total).toBe(7800); // today's card (bookings.test.ts pins the same)
    const { revisions } = await withRevision(doubleCar());
    expect((await (await send(app({ rateRevisions: revisions }))).json()).total).toBeGreaterThan(7800);
  });

  it('a web quote still inside its 7-day lock keeps its price through a revision (story 9)', async () => {
    const quotes = new InMemoryQuoteRepo();
    const saved = await quotes.save({
      channel: 'web', product: 'private', totalCents: 0, currency: 'USD', rateCardVersion: 'frozen', request: {}, result: {},
      rateCardJson: { ...RATE_CARD, version: 'frozen', perKmCents: { ...RATE_CARD.perKmCents, car: 20 } },
      rateLockedUntil: new Date(Date.now() + 3 * 86_400_000),
    });
    const { revisions } = await withRevision(doubleCar());
    const booking = { from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2, quoteId: saved.id,
      customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' } };
    const res = await app({ quotes, rateRevisions: revisions }).request('/bookings/single', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(booking) });
    expect((await res.json()).total).toBe(3900); // the frozen 20¢/km card, as bookings.test.ts pins — not the revision
  });
});
```

Before relying on the `/admin/quote/:id` response key `estimate`, read the handler
(`internalQuote.ts` GET `/:id`) and adjust the assertion to the key it actually returns. Do not
change the handler. The v2 body and the booking body/totals are copied from `quote.test.ts:V2_PRIVATE`
and `bookings.test.ts:21,103-133`.

In `api/src/routes/rideBoard.write.test.ts`:
- Import `InMemoryRateRevisionRepo`, `type RateRevisionRepo` and `ratesFromCard`.
- Import `RATE_CARD` from `'../quote/rateCard'`.
- Widen `makeApp`'s `over` type with `rateRevisions?: RateRevisionRepo`.

Then add, next to `'still prices an off-catalogue leg off the road distance'`:

```ts
  it('prices an off-catalogue seat off the founder\'s saved van rate (spec 2026-09-26 §8.3)', async () => {
    const revisions = new InMemoryRateRevisionRepo();
    const rates = ratesFromCard(RATE_CARD);
    await revisions.create({ rates: { ...rates, perKmCents: { ...rates.perKmCents, van: 108.1 } }, baseVersion: null, createdBy: 'f@x.com' });
    const { app } = makeApp({}, { rateRevisions: revisions });
    const cookie = await loginCookie(app);
    const res = await app.request('/board', json(cookie, { payment: paymentDetails,
      from: 'Colombo Airport (CMB)', to: 'Kandy', date: '2999-08-08', slot: 'morning',
    }));
    expect(res.status).toBe(201);
    const card = { ...RATE_CARD, perKmCents: { ...RATE_CARD.perKmCents, van: 108.1 } };
    expect((await res.json()).list.seatPrice).toBe(seatPriceForDistance(113, card));
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd api && npx vitest run src/quote/liveCard.test.ts src/routes/rateRevisionPricing.test.ts src/routes/rideBoard.write.test.ts; echo "exit=$?"`
Expected: FAIL. `liveCard.test.ts` doesn't compile (`currentRateCard` is missing), and the
revision cases price at code rates. Exit ≠ 0.

- [ ] **Step 3: `liveCard.ts`**

Replace the whole file with:

```ts
import { RATE_CARD, type RateCard } from './rateCard';
import type { ZonesRepo } from '../db/zonesRepo';
import type { RateRevisionRepo } from '../db/rateRevisionRepo';
import { applyRates } from './rateRevision';

// The code card with the founder's newest saved revision applied (spec 2026-09-26 §8.2), without
// hot zones. No revision saved ⇒ exactly RATE_CARD. The ride board prices seats off this directly:
// shared rides never carry a zone boost (hot-zones spec D8).
export async function currentRateCard(revisions: RateRevisionRepo): Promise<RateCard> {
  const latest = await revisions.latest();
  return latest ? applyRates(RATE_CARD, latest.rates, latest.version) : RATE_CARD;
}

// The live rate card: the current card composed with the currently-active hot zones (hot-zones
// spec D5). Built per request so a founder rate or zone edit is reflected on the next quote. No
// revision and zero active zones (or HOT_ZONES_DISABLED) ⇒ pricing identical to RATE_CARD.
//
// This is the ONLY place a customer-facing or ops price acquires its rates and zone list. The
// engine does the matching and the boost; nothing else composes a card by hand.
export async function liveRateCard(zones: ZonesRepo, revisions: RateRevisionRepo): Promise<RateCard> {
  const [card, hotZones] = await Promise.all([currentRateCard(revisions), zones.activeZones()]);
  return { ...card, hotZones };
}
```

- [ ] **Step 4: Routers take the revisions repo**

**`quote.ts`:**
- Import `InMemoryRateRevisionRepo, type RateRevisionRepo` from `'../db/rateRevisionRepo'`.
- Add `rateRevisions?: RateRevisionRepo;` to the deps object, after `zones?: ZonesRepo;`.
- Replace the two lines:

```ts
  const zonesRepo = deps.zones ?? new InMemoryZonesRepo();
  const liveCard = (): Promise<RateCard> => liveRateCard(zonesRepo);
```

with:

```ts
  const zonesRepo = deps.zones ?? new InMemoryZonesRepo();
  // No revisions repo injected ⇒ an empty one ⇒ the code card (spec 2026-09-26 §8.2).
  const revisionsRepo = deps.rateRevisions ?? new InMemoryRateRevisionRepo();
  const liveCard = (): Promise<RateCard> => liveRateCard(zonesRepo, revisionsRepo);
```

**`bookings.ts`:**
- Same import.
- Add `rateRevisions?: RateRevisionRepo;` after `zones?: ZonesRepo;` (`:230`).
- After `const zonesRepo = deps.zones ?? new InMemoryZonesRepo();` (`:252`), add
  `const revisionsRepo = deps.rateRevisions ?? new InMemoryRateRevisionRepo();`.
- At `:339`, change `current = await liveRateCard(zonesRepo);` to
  `current = await liveRateCard(zonesRepo, revisionsRepo);`.
- In the comment above `bookingRateCard`, change "a pricing_zones lookup failure" to
  "a pricing_zones or rate_card_revisions lookup failure".

**`rideBoard.ts`:**
- Import `InMemoryRateRevisionRepo, type RateRevisionRepo` from `'../db/rateRevisionRepo'`, and
  `currentRateCard` from `'../quote/liveCard'`.
- Add to `RideBoardDeps`:

```ts
  // Founder rate revisions (spec 2026-09-26 §8.3): an off-catalogue seat is priced off the live van
  // rate. Unset → an empty repo → the code card, exactly as before.
  rateRevisions?: RateRevisionRepo;
```

- At the top of `rideBoardRoutes`, after `const r = new Hono();`, add
  `const revisionsRepo = deps.rateRevisions ?? new InMemoryRateRevisionRepo();`.
- Change `      seatPrice = seatPriceForDistance(distance.km);` to
  `      seatPrice = seatPriceForDistance(distance.km, await currentRateCard(revisionsRepo));`.

**`internalQuote.ts`:**

(a) Add the same import. Add `rateRevisions?: RateRevisionRepo;` to the deps, after the
`zones?: ZonesRepo;` line and its comment. Replace:

```ts
  const liveCard = (): Promise<RateCard> => liveRateCard(zonesRepo);
```

with:

```ts
  const revisionsRepo = deps.rateRevisions ?? new InMemoryRateRevisionRepo();
  const liveCard = (): Promise<RateCard> => liveRateCard(zonesRepo, revisionsRepo);
```

(b) FX follows the card that priced the quote. Replace:

```ts
const fxRate = RATE_CARD.fxUsdToLkr;
const toLkr = (cents: number): number => Math.round((cents * fxRate) / 100);
const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const lkr = (cents: number): string => `LKR ${toLkr(cents).toLocaleString('en-US')}`;
```

with:

```ts
// LKR is display-only and follows the FX of the card that priced the quote: the live card for an
// estimate, the locked snapshot for an approved one. FX is founder-set since spec 2026-09-26.
const toLkr = (cents: number, fx: number): number => Math.round((cents * fx) / 100);
const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const lkr = (cents: number, fx: number): string => `LKR ${toLkr(cents, fx).toLocaleString('en-US')}`;
```

Then thread `fx` through:
- `function money(cents: number, fx: number)` returns
  `{ cents, usd: usd(cents), lkr: lkr(cents, fx), lkrAmount: toLkr(cents, fx) }`.
- `function summary(result: QuoteResult, fx: number)` passes `fx` to its three `money()` calls.
- `function shape(result: QuoteResult, canMargin: boolean, fx: number)` passes `fx` to every
  `money(...)` and `lkr(...)` call in its body, including `lkr(li.amountCents, fx)` in the
  line-item map and both discount `money()` calls.
- `serviceChooserData` changes each `summary(x)` to `summary(x, rateCard.fxUsdToLkr)`. There are
  four calls.
- `lockedEstimate` gains a fourth parameter, `current: RateCard`. It calls
  `rateCardFor({ … }, now, current)` and `shape(result, canMargin, rateCard.fxUsdToLkr)`.
- In `POST /estimate`, change `...shape(result, canMargin),` to
  `...shape(result, canMargin, card.fxUsdToLkr),` and change `fxUsdToLkr: fxRate,` to
  `fxUsdToLkr: card.fxUsdToLkr,`.
- In `GET /:id`, change `lockedEstimate(q, canMargin, new Date())` to
  `lockedEstimate(q, canMargin, new Date(), await liveCard())`.

Run `grep -n "money(\|lkr(\|toLkr(\|shape(\|summary(" api/src/routes/internalQuote.ts`. Every call
must carry `fx` except the three helper definitions. TypeScript enforces this: a missing argument
fails typecheck.

(c) In the `/save` handler, change `rateCardVersion: RATE_CARD.version,` (the one next to
`marginCents: result.marginEstimateCents ?? null,`) to `rateCardVersion: result.rateCardVersion,`.
Leave the `/draft` shell stamp as it is (see Global Constraints).

(d) Replace the `GET /rate-card` handler with:

```ts
  // The live rate card for the tool: seat caps and add-on prices for everyone who quotes, and the
  // Rates page's read-only card. Sell prices only — costs and markup never leave through here.
  // MUST be registered before /:id so that /rate-card doesn't match the param route.
  r.get('/rate-card', async (c) => {
    const card = await liveCard();
    return c.json({
      version: card.version,
      perKmCents: card.perKmCents,
      floorCents: card.floorCents,
      chauffeurDayRateCents: card.chauffeur.dayRateCents,
      bufferPct: card.bufferPct,
      depositPct: card.deposit.pct,
      extras: card.extras,
      fxUsdToLkr: card.fxUsdToLkr,
      vehicle: card.vehicle, // V12: per-tier maxPax/maxBags caps for client-side vehicle labelling
    });
  });
```

If `RATE_CARD` is now unused in `internalQuote.ts`, keep only the imports that are still used. The
`/draft` shell still uses `RATE_CARD.currency` and `RATE_CARD.version`.

- [ ] **Step 5: Wire it in `app.ts` and `server.ts`**

In `app.ts`:
- Import `InMemoryRateRevisionRepo, type RateRevisionRepo` from `'./db/rateRevisionRepo'`.
- Add `rateRevisions?: RateRevisionRepo;` to `AppDeps` after `zones?: ZonesRepo;`.
- After `const zones = deps.zones ?? new InMemoryZonesRepo();`, add:

```ts
  // Founder rate revisions (spec 2026-09-26). One instance shared by every router that prices, so a
  // save is seen by all of them at once. Empty ⇒ the code card.
  const rateRevisions = deps.rateRevisions ?? new InMemoryRateRevisionRepo();
```

- Pass `rateRevisions` wherever `zones` is passed today: the bookings router (`:426`), `quoteRoutes`
  (`:486`) and `internalQuoteRoutes` (`:575`). Also pass it to `rideBoardRoutes({ … })`.

In `server.ts`:
- Import `PostgresRateRevisionRepo` from `'./db/postgresRateRevisionRepo'`.
- After `zones: new PostgresZonesRepo(db),`, add `rateRevisions: new PostgresRateRevisionRepo(db),`.
  Without this line prod falls back to an empty in-memory repo, and every founder save vanishes on
  restart.

- [ ] **Step 6: `scripts/pricing-health.ts`**

- Import `PostgresRateRevisionRepo` from `'../src/db/postgresRateRevisionRepo'`, and
  `InMemoryRateRevisionRepo, type RateRevisionRepo` from `'../src/db/rateRevisionRepo'`.
- After the `zonesRepo` line, add:
  `const revisionsRepo: RateRevisionRepo = databaseUrl ? new PostgresRateRevisionRepo(createDb(databaseUrl).db) : new InMemoryRateRevisionRepo();`
- Change `const rateCard = await liveRateCard(zonesRepo, RATE_CARD);` to
  `const rateCard = await liveRateCard(zonesRepo, revisionsRepo);`.
- Change `const expectedPerKm = RATE_CARD.perKmCents.car / 100;` to
  `const expectedPerKm = rateCard.perKmCents.car / 100;`.
- Drop the `RATE_CARD` import if nothing else uses it.

- [ ] **Step 7: Run and watch it pass, then the whole API suite**

Run: `cd api && npx vitest run src/quote/liveCard.test.ts src/routes/rateRevisionPricing.test.ts src/routes/rideBoard.write.test.ts src/quote/goldens.test.ts; echo "exit=$?"`
Expected: all pass, snapshots unchanged, `exit=0`.

Run: `cd api && npm run check; echo "exit=$?"` (with `DATABASE_URL_TEST` set; timeout 600000)
Expected: `exit=0`.

- [ ] **Step 8: Commit**

```bash
git add api/src/quote/liveCard.ts api/src/quote/liveCard.test.ts api/src/routes/quote.ts \
  api/src/routes/internalQuote.ts api/src/routes/bookings.ts api/src/routes/rideBoard.ts \
  api/src/app.ts api/src/server.ts api/scripts/pricing-health.ts \
  api/src/routes/rateRevisionPricing.test.ts api/src/routes/rideBoard.write.test.ts
git commit -m "feat(pricing): every server price reads the founder's newest rate revision

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The founder rates API (`/admin/rates`) and `rates:manage`

**Files:**
- Create: `api/src/routes/opsRates.ts`
- Modify: `api/src/lib/opsAuth.ts:4-7,27-28`, `api/src/app.ts` (mount after `/admin/promo-codes`)
- Test: `api/src/routes/opsRates.test.ts`, plus one case in `api/src/lib/opsAuth.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces the routes:
  - `GET /admin/rates` → `{ live, defaults, history, readOnly }`
  - `POST /admin/rates` → 201 `{ revision }` | 400 | 409 `{ error: 'stale_rates', current }`
  - `POST /admin/rates/preview` → `{ samples }`
- Serialised revision: `{ id, seq, version, rates, revertedToVersion, createdBy, createdAt: ISO string }`.

- [ ] **Step 1: Write the failing tests**

In `api/src/lib/opsAuth.test.ts`, add next to the analytics case:

```ts
  it('rates:manage is founder-only (spec 2026-09-26 Rates page)', () => {
    expect(can('founder', 'rates:manage')).toBe(true);
    for (const r of ['finance', 'ops', 'system'] as const) expect(can(r, 'rates:manage')).toBe(false);
  });
```

Create `api/src/routes/opsRates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createApp, type AppDeps } from '../app';
import { InMemoryRateRevisionRepo } from '../db/rateRevisionRepo';
import { ratesFromCard, PREVIEW_SAMPLES } from '../quote/rateRevision';
import { RATE_CARD } from '../quote/rateCard';
import { signSession } from '../lib/opsAuth';

const AUTH = { opsUsers: 'f@x.com:founder,op@x.com:ops,fin@x.com:finance', googleClientId: 'cid', opsSessionSecret: 'sek' };
const cookie = (email: string) => `ch_ops=${signSession({ email, exp: Date.now() + 60_000 }, AUTH.opsSessionSecret)}`;
const FOUNDER = cookie('f@x.com');
const OPS = cookie('op@x.com');
const FINANCE = cookie('fin@x.com');
const RATES = ratesFromCard(RATE_CARD);

function setup(deps: AppDeps = {}) {
  const rateRevisions = new InMemoryRateRevisionRepo();
  const a = createApp({ auth: AUTH, adminApiKey: 'k', allowedOrigins: ['https://ops.example'], rateRevisions, ...deps });
  const get = (ck = FOUNDER) => a.request('/admin/rates', { headers: { cookie: ck } });
  const post = (path: string, body: unknown, ck = FOUNDER, headers: Record<string, string> = {}) =>
    a.request(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck, ...headers }, body: JSON.stringify(body) });
  return { a, rateRevisions, get, post };
}

describe('GET /admin/rates', () => {
  it('shows the code defaults as live before anything is saved', async () => {
    const s = setup();
    const res = await s.get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.live).toEqual({ version: RATE_CARD.version, source: 'defaults', rates: RATES, createdBy: null, createdAt: null });
    expect(body.defaults).toEqual({ version: RATE_CARD.version, rates: RATES });
    expect(body.history).toEqual([]);
    expect(body.readOnly).toEqual({ depositPct: RATE_CARD.deposit.pct, depositCapCents: RATE_CARD.deposit.capCents });
  });

  it('is founder-only: ops and finance get 403, no session gets 401', async () => {
    const s = setup();
    expect((await s.get(OPS)).status).toBe(403);
    expect((await s.get(FINANCE)).status).toBe(403);
    expect((await s.a.request('/admin/rates')).status).toBe(401);
  });
});

describe('POST /admin/rates', () => {
  it('saves a revision stamped with the founder, which GET then shows as live and in history', async () => {
    const s = setup();
    const res = await s.post('/admin/rates', { baseVersion: null, rates: { ...RATES, bufferPct: 12 } });
    expect(res.status).toBe(201);
    const { revision } = await res.json();
    expect(revision).toMatchObject({ seq: 1, createdBy: 'f@x.com', revertedToVersion: null, rates: { bufferPct: 12 } });
    expect(typeof revision.createdAt).toBe('string');
    const body = await (await s.get()).json();
    expect(body.live).toMatchObject({ version: revision.version, source: 'revision', createdBy: 'f@x.com' });
    expect(body.history.map((h: { version: string }) => h.version)).toEqual([revision.version]);
  });

  it('rejects out-of-range or over-precise values with 400, and saves nothing', async () => {
    const s = setup();
    for (const rates of [
      { ...RATES, perKmCents: { ...RATES.perKmCents, car: 40.255 } },
      { ...RATES, bufferPct: 99 },
      { ...RATES, depositPct: 20 },
    ]) {
      const res = await s.post('/admin/rates', { baseVersion: null, rates });
      expect(res.status).toBe(400);
    }
    expect(await s.rateRevisions.list()).toEqual([]);
  });

  it('refuses a save from a stale version with 409 and names the current revision', async () => {
    const s = setup();
    const first = (await (await s.post('/admin/rates', { baseVersion: null, rates: RATES })).json()).revision;
    const res = await s.post('/admin/rates', { baseVersion: null, rates: { ...RATES, bufferPct: 12 } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'stale_rates', current: { version: first.version, createdBy: 'f@x.com' } });
  });

  it('ops and finance cannot save', async () => {
    const s = setup();
    expect((await s.post('/admin/rates', { baseVersion: null, rates: RATES }, OPS)).status).toBe(403);
    expect((await s.post('/admin/rates', { baseVersion: null, rates: RATES }, FINANCE)).status).toBe(403);
    expect(await s.rateRevisions.list()).toEqual([]);
  });

  it('a revert records what it restored, and must name a real version', async () => {
    const s = setup();
    const first = (await (await s.post('/admin/rates', { baseVersion: null, rates: { ...RATES, bufferPct: 12 } })).json()).revision;
    const bad = await s.post('/admin/rates', { baseVersion: first.version, rates: RATES, revertedToVersion: '1999-01-01.9' });
    expect(bad.status).toBe(400);
    const res = await s.post('/admin/rates', { baseVersion: first.version, rates: RATES, revertedToVersion: RATE_CARD.version });
    expect(res.status).toBe(201);
    expect((await res.json()).revision).toMatchObject({ seq: 2, revertedToVersion: RATE_CARD.version });
  });

  it('refuses a cross-site post (CSRF), like every other admin write', async () => {
    const s = setup();
    const res = await s.post('/admin/rates', { baseVersion: null, rates: RATES }, FOUNDER, { 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
  });
});

describe('POST /admin/rates/preview', () => {
  it('prices the four sample trips at the current and proposed rates, and saves nothing', async () => {
    const s = setup();
    const res = await s.post('/admin/rates/preview', { rates: { ...RATES, perKmCents: { ...RATES.perKmCents, car: 60 } } });
    expect(res.status).toBe(200);
    const { samples } = await res.json();
    expect(samples.map((x: { label: string }) => x.label)).toEqual(PREVIEW_SAMPLES.map((p) => p.label));
    const car150 = samples.find((x: { label: string }) => x.label === '150 km car transfer');
    expect(car150.proposedCents).toBeGreaterThan(car150.currentCents);
    expect(await s.rateRevisions.list()).toEqual([]);
  });

  it('is founder-only', async () => {
    const s = setup();
    expect((await s.post('/admin/rates/preview', { rates: RATES }, OPS)).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd api && npx vitest run src/routes/opsRates.test.ts src/lib/opsAuth.test.ts; echo "exit=$?"`
Expected: FAIL. `/admin/rates` returns 404, and `rates:manage` is not an `OpsAction`. Exit ≠ 0.

- [ ] **Step 3: Capability**

In `api/src/lib/opsAuth.ts`:
- Add `| 'rates:manage'` to the `OpsAction` union, after `'promo_codes:manage'`.
- Add `'rates:manage'` to the `founder` set.
- Add this comment to the capability block:

```ts
// rates:manage — saving the founder's rate revisions from the ops Rates page (spec 2026-09-26):
// every customer price moves with it. Founder only, the same class as promo_codes:manage.
// Reading the page stays margin:view (the card carries our costs).
```

- [ ] **Step 4: The router** — `api/src/routes/opsRates.ts`:

```ts
// Founder API for the ops Rates page (spec docs/superpowers/specs/2026-09-26-ops-rates-page-design.md
// §7, §8.4). Reads need margin:view (the set carries our costs); every write needs rates:manage +
// the same CSRF rule as the other admin writes. Saves are append-only revisions — see
// db/rateRevisionRepo.ts — and take effect on the very next price (quote/liveCard.ts).
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware';
import { StaleRatesError, type RateRevision, type RateRevisionRepo } from '../db/rateRevisionRepo';
import { RATE_CARD } from '../quote/rateCard';
import { applyRates, previewSamples, rateInputsSchema, ratesFromCard } from '../quote/rateRevision';
import { currentRateCard } from '../quote/liveCard';

const VERSION = z.string().trim().min(1).max(40);
const SaveSchema = z.object({
  baseVersion: VERSION.nullable(),
  rates: rateInputsSchema,
  revertedToVersion: VERSION.nullable().optional(),
}).strict();
const PreviewSchema = z.object({ rates: rateInputsSchema }).strict();

function serialize(r: RateRevision) {
  return {
    id: r.id,
    seq: r.seq,
    version: r.version,
    rates: r.rates,
    revertedToVersion: r.revertedToVersion,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  };
}

export function opsRatesRoutes(deps: {
  revisions: RateRevisionRepo;
  auth: OpsAuthConfig;
  allowedOrigins?: string[];
  now?: () => Date;
}) {
  const r = new Hono();
  const now = deps.now ?? (() => new Date());

  // Same CSRF rule as /admin/quote and /admin/promo-codes: the ch_ops cookie is ambient browser state.
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

  r.get('/', requireCap('margin:view'), async (c) => {
    const history = await deps.revisions.list();
    const latest = history[0] ?? null;
    const defaults = { version: RATE_CARD.version, rates: ratesFromCard(RATE_CARD) };
    return c.json({
      live: latest
        ? { version: latest.version, source: 'revision', rates: latest.rates, createdBy: latest.createdBy, createdAt: latest.createdAt.toISOString() }
        : { ...defaults, source: 'defaults', createdBy: null, createdAt: null },
      defaults,
      history: history.map(serialize),
      // Shown, never edited: no booking charges a deposit (engine.ts:171, owner decision 2026-09-26).
      readOnly: { depositPct: RATE_CARD.deposit.pct, depositCapCents: RATE_CARD.deposit.capCents },
    });
  });

  r.post('/', csrf, requireCap('rates:manage'), async (c) => {
    const parsed = SaveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
    const { baseVersion, rates, revertedToVersion } = parsed.data;
    // A revert is a label on a normal save — make sure it names something that exists.
    if (revertedToVersion && revertedToVersion !== RATE_CARD.version
      && !(await deps.revisions.list()).some((h) => h.version === revertedToVersion)) {
      return c.json({ error: 'bad_request', issues: [{ path: ['revertedToVersion'], message: 'unknown version' }] }, 400);
    }
    try {
      const revision = await deps.revisions.create(
        { rates, baseVersion, revertedToVersion: revertedToVersion ?? null, createdBy: c.get('identity').email },
        now(),
      );
      return c.json({ revision: serialize(revision) }, 201);
    } catch (e) {
      if (e instanceof StaleRatesError) {
        return c.json({ error: 'stale_rates', current: e.current ? serialize(e.current) : null }, 409);
      }
      throw e;
    }
  });

  r.post('/preview', csrf, requireCap('rates:manage'), async (c) => {
    const parsed = PreviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
    const current = await currentRateCard(deps.revisions);
    const proposed = applyRates(RATE_CARD, parsed.data.rates, 'preview');
    return c.json({ samples: previewSamples(current, proposed) });
  });

  return r;
}
```

In `app.ts`, import `opsRatesRoutes` from `'./routes/opsRates'`. Directly after the
`app.route('/admin/promo-codes', …)` call, add:

```ts
  // Founder rate revisions (spec 2026-09-26): read under margin:view, save under rates:manage.
  app.route('/admin/rates', opsRatesRoutes({ revisions: rateRevisions, auth: opsAuthCfg, allowedOrigins }));
```

Check that the variables are named `opsAuthCfg` and `allowedOrigins`, as used by the promo-codes
mount.

- [ ] **Step 5: Run and watch it pass**

Run: `cd api && npx vitest run src/routes/opsRates.test.ts src/lib/opsAuth.test.ts src/routes/ops.roles.test.ts; echo "exit=$?"`
Expected: all pass, `exit=0`. If `ops.roles.test.ts` pins whoami's caps for a founder, add
`'rates:manage'` there. That is the expected consequence of a new capability, not a regression.

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/opsRates.ts api/src/routes/opsRates.test.ts api/src/lib/opsAuth.ts \
  api/src/lib/opsAuth.test.ts api/src/app.ts
git commit -m "feat(ops): founder rates API — read, save (append-only, stale-safe), preview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Also add `api/src/routes/ops.roles.test.ts` if Step 5 changed it.)

---

### Task 5: The public live price list (`GET /quote/pricing`)

**Files:**
- Modify: `api/src/quote/pricingPayload.ts:40-65` (take a card), `api/src/routes/quote.ts` (new route)
- Test: `api/src/quote/pricingPayload.test.ts` (one case), `api/src/routes/quotePricing.test.ts` (new)

**Interfaces — Produces:** `buildPricingPayload(card: RateCard = RATE_CARD): PricingPayload`, and
`GET /quote/pricing` → `PricingPayload` with `cache-control: public, max-age=60`. PR 3's site
loader consumes it.

- [ ] **Step 1: Write the failing tests**

Add to `api/src/quote/pricingPayload.test.ts`:

```ts
  it('builds from a given card — the live one for GET /quote/pricing', () => {
    const card = { ...RATE_CARD, perKmCents: { ...RATE_CARD.perKmCents, car: 45 }, extras: { ...RATE_CARD.extras, waiting: 1200 } };
    const p = buildPricingPayload(card);
    expect(p.perKm.car).toBe(0.45);
    expect(p.extras.waiting).toBe(12);
    expect(p.seatPricing.perKmCentsVan).toBe(RATE_CARD.perKmCents.van);
  });
```

Import `RATE_CARD` from `'./rateCard'`.

Create `api/src/routes/quotePricing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryRateRevisionRepo } from '../db/rateRevisionRepo';
import { ratesFromCard } from '../quote/rateRevision';
import { buildPricingPayload } from '../quote/pricingPayload';
import { RATE_CARD } from '../quote/rateCard';

// The site's live price list (spec 2026-09-26 §8.4, consumed by transfers-data.js in PR 3).
describe('GET /quote/pricing', () => {
  it('with nothing saved, is exactly the list the site bakes in today', async () => {
    const res = await createApp().request('/quote/pricing');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await res.json()).toEqual(buildPricingPayload());
  });

  it('carries the founder\'s saved prices', async () => {
    const rateRevisions = new InMemoryRateRevisionRepo();
    const rates = ratesFromCard(RATE_CARD);
    await rateRevisions.create({ rates: { ...rates, perKmCents: { ...rates.perKmCents, car: 45 } }, baseVersion: null, createdBy: 'f@x.com' });
    const body = await (await createApp({ rateRevisions }).request('/quote/pricing')).json();
    expect(body.perKm.car).toBe(0.45);
  });

  it('never exposes costs or markup', async () => {
    const text = await (await createApp().request('/quote/pricing')).text();
    expect(text).not.toMatch(/cost|markup|margin/i);
  });

  it('answers the live site cross-origin', async () => {
    const res = await createApp({ allowedOrigins: ['https://ceylonhop.com'] }).request('/quote/pricing', { headers: { origin: 'https://ceylonhop.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://ceylonhop.com');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd api && npx vitest run src/quote/pricingPayload.test.ts src/routes/quotePricing.test.ts; echo "exit=$?"`
Expected: FAIL. `buildPricingPayload(card)` ignores its argument (car stays 0.4025), and
`/quote/pricing` returns 404. Exit ≠ 0.

- [ ] **Step 3: Implement**

In `pricingPayload.ts`:
- Import `type RateCard` alongside `RATE_CARD`.
- Change `export function buildPricingPayload(): PricingPayload {` to
  `export function buildPricingPayload(card: RateCard = RATE_CARD): PricingPayload {`.
- Inside it, replace every `RATE_CARD.` with `card.`. The `SHARED_PRODUCTS`/`DEFAULT_CORRIDORS`
  lines don't change.
- Replace the header comment's first line with:

```ts
// The canonical set of prices the static front-end is allowed to know. `tools/generate-pricing.mjs`
// dumps it from the CODE card (scripts/dump-pricing.ts) as the site's offline fallback, and
// GET /quote/pricing serves it from the LIVE card (spec 2026-09-26) so the site follows the
// founder's saved rates on page load.
```

In `quote.ts`, import `buildPricingPayload` from `'../quote/pricingPayload'`. Directly after
`const r = new Hono();`, add:

```ts
  // The live customer price list (spec 2026-09-26 §8.4): the same sell-side numbers the site bakes
  // into transfers-data.js, from the live card, so a founder rate change reaches every page that
  // prices from that copy on its next load. Public by design — never costs or markup. A 60s cache
  // keeps page views off the database. Not gated on QUOTE_V2_ENABLED: it is a read of the rates,
  // not an estimate.
  r.get('/pricing', async (c) => {
    const card = await liveCard();
    return c.json(buildPricingPayload(card), 200, { 'cache-control': 'public, max-age=60' });
  });
```

- [ ] **Step 4: Run and watch it pass, plus the codegen parity tests**

Run: `cd api && npx vitest run src/quote/pricingPayload.test.ts src/routes/quotePricing.test.ts; echo "exit=$?"`
Expected: pass, `exit=0`.

Run: `cd web-tests && npx vitest run unit/pricing-codegen.test.js unit/backend-price-parity.test.js; echo "exit=$?"`
Expected: pass, `exit=0`. Codegen still builds from the code card, because the default argument
covers it. This needs `npm ci` in `web-tests` first.

- [ ] **Step 5: Commit**

```bash
git add api/src/quote/pricingPayload.ts api/src/quote/pricingPayload.test.ts api/src/routes/quote.ts \
  api/src/routes/quotePricing.test.ts
git commit -m "feat(quote): GET /quote/pricing — the live customer price list for the site

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Project rule text, full gates, ship

- [ ] **Step 1: CLAUDE.md drift rule** (spec §11 item 4, owner-approved). Replace:

```
**Drift rules (always):** prices change ONLY via `rateCard.ts` (+ corridors in
`departureRepo.ts`) then `npm run generate` — never hand-edit a `@generated:` block (the parity +
codegen tests will, and should, fail). Generated pages change via their source + regenerate,
never by editing the output.
```

with:

```
**Drift rules (always):** customer prices (per-km, day rate, minimum fares, add-ons, buffer, FX)
change on the founder's ops **Rates** page — each save is a `rate_card_revisions` row the live card
applies (spec 2026-09-26). `rateCard.ts` holds the **code defaults** (used until the first save,
and baked into the site by `npm run generate` as its offline fallback) plus everything not editable
there (deposit, seat limits, finishing). Shared seat prices still change only in
`departureRepo.ts`. Never hand-edit a `@generated:` block (the parity + codegen tests will, and
should, fail). Generated pages change via their source + regenerate, never by editing the output.
```

In the "Minimal footprint" rule, change `**pricing** (\`rateCard.ts\` / \`departureRepo.ts\`)` to
`**pricing** (\`rateCard.ts\` / \`departureRepo.ts\` / the rate-revision code)`.

- [ ] **Step 2: Full gates.** Merge `origin/main` first if it moved. If PR 1 has merged, that brings
the spec and the PR 1 plan into this branch.

Run: `cd api && npm run check; echo "exit=$?"` with `DATABASE_URL_TEST` set (timeout 600000).
Expected: `exit=0`.

Run: `cd web-tests && npm run test:all; echo "exit=$?"` in the background (about 8 minutes).
Expected: `exit=0`. Flaky tests may pass on retry; name any in the PR.

- [ ] **Step 3: Commit, push, open the PR**

Commit: `git add CLAUDE.md docs/superpowers/plans/2026-09-26-ops-rates-page-pr2.md`, then
`git commit -m "docs: prices are founder-set on the Rates page; rateCard.ts holds the defaults"`.
The commit message gets the attribution trailer.

Push with `git push -u origin feat/rate-card-revisions`. Open the PR with `gh pr create`, titled
`feat(pricing): founder rate revisions — stored, live everywhere, API (migration 0057)`. The body
covers:
- what changed, and the claim "no revision ⇒ byte-identical" with the snapshot evidence
- the red→green lines for each task and the two gate lines
- the two §8.3 deviations and why
- **⚠ Migration 0057:** it applies to staging when this merges and to prod on promote, and the
  owner's explicit OK is needed at promote (CLAUDE.md maintenance rule 7)
- the release note: nothing changes for anyone until the founder saves a revision; the page to do
  that is PR 4

It ends with the PR attribution line.

- [ ] **Step 4: CI.** Bind the PR with the ccd_pr tools and read its checks. Merge only on the
owner's say-so: this PR carries a migration.
