# Pricing single source of truth — front-end codegen

**Date:** 2026-07-09
**Branch:** `pricing-single-source-codegen`
**Owner decision:** Roshen — "all prices, one source of truth, no copies."

## Goal

Make `api/src/quote/rateCard.ts` (plus corridor seat prices in
`api/src/db/departureRepo.ts`) the **only** place a human ever types a price. Every
front-end price becomes a generated build artifact. Drift stops being something we
*test for* and becomes something that *cannot happen*, because there is no second
hand-maintained copy to drift.

## Current state — the copies we are eliminating

The backend rate card is canonical, but the static front-end hand-copies prices so
quotes render with no API call. Audit (2026-07-09):

| Price | Canonical (backend) | Front-end copy | Guarded before this work? |
|---|---|---|---|
| per-km car/van | `perKmCents` 35/47 | `transfers-data PER_KM` 0.35/0.47 | yes (added in `e20637d`) |
| chauffeur day rate | `chauffeur.dayRateCents` 3500 | `CHAUFFEUR_DAY_FEE` 35 | yes |
| deposit pct / cap | `deposit` 10 / 5000 | `DEPOSIT_PCT`/`DEPOSIT_CAP` | yes |
| min-fare floors car/van | `floorCents` 2900/5000 | `29`/`50` literals in `legPrice` | no |
| routing buffer | `bufferPct` 10 | `× 1.10` literals | no |
| extras (add-ons) | `extras` {1000,500,800,1200,1900} | `booking.js` `addonPrices` {10,5,8,12} | no — and missing `safari-wait`, `waiting` |
| corridor seat prices | `departureRepo CORRIDOR_ROUTES` | `transfers-data CORRIDORS.seat` **and** `routes-data.js` shared `price` | partial (`shared-price-parity.test.js`) |

Two latent problems this design closes:
- `booking.js:812 addonPrices` is an unguarded, incomplete copy of the extras table.
- Floors and buffer are unguarded literals in two files.

## Design

A three-part pipeline that reuses the existing `tools/` + `npm run generate`
infrastructure (which already generates SEO route pages).

### 1. Dump (backend, read-only)

`api/scripts/dump-pricing.ts` imports the **real** `RATE_CARD` object and the corridor
seat prices, and prints a single canonical JSON document to stdout:

```jsonc
{
  "perKm":   { "car": 0.35, "van": 0.47 },
  "floors":  { "car": 29, "van": 50 },
  "bufferPct": 10,
  "chauffeurDayFee": 35,
  "depositPct": 0.10,
  "depositCap": 50,
  "extras":  { "sightseeing": 10, "safari-wait": 19, "luggage": 5, "front": 8, "flex": 12, "waiting": 10 },
  "corridorSeat": { "<corridorId>": 19, ... }
}
```

Cents → dollars conversion happens here, once. It does **not** modify `rateCard.ts` —
it only reads it — so there is no backend interface change. Runs on api's existing
`tsx`.

### 2. Generate (root tool)

`tools/generate-pricing.mjs` (dependency-free ESM, like the other generators):
1. Runs the dump via `execFileSync('npm', ['run','--silent','dump:pricing'], {cwd:'api'})`
   and parses the JSON.
2. Rewrites a fenced block inside `transfers-data.js` between sentinel comments:
   ```js
   /* @generated:pricing — from api/src/quote/rateCard.ts · DO NOT EDIT BY HAND · run `npm run generate` */
   const PER_KM = {"car":0.35,"van":0.47};
   const FLOORS = {"car":29,"van":50};
   const BUFFER_PCT = 10;
   const CHAUFFEUR_DAY_FEE = 35;
   const DEPOSIT_PCT = 0.10;
   const DEPOSIT_CAP = 50;
   const EXTRAS = {"sightseeing":10,"safari-wait":19,"luggage":5,"front":8,"flex":12,"waiting":10};
   const CORRIDOR_SEAT = {"airport-cultural":19,"ella-east":23,"yala-south":16, ...};
   /* @end:pricing */
   ```
   The corridor **structure** (id → stops/times/label) stays hand-authored in
   `transfers-data.js CORRIDORS`; only the seat **price** is generated. Each corridor's
   `seat:` literal is wired once to reference the generated map
   (`seat: CORRIDOR_SEAT['airport-cultural']`) — a structural edit, not a price — so the
   price itself is never hand-typed.
3. Rewrites the numeric `price:` field on each `type:'shared'` route in `routes-data.js`,
   leaving all hand-written copy/images untouched. The generator loads the just-generated
   `transfers-data.js` and resolves each shared route's corridor via the engine's
   `sharedOption(stops[0], stops[1])` — the **same mechanism** `shared-price-parity.test.js`
   already uses — then writes that corridor's seat price. No new `corridorId` field is
   needed; the existing stop→corridor resolution is authoritative.

The generator is **idempotent**: running it on already-generated files produces no
diff.

### 3. Consume (front-end)

- `transfers-data.js`: `legPrice` uses `PER_KM`/`FLOORS`/`BUFFER_PCT`; chauffeur/deposit
  constants come from the generated block; `CORRIDORS[].seat` is sourced from
  `corridorSeat` (single carrier). All exposed on `window.TRANSFERS` as today.
- `booking.js`: `addonPrices` is replaced by a read of `window.TRANSFERS.EXTRAS`; the
  chauffeur per-km line already reads `window.TRANSFERS.PER_KM`; the `× 1.10` buffer
  literal reads `window.TRANSFERS.BUFFER_PCT`.

### 4. Wire

`npm run generate` gains `node tools/generate-pricing.mjs`. `api/package.json` gains a
`dump:pricing` script.

## Guards (enforcement, not just detection)

1. **Freshness test** (the real enforcement) — mirrors `seo-codegen.test.js`. Runs the
   dump, regenerates the block in memory, and asserts the committed `transfers-data.js`
   and `routes-data.js` blocks are byte-identical. A stale checkout (someone edited the
   rate card and forgot `npm run generate`) fails CI.
2. **Value-parity test** — loads the real `window.TRANSFERS` IIFE and asserts every
   generated constant equals the backend dump. Catches a broken generator.
3. **Extras completeness** — `window.TRANSFERS.EXTRAS` keys/values equal the backend
   `extras` table (converted), so the `booking.js` add-on list can never again omit an
   extra.

## Out of scope (YAGNI)

- `van9`/`van14`/`custom` per-km/floors: the front-end only quotes car/van; the
  generated block carries only what the front-end uses.
- Marketing **package** tour prices in `routes-data.js` (e.g. `price:129` on multi-day
  packages) are products, not rate-card entries — untouched.
- Runtime `/pricing` fetch: rejected. The static site must render quotes offline; a
  build-time artifact keeps that property with zero network dependency.

## Testing strategy (TDD)

Each step is red→green per `CLAUDE.md`:
1. Dump script: test it prints valid JSON matching known rate-card values.
2. Generator: test idempotency + that it injects expected constants (unit-test the
   pure transform on a fixture string).
3. Freshness + parity + completeness guards (above).
4. Consumers: existing `pricing.test.js` cases must stay green (values unchanged — this
   is a value-preserving refactor).

## Rollout

Single branch → single PR to `main`, with red→green evidence. `cd api && npm run check`
and `npm run test:all` green before opening. Isolated in worktree
`ceylon-hop-pricing` to avoid the concurrent `main` committer sweeping intermediate
state.
