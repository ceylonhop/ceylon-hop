# M11 Quote Engine Fix-Wave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the ten-item fix wave identified in the M11 QA review to the Quote Engine: close gaps in vehicle validation, type correctness, route security, CORS, config hygiene, and test coverage.

**Architecture:** All changes are confined to `api/src/quote/` (engine, types, rate card), `api/src/routes/quote.ts`, `api/src/app.ts`, and `api/src/config.ts`. Tests live co-located with their modules. No DB / payment / booking path is touched.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Vitest · integer cents throughout.

## Global Constraints

- Working directory: `/Users/roshenw/claude_code/ceylon-hop/api`, branch `m11-quote-engine`
- All money MUST stay in integer cents — no floats, no rounding in the return value
- `npm run check` (typecheck + lint + all tests) must be fully green before committing
- Do NOT relocate `billableKm`, do NOT add `bufferKm`/`billableKm` to result fields
- Do NOT touch `bookings.ts`, `pricing.ts`, or any frozen front-end files
- Commit messages: conventional format (`fix(quote): …`, `test(quote): …`)
- Baseline: 221 tests passing, 0 failures

---

### Task 1: Enforce van bag cap in `selectVehicle`

**Files:**
- Modify: `src/quote/vehicle.ts`
- Modify: `src/quote/vehicle.test.ts`

**Interfaces:**
- Consumes: `RATE_CARD.vehicle.van.maxBags` (currently 6, in `rateCard.ts`)
- Produces: `selectVehicle(pax, bags): Vehicle | 'too_big'` — no signature change, new outcome branch

**Context:** The current implementation checks `pax <= van.maxPax` but never checks `bags <= van.maxBags`. A customer with 2 pax / 7 bags would silently get a van quote. Rule must become: car if pax≤3 && bags≤3; van if pax≤6 AND bags≤6; too_big otherwise.

- [ ] **Step 1: Write the failing tests**

  Open `src/quote/vehicle.test.ts` and add these cases inside the existing `describe('selectVehicle')` block:

  ```typescript
  it('too_big when bags exceed van max (2 pax, 7 bags)', () => {
    expect(selectVehicle(2, 7)).toBe('too_big');
  });
  it('van exactly at van capacity (6 pax, 6 bags)', () => {
    expect(selectVehicle(6, 6)).toBe('van');
  });
  it('van for 4 pax, 6 bags (pax>car max, bags at van max)', () => {
    expect(selectVehicle(4, 6)).toBe('van');
  });
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm test -- --reporter=verbose src/quote/vehicle.test.ts 2>&1 | tail -20
  ```

  Expected: the `selectVehicle(2, 7)` test fails (currently returns `'van'` not `'too_big'`). The other two may pass already — that is acceptable.

- [ ] **Step 3: Fix the implementation**

  Replace `src/quote/vehicle.ts` with:

  ```typescript
  import { RATE_CARD, type Vehicle } from './rateCard';

  export function selectVehicle(pax: number, bags: number): Vehicle | 'too_big' {
    const { car, van } = RATE_CARD.vehicle;
    if (pax <= car.maxPax && bags <= car.maxBags) return 'car';
    if (pax <= van.maxPax && bags <= van.maxBags) return 'van';
    return 'too_big';
  }
  ```

- [ ] **Step 4: Run tests to confirm they pass**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm test -- --reporter=verbose src/quote/vehicle.test.ts 2>&1 | tail -20
  ```

  Expected: all 5 `selectVehicle` tests green.

- [ ] **Step 5: Run the full suite to make sure nothing regressed**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm run check 2>&1 | tail -10
  ```

