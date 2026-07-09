# Front-end Pricing Single-Source Codegen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate every front-end price from the backend rate card so no price is ever hand-typed in `transfers-data.js`, `booking.js`, or `routes-data.js`.

**Architecture:** A backend read-only dump (`buildPricingPayload()` in `api/`) emits canonical prices as JSON. A dependency-free root generator (`tools/generate-pricing.mjs`) injects them into a sentinel-fenced block in `transfers-data.js`, wires the front-end code to read that block, and rewrites the shared-ride `price` fields in `routes-data.js`. A freshness test regenerates in memory and fails CI if the committed output is stale.

**Tech Stack:** Node 20 ESM (`.mjs`, no deps) for the generator; TypeScript + `tsx` for the dump; Vitest (api + web-tests) for tests.

## Global Constraints

- **Values must not change.** This is a value-preserving refactor + codegen; every existing `web-tests` and `api` assertion stays green. car $0.35/km, van $0.47/km; floors car $29 / van $50; buffer 10%; chauffeur day $35; deposit 10% cap $50; extras {sightseeing 10, safari-wait 19, luggage 5, front 8, flex 12, waiting 10}; corridor seats {airport-cultural 19, hill-line 21, ella-east 23, south-coast 14, yala-south 16, ella-south 24}.
- **Backend is canonical.** Generated front-end only; never edit generated blocks by hand.
- **Money = integer minor units in the backend**; the dump converts cents→whole USD once, at the boundary.
- **No new product options.** Do NOT add `safari-wait`/`waiting` to the booking add-on UI — that is a product decision. Only make the prices booking already uses come from the rate card.
- **Backend interface stays stable.** `rateCard.ts` and `departureRepo.ts` are read, not restructured.
- **Gate:** `cd api && npm run check` and (from repo root) `npm run test:all` green before PR.

## File Structure

- **Create** `api/src/quote/pricingPayload.ts` — `buildPricingPayload()`: reads `RATE_CARD` + `DEFAULT_CORRIDORS`, returns the canonical `PricingPayload` (cents→USD). One responsibility: define what the front-end is allowed to know about prices.
- **Create** `api/scripts/dump-pricing.ts` — thin CLI: `console.log(JSON.stringify(buildPricingPayload()))`.
- **Create** `tools/generate-pricing.mjs` — orchestrator + pure `injectPricingBlock(src, payload)` and `applySharedPrices(routesSrc, transfers)` transforms.
- **Create** `api/src/quote/pricingPayload.test.ts` — dump values.
- **Create** `web-tests/unit/pricing-codegen.test.js` — generator idempotency + freshness + parity + extras completeness.
- **Modify** `transfers-data.js` — add sentinel block; wire `CORRIDORS[].seat`, `legPrice`, constants, exports.
- **Modify** `booking.js:812,884` — read `EXTRAS` and `BUFFER_PCT` from `window.TRANSFERS`.
- **Modify** `routes-data.js` — shared `price` fields become generated.
- **Modify** `api/package.json` (add `dump:pricing`), root `package.json` (add generator to `generate`).

---

### Task 1: Canonical pricing payload + dump CLI

**Files:**
- Create: `api/src/quote/pricingPayload.ts`
- Create: `api/scripts/dump-pricing.ts`
- Test: `api/src/quote/pricingPayload.test.ts`
- Modify: `api/package.json` (scripts)

**Interfaces:**
- Produces: `buildPricingPayload(): PricingPayload` where
  ```ts
  type PricingPayload = {
    perKm: { car: number; van: number };
    floors: { car: number; van: number };
    bufferPct: number;
    chauffeurDayFee: number;
    depositPct: number;   // fraction, e.g. 0.10
    depositCap: number;   // USD
    extras: Record<string, number>;        // USD per extra code
    corridorSeat: Record<string, number>;  // corridorId -> USD seat
  };
  ```

- [ ] **Step 1: Write the failing test**
```ts
// api/src/quote/pricingPayload.test.ts
import { describe, it, expect } from 'vitest';
import { buildPricingPayload } from './pricingPayload';

describe('buildPricingPayload', () => {
  it('converts the rate card to whole-USD front-end values', () => {
    const p = buildPricingPayload();
    expect(p.perKm).toEqual({ car: 0.35, van: 0.47 });
    expect(p.floors).toEqual({ car: 29, van: 50 });
    expect(p.bufferPct).toBe(10);
    expect(p.chauffeurDayFee).toBe(35);
    expect(p.depositPct).toBe(0.10);
    expect(p.depositCap).toBe(50);
    expect(p.extras).toMatchObject({ sightseeing: 10, 'safari-wait': 19, luggage: 5, front: 8, flex: 12, waiting: 10 });
    expect(p.corridorSeat).toMatchObject({ 'airport-cultural': 19, 'ella-east': 23, 'ella-south': 24 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/quote/pricingPayload.test.ts`