- [ ] **Step 6: Commit**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && git add src/quote/vehicle.ts src/quote/vehicle.test.ts && git commit -m "fix(quote): enforce van bag cap in selectVehicle"
  ```

---

### Task 2: `marginEstimateCents: number | null` — null for shared product

**Files:**
- Modify: `src/quote/types.ts`
- Modify: `src/quote/engine.ts`
- Modify: `src/quote/engine.test.ts`

**Interfaces:**
- Produces: `QuoteResult.marginEstimateCents: number | null` — callers that read this field must handle `null`
- The route in `src/routes/quote.ts` already strips `marginEstimateCents` for public callers — no route change needed

**Context:** The engine currently returns `totalCents - 0` = `totalCents` for the shared product, which is misleading (it looks like a 100% margin). The correct sentinel is `null`. The `'margin not modelled for shared'` warning stays.

- [ ] **Step 1: Write the failing engine test (shared margin = null)**

  Add inside the existing `describe('quote()')` block in `src/quote/engine.test.ts`:

  ```typescript
  it('shared product has marginEstimateCents === null (cost not modelled)', () => {
    const r = quote({ product: 'shared', legs: [{ routeId: 'negombo->sigiriya', seats: 1, seatPriceCents: 1900, colomboPickup: false }] });
    expect(r.marginEstimateCents).toBeNull();
  });
  ```

- [ ] **Step 2: Run that test — it should fail**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm test -- --reporter=verbose src/quote/engine.test.ts 2>&1 | tail -20
  ```

  Expected: new test fails (`received 1900`, not `null`).

- [ ] **Step 3: Update the type**

  In `src/quote/types.ts`, change line 22:

  ```typescript
  // Before:
  marginEstimateCents: number; // total − cost basis; surfaced to internal/ops callers only
  // After:
  marginEstimateCents: number | null; // total − cost basis; null for shared (cost not modelled); surfaced to internal/ops callers only
  ```

- [ ] **Step 4: Update the engine — return null for shared**

  In `src/quote/engine.ts`, replace the final `return` statement with a `marginEstimateCents` computation before the return:

  ```typescript
  const totalCents = subtotalCents;
  const deposit = depositCents(totalCents);
  const amountDueNowCents = req.product === 'chauffeur' ? deposit : totalCents;
  const marginEstimateCents = req.product === 'shared' ? null : totalCents - costCents;

  return {
    product: req.product,
    currency: 'USD',
    lineItems,
    subtotalCents,
    totalCents,
    depositCents: deposit,
    amountDueNowCents,
    marginEstimateCents,
    rateCardVersion: RATE_CARD.version,
    warnings,
  };
  ```

- [ ] **Step 5: Check existing engine tests — the shared total test asserts no margin value**

  The test `'shared total (Hakan $22 incl pickup)'` only asserts `r.totalCents`, not `marginEstimateCents` — so it is unaffected. The `'private single leg'` test asserts `r.marginEstimateCents === 792` — this is a `number`, which still satisfies `number | null`.

- [ ] **Step 6: Run all engine tests**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm test -- --reporter=verbose src/quote/engine.test.ts 2>&1 | tail -20
  ```

  Expected: all tests green including the new one.

- [ ] **Step 7: Full check**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm run check 2>&1 | tail -10
  ```

- [ ] **Step 8: Commit**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && git add src/quote/types.ts src/quote/engine.ts src/quote/engine.test.ts && git commit -m "fix(quote): marginEstimateCents null for shared product"
  ```

---

### Task 3: Floor-warning copy from rate card (no hardcoded strings)

**Files:**
- Modify: `src/quote/private.ts`

**Interfaces:**
- No signature changes. The warning string format must remain identical: `"Mirissa→Tangalle hit the $29 car minimum"` — the existing test pins this.

**Context:** `private.ts` hardcodes `'$29'` / `'$50'` in the warning message. If `floorCents` changes, the string goes stale. Replace with `$${RATE_CARD.floorCents[vehicle] / 100}`.

- [ ] **Step 1: Verify the existing warning test pins the exact string**

  The test in `src/quote/private.test.ts` line 38 asserts:
  ```typescript
  expect(r.warnings).toContain('Mirissa→Tangalle hit the $29 car minimum');
  ```
  `RATE_CARD.floorCents.car = 2900`, so `2900/100 = 29` → string `'$29'` — identical.

- [ ] **Step 2: Make the change in `src/quote/private.ts`**

  Replace lines 20–21 (the `const dollars` line) with the dynamic version:

  ```typescript
  // Before:
  const dollars = vehicle === 'car' ? '$29' : '$50';
  
  // After:
  const dollars = `$${RATE_CARD.floorCents[vehicle] / 100}`;
  ```

  The full updated function header area should look like:
  ```typescript
  export function quotePrivateLegs(
    legs: PrivateLeg[],
    vehicle: Vehicle,
  ): { lineItems: LineItem[]; subtotalCents: number; warnings: string[] } {
    const lineItems: LineItem[] = [];
    const warnings: string[] = [];
    let subtotalCents = 0;
    const floor = RATE_CARD.floorCents[vehicle];
    const dollars = `$${RATE_CARD.floorCents[vehicle] / 100}`;
    // ... rest unchanged
  ```

- [ ] **Step 3: Run the private tests**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm test -- --reporter=verbose src/quote/private.test.ts 2>&1 | tail -15
  ```

  Expected: all private tests green (especially the Julián floor-warning test).

- [ ] **Step 4: Full check**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm run check 2>&1 | tail -10
  ```

- [ ] **Step 5: Commit**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && git add src/quote/private.ts && git commit -m "fix(quote): derive floor-warning copy from rate card"
  ```

---

### Task 4: Single source for extra codes (prevent Zod↔type drift)

**Files:**
- Modify: `src/quote/rateCard.ts`
- Modify: `src/routes/quote.ts`

**Interfaces:**
- Exports from `rateCard.ts`: add `EXTRA_CODES` (const tuple), `ExtraCode` (derived type)
- The existing `ExtraCode` type in `rateCard.ts` line 2 is replaced by the derived one
- `extrasDeposit.ts` imports `ExtraCode` from `rateCard` — no change needed there
- `types.ts` imports `ExtraCode` from `rateCard` — no change needed

**Context:** `ExtraCode` is currently defined as a string union in `rateCard.ts`. The Zod schema in `quote.ts` duplicates the list manually — if a code is added to the rate card, the Zod schema must be updated separately or validation silently drifts. Fix: export a `const` tuple from `rateCard.ts` and derive both the TS type and the Zod enum from it.

- [ ] **Step 1: Update `src/quote/rateCard.ts`**

  Add the const tuple before the `ExtraCode` type, then change the type to be derived:

  ```typescript
  // Replace:
  export type ExtraCode = 'sightseeing' | 'safari-wait' | 'luggage' | 'front' | 'flex' | 'waiting';
  
  // With:
  export const EXTRA_CODES = ['sightseeing', 'safari-wait', 'luggage', 'front', 'flex', 'waiting'] as const;
  export type ExtraCode = typeof EXTRA_CODES[number];
  ```

  The full top of the file becomes:
  ```typescript
  export type Vehicle = 'car' | 'van';
  export const EXTRA_CODES = ['sightseeing', 'safari-wait', 'luggage', 'front', 'flex', 'waiting'] as const;
  export type ExtraCode = typeof EXTRA_CODES[number];

  export const RATE_CARD = {
    // ... rest unchanged
  ```

- [ ] **Step 2: Update `src/routes/quote.ts` to build the Zod enum from `EXTRA_CODES`**

  Add `EXTRA_CODES` to the import and replace the manual enum:

  ```typescript
  // Change the import at top of file from:
  import { quote } from '../quote/engine';
  import type { QuoteRequest } from '../quote/types';
  
  // To:
  import { quote } from '../quote/engine';
  import type { QuoteRequest } from '../quote/types';
  import { EXTRA_CODES } from '../quote/rateCard';
  ```

  Then replace line 6:
  ```typescript
  // Before:
  const ExtraCode = z.enum(['sightseeing', 'safari-wait', 'luggage', 'front', 'flex', 'waiting']);
  
  // After:
  const ExtraCode = z.enum(EXTRA_CODES);
  ```

- [ ] **Step 3: Run typecheck — this proves no drift**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm run typecheck 2>&1
  ```

  Expected: exits 0 with no errors.

- [ ] **Step 4: Run full check**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm run check 2>&1 | tail -10
  ```

- [ ] **Step 5: Commit**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && git add src/quote/rateCard.ts src/routes/quote.ts && git commit -m "fix(quote): single source for extra codes via EXTRA_CODES tuple"
  ```

---

### Task 5: Rate-limit `/quote`, CORS allow `x-internal-key`, and `INTERNAL_QUOTE_KEY` via config

**Files:**
- Modify: `src/config.ts`
- Modify: `src/app.ts`

**Interfaces:**
- `config.INTERNAL_QUOTE_KEY: string` (new, default `''`)
- `createApp` wires it to `quoteRoutes({ internalKey: config.INTERNAL_QUOTE_KEY })`
- `rateLimit(rl)` is applied to `/quote` in addition to `/bookings/*`

**Context:** Three related wiring fixes in `app.ts`:
1. `/quote` POST has no rate limit — anyone can flood the engine. Mirror the `/bookings/*` pattern.
2. The CORS `allowHeaders` list is missing `x-internal-key` — browsers calling with that header get a CORS preflight rejection.
3. `process.env.INTERNAL_QUOTE_KEY` is read directly in `app.ts`, bypassing the validated `config` module.

All three are small edits to `app.ts` + one field in `config.ts`.

- [ ] **Step 1: Add `INTERNAL_QUOTE_KEY` to `src/config.ts`**

  After the `OPS_SESSION_SECRET` line, add:

  ```typescript
  // Quote engine internal key — passed to quoteRoutes to gate marginEstimateCents.
  INTERNAL_QUOTE_KEY: z.string().default(''),
  ```

  The full `Env` object near the bottom should have these last three lines:
  ```typescript
  OPS_SUPPORT_KEY: z.string().default(''),
  OPS_FOUNDER_KEY: z.string().default(''),
  OPS_SESSION_SECRET: z.string().default('dev-ops-secret-change-me'),
  // Quote engine internal key — passed to quoteRoutes to gate marginEstimateCents.
  INTERNAL_QUOTE_KEY: z.string().default(''),
  ```

- [ ] **Step 2: Update `src/app.ts` — three changes**

  **Change A:** Add `x-internal-key` to the CORS `allowHeaders` list.
  ```typescript
  // Before:
  allowHeaders: ['content-type', 'idempotency-key', 'x-admin-key'],
  // After:
  allowHeaders: ['content-type', 'idempotency-key', 'x-admin-key', 'x-internal-key'],
  ```

  **Change B:** Apply `rateLimit` to `/quote`.
  ```typescript
  // Before (only bookings):
  app.use('/bookings/*', rateLimit(rl));
  
  // After (both):
  app.use('/bookings/*', rateLimit(rl));
  app.use('/quote', rateLimit(rl));
  ```

  **Change C:** Replace direct `process.env` read with `config.INTERNAL_QUOTE_KEY`.
  ```typescript
  // Before:
  app.route('/quote', quoteRoutes({ internalKey: process.env.INTERNAL_QUOTE_KEY }));
  
  // After:
  app.route('/quote', quoteRoutes({ internalKey: config.INTERNAL_QUOTE_KEY }));
  ```

- [ ] **Step 3: Run typecheck**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm run typecheck 2>&1
  ```

  Expected: zero errors.

- [ ] **Step 4: Run full check**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm run check 2>&1 | tail -10
  ```

- [ ] **Step 5: Commit**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && git add src/config.ts src/app.ts && git commit -m "fix(quote): rate-limit /quote, CORS x-internal-key, config for INTERNAL_QUOTE_KEY"
  ```

---

### Task 6: Close route test gaps (wrong-key, unknown extra, no legs)

**Files:**
- Modify: `src/routes/quote.test.ts`

**Interfaces:**
- Consumes: `quoteRoutes({ internalKey: 'test-key' })` (already used in existing test), `createApp()` for the shared instance

**Context:** Three security/validation scenarios are untested:
1. **Wrong-key margin strip** — passing an incorrect `x-internal-key` must still strip `marginEstimateCents`. This is the critical security test: it ensures a brute-force key guess doesn't leak margin.
2. **Unknown extra → 400** — `extras: ['bogus']` should be rejected by Zod before the engine runs, returning 400 `invalid_request`.
3. **No legs → 400** — an empty `legs: []` array should be caught by Zod's `.min(1)` and return 400.

- [ ] **Step 1: Write the three failing tests**

  Add a second `describe` block at the bottom of `src/routes/quote.test.ts`:

  ```typescript
  describe('POST /quote — validation & security gaps', () => {
    it('wrong x-internal-key strips marginEstimateCents (security)', async () => {
      const app = new Hono();
      app.route('/quote', quoteRoutes({ internalKey: 'test-key' }));
      const res = await app.request('/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-key': 'wrong-key' },
        body: JSON.stringify({ product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }] }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).marginEstimateCents).toBeUndefined();
    });

    it('unknown extra code → 400 invalid_request (Zod rejects before engine)', async () => {
      const res = await post(createApp(), {
        product: 'private', vehicle: 'car', pax: 2, bags: 2,
        legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }],
        extras: ['bogus'],
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_request');
    });

    it('empty legs array → 400 (Zod .min(1))', async () => {
      const res = await post(createApp(), {
        product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [],
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_request');
    });
  });
  ```

- [ ] **Step 2: Run to confirm tests fail (or check they are new)**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm test -- --reporter=verbose src/routes/quote.test.ts 2>&1 | tail -25
  ```

  Expected: 3 new tests pass or fail cleanly. The wrong-key test should already pass (the existing route logic checks strict equality). The bogus-extra test verifies Zod rejects before engine — should pass. The empty-legs test verifies Zod `.min(1)` — should pass. If any fail, investigate before proceeding.

- [ ] **Step 3: Full check**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm run check 2>&1 | tail -10
  ```

- [ ] **Step 4: Commit**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && git add src/routes/quote.test.ts && git commit -m "test(quote): wrong-key strips margin, unknown extra 400, empty legs 400"
  ```

---

### Task 7: Pin chauffeur margin value + deposit cap boundary tests

**Files:**
- Modify: `src/quote/engine.test.ts`
- Modify: `src/quote/extrasDeposit.test.ts`

**Context:**
- The Emma chauffeur case is already tested for `totalCents=90380` and `amountDueNowCents=5000`, but `marginEstimateCents` is never pinned. The computed value: billableKm = 1280 (880 travel-buffered + 400 idle), costCents = round(1280 × 37) = 47360, margin = 90380 − 47360 = **43020**.
- The deposit cap boundary: `depositCents(50000)` = min(5000, 5000) = **5000**; `depositCents(49990)` = min(4999, 5000) = **4999**. These are clean unit tests in `extrasDeposit.test.ts`.

- [ ] **Step 1: Add chauffeur margin assertion to the existing Emma test**

  Find the Emma test in `src/quote/engine.test.ts` (the `'chauffeur → amountDueNow is the capped deposit'` test) and add one line at the end:

  ```typescript
  it('chauffeur → amountDueNow is the capped deposit (Emma $903.80 → $50)', () => {
    const r = quote({
      product: 'chauffeur', vehicle: 'car', firstDate: '2026-02-14', lastDate: '2026-02-22',
      travelDays: [
        { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
        { date: '2026-02-16', from: 'Kandy', to: 'Sigiriya day trip', distanceKm: 200 },
        { date: '2026-02-17', from: 'Kandy', to: 'Ella', distanceKm: 140 },
        { date: '2026-02-19', from: 'Ella', to: 'Bentota', distanceKm: 230 },
        { date: '2026-02-22', from: 'Bentota', to: 'Airport', distanceKm: 110 },
      ],
    });
    expect(r.totalCents).toBe(90380);
    expect(r.amountDueNowCents).toBe(5000);
    // billableKm: Math.round(800 * 1.1) = 880 travel + (4 idle days × 100 idle min km) = 1280
    // costCents: Math.round(1280 × 37¢/km) = 47360 → margin = 90380 − 47360 = 43020
    expect(r.marginEstimateCents).toBe(43020);
  });
  ```

- [ ] **Step 2: Add deposit cap boundary tests to `extrasDeposit.test.ts`**

  Inside the existing `describe('depositCents')` block, add two more tests:

  ```typescript
  it('cap boundary: exactly $500 total (50000¢) → deposit exactly $50 (5000¢)', () => {
    expect(depositCents(50000)).toBe(5000);
  });
  it('cap boundary: 49990¢ total → deposit 4999¢ (just under cap)', () => {
    expect(depositCents(49990)).toBe(4999);
  });
  ```

- [ ] **Step 3: Run the affected tests**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm test -- --reporter=verbose src/quote/engine.test.ts src/quote/extrasDeposit.test.ts 2>&1 | tail -25
  ```

  Expected: all green. The margin assertion of 43020 must match the engine output.

- [ ] **Step 4: Full check**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm run check 2>&1 | tail -10
  ```

- [ ] **Step 5: Commit**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && git add src/quote/engine.test.ts src/quote/extrasDeposit.test.ts && git commit -m "test(quote): pin chauffeur margin and deposit cap boundary"
  ```

---

### Task 8: Invariant assertions for representative quote requests

**Files:**
- Modify: `src/quote/engine.test.ts`

**Context:** The QA review found no systematic invariant checks. For private, chauffeur, and shared products, assert that outputs obey structural rules that must always hold regardless of input: non-negative integer totals, deposit not exceeding cap, amountDueNow not exceeding total, and all line item amounts being integers. These catch future regressions from floating-point drift or wrong rounding.

Invariant values for three representative requests:
- **Private** (car, 2 pax, 2 bags, 80 km): `totalCents=4048`, `depositCents=405` (10% not capped), `amountDueNowCents=4048`
- **Chauffeur** (Emma, car): `totalCents=90380`, `depositCents=5000` (capped), `amountDueNowCents=5000`
- **Shared** (Hakan, 1 seat 1900¢ + pickup 300¢): `totalCents=2200`, `depositCents=220`, `amountDueNowCents=2200`

- [ ] **Step 1: Add the invariant describe block to `src/quote/engine.test.ts`**

  Add this after the existing tests, as a new top-level describe block:

  ```typescript
  describe('invariants', () => {
    const CASES: { label: string; req: Parameters<typeof quote>[0] }[] = [
      {
        label: 'private (car, 2 pax, 80 km)',
        req: { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }] },
      },
      {
        label: 'chauffeur (car, Emma)',
        req: {
          product: 'chauffeur', vehicle: 'car', firstDate: '2026-02-14', lastDate: '2026-02-22',
          travelDays: [
            { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
            { date: '2026-02-16', from: 'Kandy', to: 'Sigiriya day trip', distanceKm: 200 },
            { date: '2026-02-17', from: 'Kandy', to: 'Ella', distanceKm: 140 },
            { date: '2026-02-19', from: 'Ella', to: 'Bentota', distanceKm: 230 },
            { date: '2026-02-22', from: 'Bentota', to: 'Airport', distanceKm: 110 },
          ],
        },
      },
      {
        label: 'shared (Hakan, 1 seat + pickup)',
        req: { product: 'shared', legs: [{ routeId: 'negombo->sigiriya', seats: 1, seatPriceCents: 1900, colomboPickup: true }] },
      },
    ];

    for (const { label, req } of CASES) {
      it(`${label}: totalCents is a non-negative integer`, () => {
        const r = quote(req);
        expect(r.totalCents).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(r.totalCents)).toBe(true);
      });
      it(`${label}: depositCents does not exceed RATE_CARD cap`, () => {
        const r = quote(req);
        expect(r.depositCents).toBeLessThanOrEqual(RATE_CARD.deposit.capCents);
      });
      it(`${label}: amountDueNowCents does not exceed totalCents`, () => {
        const r = quote(req);
        expect(r.amountDueNowCents).toBeLessThanOrEqual(r.totalCents);
      });
      it(`${label}: every lineItem.amountCents is an integer`, () => {
        const r = quote(req);
        for (const item of r.lineItems) {
          expect(Number.isInteger(item.amountCents)).toBe(true);
        }
      });
    }
  });
  ```

- [ ] **Step 2: Run the engine tests**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm test -- --reporter=verbose src/quote/engine.test.ts 2>&1 | tail -30
  ```

  Expected: all 12 new invariant tests green (3 cases × 4 assertions each).

- [ ] **Step 3: Full check**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm run check 2>&1 | tail -10
  ```

  Expected: fully green. Count the new test total and note it.

- [ ] **Step 4: Commit**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && git add src/quote/engine.test.ts && git commit -m "test(quote): invariant assertions for private, chauffeur, shared"
  ```

---

### Task 9: Write the fix-wave report

**Files:**
- Create: `/Users/roshenw/claude_code/ceylon-hop/.superpowers/sdd/fixwave-report.md`

**Context:** The prompt requires a report at `.superpowers/sdd/fixwave-report.md` listing each item done, new tests, and final check result.

- [ ] **Step 1: Get the final test count**

  ```bash
  cd /Users/roshenw/claude_code/ceylon-hop/api && npm run check 2>&1 | grep -E "Tests|Test Files"
  ```

- [ ] **Step 2: Create the report directory and write the file**

  ```bash
  mkdir -p /Users/roshenw/claude_code/ceylon-hop/.superpowers/sdd
  ```

  Then write the file with the actual commit SHAs and test count from the final run. The file must list:
  - Each of the 10 items (1–10) with status DONE
  - The new tests added per task (names and file paths)
  - The final `npm run check` result line (test count + zero failures)

---

## Self-Review

### Spec coverage check

| Item | Task |
|------|------|
| 1. Van bag cap in selectVehicle | Task 1 |
| 2. marginEstimateCents: number\|null, null for shared | Task 2 |
| 3. Floor-warning copy from rate card | Task 3 |
| 4. Single source for extra codes (EXTRA_CODES tuple) | Task 4 |
| 5. Rate-limit /quote | Task 5 |
| 6. CORS allow x-internal-key | Task 5 |
| 7. INTERNAL_QUOTE_KEY via config | Task 5 |
| 8a. Wrong-key margin strip test | Task 6 |
| 8b. Unknown extra → 400 test | Task 6 |
| 8c. No legs → 400 test | Task 6 |
| 9a. Chauffeur margin value pinned | Task 7 |
| 9b. Deposit cap boundary tests | Task 7 |
| 10. Invariants describe block | Task 8 |
| Report to .superpowers/sdd/fixwave-report.md | Task 9 |

All 14 sub-items covered. No gaps.

### Placeholder scan

No TBD/TODO/placeholder text found. All code blocks include exact implementations.

### Type consistency

- `marginEstimateCents: number | null` is defined in Task 2 (`types.ts`) and all subsequent references remain consistent
- `EXTRA_CODES` is defined in Task 4 (`rateCard.ts`) and consumed in Task 4 (`quote.ts`) — same file import in both steps
- `config.INTERNAL_QUOTE_KEY` is defined in Task 5 (`config.ts`) and consumed in Task 5 (`app.ts`) — consistent
- `depositCents` function signature unchanged — Task 7 tests call it directly

### Pre-computed test values verification

- Emma margin: travelKm=800, billableKm(800)=880, idleDays=4, idleKm=400, totalBillable=1280, costCents=round(1280×37)=47360, margin=90380-47360=**43020** ✓
- depositCents(50000): round(50000×10/100)=5000, min(5000,5000)=**5000** ✓
- depositCents(49990): round(49990×10/100)=4999, min(4999,5000)=**4999** ✓