Expected: FAIL — `Cannot find module './pricingPayload'`.

- [ ] **Step 3: Write minimal implementation**

First confirm the corridor source is exported: `grep -n "DEFAULT_CORRIDORS" src/db/departureRepo.ts` — if it is not `export`ed, add `export` to its declaration (read-only additive change).
```ts
// api/src/quote/pricingPayload.ts
import { RATE_CARD } from './rateCard';
import { DEFAULT_CORRIDORS } from '../db/departureRepo';

export type PricingPayload = {
  perKm: { car: number; van: number };
  floors: { car: number; van: number };
  bufferPct: number;
  chauffeurDayFee: number;
  depositPct: number;
  depositCap: number;
  extras: Record<string, number>;
  corridorSeat: Record<string, number>;
};

const c = (cents: number) => cents / 100;

export function buildPricingPayload(): PricingPayload {
  const extras: Record<string, number> = {};
  for (const [k, v] of Object.entries(RATE_CARD.extras)) extras[k] = c(v);
  const corridorSeat: Record<string, number> = {};
  for (const cor of DEFAULT_CORRIDORS) corridorSeat[cor.id] = cor.seat; // already whole USD
  return {
    perKm: { car: c(RATE_CARD.perKmCents.car), van: c(RATE_CARD.perKmCents.van) },
    floors: { car: c(RATE_CARD.floorCents.car), van: c(RATE_CARD.floorCents.van) },
    bufferPct: RATE_CARD.bufferPct,
    chauffeurDayFee: c(RATE_CARD.chauffeur.dayRateCents),
    depositPct: RATE_CARD.deposit.pct / 100,
    depositCap: c(RATE_CARD.deposit.capCents),
    extras,
    corridorSeat,
  };
}
```
```ts
// api/scripts/dump-pricing.ts
import { buildPricingPayload } from '../src/quote/pricingPayload';
process.stdout.write(JSON.stringify(buildPricingPayload(), null, 2) + '\n');
```
Add to `api/package.json` scripts: `"dump:pricing": "tsx scripts/dump-pricing.ts"`.

- [ ] **Step 4: Run test + dump to verify**

Run: `cd api && npx vitest run src/quote/pricingPayload.test.ts` → PASS.
Run: `cd api && npm run --silent dump:pricing` → prints the JSON payload.

- [ ] **Step 5: Commit**
```bash
git add api/src/quote/pricingPayload.ts api/src/quote/pricingPayload.test.ts api/scripts/dump-pricing.ts api/package.json
git commit -m "Add canonical pricing payload + dump CLI (front-end codegen source)"
```

---

### Task 2: Generator — pure inject transform + idempotency

**Files:**
- Create: `tools/generate-pricing.mjs`
- Test: `web-tests/unit/pricing-codegen.test.js`

**Interfaces:**
- Consumes: `buildPricingPayload()` JSON via `npm run --silent dump:pricing` (cwd `api`).
- Produces (named exports for tests):
  - `PRICING_BEGIN` / `PRICING_END` sentinel strings.
  - `renderPricingBlock(payload): string` — the exact fenced block text.
  - `injectPricingBlock(src, payload): string` — replaces the block between sentinels (throws if sentinels absent).
  - `readPayload(): object` — runs the dump and parses it.
  - `main()` — writes `transfers-data.js` then `routes-data.js`.

- [ ] **Step 1: Write the failing test**
```js
// web-tests/unit/pricing-codegen.test.js
import { describe, it, expect } from 'vitest';
import { renderPricingBlock, injectPricingBlock, PRICING_BEGIN, PRICING_END } from '../../tools/generate-pricing.mjs';

const payload = {
  perKm: { car: 0.35, van: 0.47 }, floors: { car: 29, van: 50 }, bufferPct: 10,
  chauffeurDayFee: 35, depositPct: 0.10, depositCap: 50,
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
    expect(injectPricingBlock(once, payload)).toBe(once); // idempotent
  });
  it('renders EXTRAS and CORRIDOR_SEAT', () => {
    const block = renderPricingBlock(payload);
    expect(block).toContain('"safari-wait":19');
    expect(block).toContain('"ella-east":23');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-tests && npx vitest run unit/pricing-codegen.test.js`
Expected: FAIL — cannot import from `tools/generate-pricing.mjs`.

- [ ] **Step 3: Write minimal implementation**
```js
// tools/generate-pricing.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PRICING_BEGIN = '/* @generated:pricing — from api/src/quote/rateCard.ts · DO NOT EDIT BY HAND · run `npm run generate` */';
export const PRICING_END = '/* @end:pricing */';

const j = (o) => JSON.stringify(o);
export function renderPricingBlock(p) {
  return [
    PRICING_BEGIN,
    `  const PER_KM = ${j(p.perKm)};`,
    `  const FLOORS = ${j(p.floors)};`,
    `  const BUFFER_PCT = ${p.bufferPct};`,
    `  const CHAUFFEUR_DAY_FEE = ${p.chauffeurDayFee};`,
    `  const DEPOSIT_PCT = ${p.depositPct};`,
    `  const DEPOSIT_CAP = ${p.depositCap};`,
    `  const EXTRAS = ${j(p.extras)};`,
    `  const CORRIDOR_SEAT = ${j(p.corridorSeat)};`,
    `  ${PRICING_END}`,
  ].join('\n');
}
export function injectPricingBlock(src, payload) {
  const b = src.indexOf(PRICING_BEGIN);
  const e = src.indexOf(PRICING_END);
  if (b === -1 || e === -1) throw new Error('pricing sentinels not found in source');
  const indent = src.slice(src.lastIndexOf('\n', b) + 1, b); // leading whitespace before BEGIN
  const block = renderPricingBlock(payload).split('\n').join('\n' + indent);
  return src.slice(0, b) + block + src.slice(e + PRICING_END.length);
}
export function readPayload() {
  const out = execFileSync('npm', ['run', '--silent', 'dump:pricing'], { cwd: join(ROOT, 'api'), encoding: 'utf8' });
  return JSON.parse(out);
}
```
(The `main()` + routes-data logic land in Task 5; keep this task's module importable.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-tests && npx vitest run unit/pricing-codegen.test.js` → PASS (the two `injectPricingBlock`/`renderPricingBlock` tests).

- [ ] **Step 5: Commit**
```bash
git add tools/generate-pricing.mjs web-tests/unit/pricing-codegen.test.js
git commit -m "Add pricing generator: pure inject transform + idempotency"
```

---

### Task 3: Wire transfers-data.js to the generated block

**Files:**
- Modify: `transfers-data.js` (top of IIFE; `CORRIDORS` seats; `legPrice`; drop hand consts; exports)

**Interfaces:**
- Consumes: generated `PER_KM/FLOORS/BUFFER_PCT/CHAUFFEUR_DAY_FEE/DEPOSIT_PCT/DEPOSIT_CAP/EXTRAS/CORRIDOR_SEAT`.
- Produces: `window.TRANSFERS.EXTRAS`, `.FLOORS`, `.BUFFER_PCT` (in addition to existing `PER_KM`, `CHAUFFEUR_DAY_FEE`, `DEPOSIT_PCT`, `DEPOSIT_CAP`).

- [ ] **Step 1:** Insert the sentinel block at the very top of the IIFE body (before `const CORRIDORS`), initially with placeholder values, then let codegen fill it:
```js
  /* @generated:pricing — from api/src/quote/rateCard.ts · DO NOT EDIT BY HAND · run `npm run generate` */
  const PER_KM = {"car":0,"van":0};
  const FLOORS = {"car":0,"van":0};
  const BUFFER_PCT = 0;
  const CHAUFFEUR_DAY_FEE = 0;
  const DEPOSIT_PCT = 0;
  const DEPOSIT_CAP = 0;
  const EXTRAS = {};
  const CORRIDOR_SEAT = {};
  /* @end:pricing */
```
- [ ] **Step 2:** Remove the now-duplicated hand-authored declarations: the old `const PER_KM = { car: 0.35, van: 0.47 };`, `const CHAUFFEUR_DAY_FEE = 35;`, `const DEPOSIT_PCT = 0.10;`, `const DEPOSIT_CAP = 50;`.
- [ ] **Step 3:** Wire each corridor seat: `seat: 19` → `seat: CORRIDOR_SEAT['airport-cultural']` (and hill-line 21, ella-east 23, south-coast 14, yala-south 16, ella-south 24).
- [ ] **Step 4:** `legPrice`: `Math.round(km * 1.10)` → `Math.round(km * (1 + BUFFER_PCT/100))`; `Math.max(29, ...)` → `Math.max(FLOORS.car, ...)`; `Math.max(50, ...)` → `Math.max(FLOORS.van, ...)`. `repriceDecision`: `Math.round(anchorKm * 1.10)` → `Math.round(anchorKm * (1 + BUFFER_PCT/100))`.
- [ ] **Step 5:** Add `EXTRAS, FLOORS, BUFFER_PCT` to the `window.TRANSFERS = { ... }` export list.
- [ ] **Step 6: Run the generator** to fill the block from the backend:

Run: `node tools/generate-pricing.mjs` (after Task 5 adds `main()`; until then, temporarily fill via a node one-liner using `injectPricingBlock` + `readPayload`). Verify the block now shows real values.
- [ ] **Step 7: Run existing value tests — must stay green:**

Run: `cd web-tests && npx vitest run unit/pricing.test.js unit/reprice-decision.test.js unit/shared-price-parity.test.js`
Expected: PASS (values unchanged).
- [ ] **Step 8: Commit**
```bash
git add transfers-data.js
git commit -m "transfers-data: source all prices from generated block"
```

---

### Task 4: Wire booking.js to generated extras + buffer

**Files:**
- Modify: `booking.js:812` (`addonPrices`), `booking.js:884` (buffer)
- Test: extend `web-tests/unit/pricing.test.js` source guard

- [ ] **Step 1: Write the failing guard** (add to the existing "no silent drift" describe in `pricing.test.js`):
```js
  it('booking.js sources add-on prices and buffer from window.TRANSFERS (no literals)', () => {
    expect(src).toMatch(/window\.TRANSFERS\.EXTRAS/);
    expect(src).toMatch(/window\.TRANSFERS\.BUFFER_PCT/);
    expect(src).not.toMatch(/addonPrices\s*=\s*\{/); // no hand-typed extras table
  });
```
- [ ] **Step 2: Run to verify it fails**

Run: `cd web-tests && npx vitest run unit/pricing.test.js -t "sources add-on"` → FAIL.
- [ ] **Step 3: Implement**
  - `booking.js:812`: `const addonPrices={sightseeing:10,luggage:5,front:8,flex:12};` → `const addonPrices = (window.TRANSFERS && window.TRANSFERS.EXTRAS) || {};`
  - `booking.js:884`: `Math.round(tripKm * 1.10)` → `Math.round(tripKm * (1 + window.TRANSFERS.BUFFER_PCT/100))`
- [ ] **Step 4: Run to verify green** (guard + full pricing file):

Run: `cd web-tests && npx vitest run unit/pricing.test.js` → PASS.
- [ ] **Step 5: Commit**
```bash
git add booking.js web-tests/unit/pricing.test.js
git commit -m "booking.js: read extras + buffer from generated source of truth"
```

---

### Task 5: Generator `main()` — routes-data shared prices + full run

**Files:**
- Modify: `tools/generate-pricing.mjs` (add `applySharedPrices` + `main()` + auto-run guard)
- Modify: `routes-data.js` (regenerated `price:` on shared routes)
- Test: `web-tests/unit/pricing-codegen.test.js` (add `applySharedPrices` unit)

- [ ] **Step 1: Write failing test** for the shared-price transform using the existing `loadTransfers`/`loadRoutes` pattern from `_load.js`:
```js
import { loadTransfers, loadRoutes } from './_load.js';
import { applySharedPrices } from '../../tools/generate-pricing.mjs';
it('rewrites every shared route price to its corridor seat', () => {
  const T = loadTransfers();
  const routesSrc = readFileSync(new URL('../../routes-data.js', import.meta.url), 'utf8');
  const out = applySharedPrices(routesSrc, T);
  // spot-check: Negombo→Sigiriya is airport-cultural = 19
  expect(out).toMatch(/id:\s*'negombo-sigiriya'[\s\S]*?price:\s*19/);
});
```
- [ ] **Step 2: Run → FAIL** (`applySharedPrices` undefined).
- [ ] **Step 3: Implement** `applySharedPrices(routesSrc, transfers)` — for each `type:'shared'` route object in the source, resolve `sharedOption(resolvePlace(stops[0]).id, resolvePlace(stops[1]).id).seat` and replace that object's `price: N`. Use a robust per-route regex keyed on the route `id`. Add `main()`:
```js
export function main() {
  const payload = readPayload();
  const tPath = join(ROOT, 'transfers-data.js');
  writeFileSync(tPath, injectPricingBlock(readFileSync(tPath, 'utf8'), payload));
  const transfers = loadTransfersFrom(tPath); // vm-eval helper, mirrors tools/load-transfers.mjs
  const rPath = join(ROOT, 'routes-data.js');
  writeFileSync(rPath, applySharedPrices(readFileSync(rPath, 'utf8'), transfers));
}
if (import.meta.url === `file://${process.argv[1]}`) main();
```
- [ ] **Step 4: Run generator + tests:**

Run: `node tools/generate-pricing.mjs` then `cd web-tests && npx vitest run unit/pricing-codegen.test.js unit/shared-price-parity.test.js` → PASS.
- [ ] **Step 5: Commit**
```bash
git add tools/generate-pricing.mjs routes-data.js web-tests/unit/pricing-codegen.test.js
git commit -m "Generator: rewrite routes-data shared prices from corridor seats"
```

---

### Task 6: Enforcement — freshness + value-parity + completeness guards

**Files:**
- Modify: `web-tests/unit/pricing-codegen.test.js`

- [ ] **Step 1: Write failing tests:**
```js
import { readFileSync } from 'node:fs';
import { injectPricingBlock, applySharedPrices, readPayload } from '../../tools/generate-pricing.mjs';
import { loadTransfers } from './_load.js';

it('FRESHNESS: committed transfers-data.js pricing block is up to date', () => {
  const p = readPayload();
  const path = new URL('../../transfers-data.js', import.meta.url);
  const src = readFileSync(path, 'utf8');
  expect(injectPricingBlock(src, p)).toBe(src); // regen == committed
});
it('FRESHNESS: committed routes-data.js shared prices are up to date', () => {
  const T = loadTransfers();
  const path = new URL('../../routes-data.js', import.meta.url);
  const src = readFileSync(path, 'utf8');
  expect(applySharedPrices(src, T)).toBe(src);
});
it('PARITY: window.TRANSFERS constants equal the backend payload', () => {
  const p = readPayload();
  const T = loadTransfers();
  expect(T.PER_KM).toEqual(p.perKm);
  expect(T.FLOORS).toEqual(p.floors);
  expect(T.BUFFER_PCT).toBe(p.bufferPct);
  expect(T.CHAUFFEUR_DAY_FEE).toBe(p.chauffeurDayFee);
  expect(T.EXTRAS).toEqual(p.extras); // completeness: all extras present, correct
});
```
- [ ] **Step 2: Run → PASS** (implementation from Tasks 1–5 already satisfies them; if a freshness test fails, run `node tools/generate-pricing.mjs` and re-commit the generated files).
- [ ] **Step 3: Commit**
```bash
git add web-tests/unit/pricing-codegen.test.js
git commit -m "Guard pricing codegen: freshness + parity + extras completeness"
```

---

### Task 7: Wire into `npm run generate` + final gate

**Files:**
- Modify: root `package.json`

- [ ] **Step 1:** Add `node tools/generate-pricing.mjs` to the `generate` script and a `generate:pricing` entry.
- [ ] **Step 2: Run the full gate:**

Run: `node tools/generate-pricing.mjs` (should produce no diff — idempotent).
Run: `cd api && npm run check` → PASS.
Run: `cd web-tests && npm run test:all` (or at least `test:unit`) → PASS.
- [ ] **Step 3: Commit**
```bash
git add package.json
git commit -m "Wire pricing codegen into npm run generate"
```

---

## Self-Review

- **Spec coverage:** dump (T1), generate+inject (T2), transfers consume (T3), booking consume (T4), routes-data gen (T5), freshness/parity/completeness guards (T6), wiring (T7). All spec sections covered.
- **Types:** `buildPricingPayload → PricingPayload` fields match every consumer (`renderPricingBlock`, parity test). Sentinel constants shared via named exports (`PRICING_BEGIN/END`).
- **No new options:** booking add-on UI unchanged; only price source changes (Global Constraints).
- **Risk:** `applySharedPrices` regex must be anchored per-route `id` to avoid clobbering package prices — spot-checked in T5 test + guarded by T6 freshness.
