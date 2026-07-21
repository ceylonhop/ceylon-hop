# Multi-Stop Rides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the ride model (one day's journey = ordered list of 2+ stops) per `docs/superpowers/specs/2026-07-20-multi-stop-rides-design.md` — phases 0, 1, 2, 3a only. Phase 3b (customer trip builder) is OUT OF SCOPE.

**Architecture:** A `Ride { stops, segmentKms }` engine type with a single normalizer at every raw-request entry point (`quote()` and `quoteBreakdown()`); old `{from,to,distanceKm}` legs normalize to 2-stop rides with bit-identical pricing. Ops tool widens its Zod schema + UI to stop lists; public `/quote` schema deliberately stays leg-only. No DB migration anywhere.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Vitest · vanilla-JS ops-ui (`ops-ui.html`) · Playwright (web-tests).

**Branch/PR mechanics (controller's job, not the implementers'):** all tasks land sequentially on the worktree branch `worktree-multistop-rides`. At each phase boundary the controller pushes a phase branch and opens a PR (stacked: Phase 1 PR targets Phase 0's branch, etc. — retarget children before deleting a merged parent). `main` is protected; nothing merges without green CI.

## Global Constraints

Copied verbatim / distilled from the spec — every task's requirements implicitly include these:

- **GC-1 Golden equivalence:** Phase 0 golden snapshots (captured from the PRE-change engine) must reproduce **deep-equal** (labels, warnings, meta, cents) on the post-change engine for every old-shape request. Never regenerate a golden to make a diff pass — a golden diff is a bug in the new code.
- **GC-2 Warning byte-exactness:** the floor-hit warning for a 2-stop ride is `` `${from}→${to} hit the ${dollars} ${vehicle} minimum` `` with **NO spaces around the arrow**. Multi-stop (3+ stops) warnings use the spaced joined form `stops.join(' → ')`.
- **GC-3 Label form:** line-item label is `` `${stops.join(' → ')} (${vehicle})` `` — identical to today for 2 stops.
- **GC-4 meta/breakdown shape gate (controller decision 2026-07-21, resolves a spec-internal conflict):** new keys (`stops`, `segmentKms` in line-item meta; `stops` in `LegBreakdown`) are added **only when `stops.length >= 3`**. 2-stop output stays byte-identical (GC-1 depends on this). `LegBreakdown.from/.to` = `stops[0]`/`stops[stops.length-1]` always.
- **GC-5 Wire back-compat:** the wire field stays `legs` / `travelDays`. Old shape `{from,to,distanceKm}` accepted everywhere forever (stored quotes must reopen + reprice identically).
- **GC-6 Ops-only enforcement:** the public `POST /quote` + `/quote/lock` Zod schema (`api/src/routes/quote.ts`) stays **strictly leg-only**. Do not touch that file. Only the ops route (`internalQuote.ts`) widens.
- **GC-7 Pricing rule:** per ride: `rideRawKm = Σ segmentKms`; buffer applied **once** to the day total (`billableKm(rideRawKm)`); **one floor per ride**; `protectedMinimumCents = rides.length × floorCents[vehicle]`; cost basis = `billableKm(rideRawKm) × costPerKm` per ride.
- **GC-8 Validation:** `stops.length >= 2` and `<= 8`; `segmentKms.length === stops.length - 1`; consecutive stops must differ (trim-compare); non-consecutive repeats allowed (out-and-back). Segment km ≥ 0. `null` segment km = "resolve for me" (accepted alongside `0`).
- **GC-9 stay_day exempt:** `stay_day` legs never get stop lists — single-location special case, unchanged.
- **GC-10 Route-choice interplay (controller decision 2026-07-21 — feature merged after the spec):** route compare / route modal / `routeVariant` apply **only to single-segment legs** (`stops.length === 2`). Adding a 3rd stop clears `routeVariant`/`routeOptions`/`_sameRoute`/`_promptedRouteChoice`. Wire fields stay leg-level passthrough, unchanged.
- **GC-11 No DB migration.** No schema change, no new tables, nothing in `api/drizzle/`.
- **GC-12 Leave it green:** `cd api && npm run check` before every commit; web-tests (`cd web-tests && npm run test:unit`, plus Playwright where the task touches ops-ui) green before a phase closes. Never commit red. TDD: red → green evidence in every task report.
- **GC-13 One thing:** no opportunistic fixes. Two parked bugs live in this exact area (`docs/bug-ops-quote-typing-flicker.md`, `docs/bug-ops-quote-typed-location-no-autodistance.md`) — do NOT fix them, do NOT regress current behavior around them.
- **GC-14 Shared-tree discipline:** stage files by explicit path; never `git add -A`.

## File Structure

- `api/src/quote/types.ts` — add `Ride`, `ChauffeurRideDay`, widen `QuoteRequest`, add `normalizeRide`/`normalizeChauffeurDay` + `rideRawKm` helper.
- `api/src/quote/goldens.test.ts` + `api/src/quote/__snapshots__/goldens.test.ts.snap` — Phase 0 corpus (new).
- `api/src/quote/private.ts` — ride-aware pricing.
- `api/src/quote/chauffeur.ts` — per-day segment-sum buffering.
- `api/src/quote/engine.ts` — normalize at entry; protected minimum / cost per ride.
- `api/src/quote/breakdown.ts` — second raw-request consumer; shares the normalizer.
- `api/src/routes/internalQuote.ts` — ToolLegSchema widening, per-segment resolve, `toEngineRequest` rides.
- `api/src/routes/ops-ui.html` — per-segment state model + stop-list UI.
- `web-tests/e2e/*.spec.js` — selector migration + new mixed manual/auto spec.
- `index.html` (or the page hosting the transfer route picker) — Phase 3a signpost copy.
- Existing test files updated per the spec's blast-radius list: internal-helper suites (`private.test.ts`, `chauffeur.test.ts`, `breakdown.test.ts`) may update to new signatures; black-box suites (`engine.test.ts`, `quote.test.ts`, `internalQuote.test.ts`, `quotedTotal.test.ts`, `smoke.test.ts`, `services/pricing.test.ts` black-box parts) must pass **unchanged**.

---

## Phase 0 — golden fixtures (MUST land before any engine change)

### Task 1: Golden snapshot corpus from the pre-change engine

**Files:**
- Create: `api/src/quote/goldens.test.ts`
- Created by vitest: `api/src/quote/__snapshots__/goldens.test.ts.snap` (committed)

**Interfaces:**
- Consumes: `quote()` from `./engine`, `quoteBreakdown()` from `./breakdown` — **as they exist today, unmodified**.
- Produces: a committed snapshot file that Tasks 2–5 must keep passing without regeneration.

The corpus must cover every output-shaping code path of the current engine, because Phase 1 rewrites its internals. One `expect(quote(req)).toMatchSnapshot()` per request, plus `expect(quoteBreakdown(req)).toMatchSnapshot()` for each private/chauffeur request.

- [ ] **Step 1: Write the test file**

```ts
// api/src/quote/goldens.test.ts
// Phase 0 of docs/superpowers/specs/2026-07-20-multi-stop-rides-design.md.
// Snapshots are captured from the PRE-ride-model engine and are the equivalence
// contract for the refactor: the new engine must reproduce every one deep-equal.
// NEVER regenerate these to make a diff pass — a golden diff is a bug in new code.
import { describe, it, expect } from 'vitest';
import { quote } from './engine';
import { quoteBreakdown } from './breakdown';
import type { QuoteRequest } from './types';

const GOLDEN_REQUESTS: Record<string, QuoteRequest> = {
  // long single leg, no floor
  private_car_single_long: { product: 'private', vehicle: 'car', pax: 2, bags: 2,
    legs: [{ from: 'Colombo Airport (CMB)', to: 'Ella', distanceKm: 205 }] },
  // short single leg — floor hit, captures the no-space warning string byte-for-byte
  private_car_single_floor: { product: 'private', vehicle: 'car', pax: 2, bags: 2,
    legs: [{ from: 'Dambulla', to: 'Habarana', distanceKm: 23 }] },
  // the spec §4 worked-example day quoted the OLD way (2 legs, 2 buffers, floor on leg 2)
  private_car_two_legs_spec_example: { product: 'private', vehicle: 'car', pax: 2, bags: 2,
    legs: [{ from: 'Kandy', to: 'Dambulla', distanceKm: 72 }, { from: 'Dambulla', to: 'Habarana', distanceKm: 23 }] },
  // multi-leg van with extras
  private_van_three_legs_extras: { product: 'private', vehicle: 'van', pax: 5, bags: 5,
    legs: [
      { from: 'Colombo Airport (CMB)', to: 'Kandy', distanceKm: 115 },
      { from: 'Kandy', to: 'Nuwara Eliya', distanceKm: 77 },
      { from: 'Nuwara Eliya', to: 'Ella', distanceKm: 56 },
    ], extras: ['sightseeing', 'waiting'] },
  // capacity upgrade path (car requested for 6 pax → van) + its warning
  private_upgrade_car_to_van: { product: 'private', vehicle: 'car', pax: 6, bags: 4,
    legs: [{ from: 'Galle', to: 'Mirissa', distanceKm: 45 }] },
  // custom-priced tier with operator rate (GL-1d)
  private_van14_custom_rate: { product: 'private', vehicle: 'van14', pax: 12, bags: 10,
    legs: [{ from: 'Colombo', to: 'Kandy', distanceKm: 115 }], customPerKmCents: 120 },
  // zero-distance leg (post-deploy-review guard: floors, doesn't crash)
  private_car_zero_km: { product: 'private', vehicle: 'car', pax: 1, bags: 0,
    legs: [{ from: 'Fort', to: 'Fort Station', distanceKm: 0 }] },
  // chauffeur: 5-day span, 3 travel days → 2 idle days; includes an included-extra warning
  chauffeur_van_span_idle: { product: 'chauffeur', vehicle: 'van', pax: 4, bags: 4,
    firstDate: '2030-01-10', lastDate: '2030-01-14',
    travelDays: [
      { date: '2030-01-10', from: 'Colombo Airport (CMB)', to: 'Kandy', distanceKm: 115 },
      { date: '2030-01-12', from: 'Kandy', to: 'Ella', distanceKm: 137 },
      { date: '2030-01-14', from: 'Ella', to: 'Colombo', distanceKm: 210 },
    ], extras: ['sightseeing', 'childSeat'] as QuoteRequest extends never ? never : any },
  // chauffeur without pax/bags (back-compat: no capacity upgrade branch)
  chauffeur_car_no_pax: { product: 'chauffeur', vehicle: 'car',
    firstDate: '2030-02-01', lastDate: '2030-02-02',
    travelDays: [
      { date: '2030-02-01', from: 'Negombo', to: 'Sigiriya', distanceKm: 148 },
      { date: '2030-02-02', from: 'Sigiriya', to: 'Kandy', distanceKm: 90 },
    ] },
  // shared (untouched by the refactor, pinned anyway)
  shared_two_seats: { product: 'shared', legs: [{ routeId: 'ella-kandy', seats: 2, seatPriceCents: 2950 }] },
};

describe('golden corpus — pre-ride-model engine outputs', () => {
  for (const [name, req] of Object.entries(GOLDEN_REQUESTS)) {
    it(`quote(): ${name}`, () => {
      expect(quote(req)).toMatchSnapshot();
    });
  }
  for (const [name, req] of Object.entries(GOLDEN_REQUESTS)) {
    if (req.product === 'shared') continue;
    it(`quoteBreakdown(): ${name}`, () => {
      expect(quoteBreakdown(req)).toMatchSnapshot();
    });
  }
});
```

**Implementation notes (not optional):**
- The `extras` list must only use codes that exist in `EXTRA_CODES` (`api/src/quote/rateCard.ts`) — check the real codes before writing (`sightseeing`, `waiting`, `safari-wait` exist; verify the child-seat code's exact name, and drop the ugly cast above by using real codes; if only the three fee codes exist, use `['sightseeing']` for the chauffeur case — what matters is exercising the CHAUFFEUR_INCLUDED_EXTRAS branch, which `sightseeing` does).
- Dates are fixed far-future literals — the engine treats chauffeur dates as pure day-spans, so **no date-rot risk** (the date-bomb rule applies to booking-route tests hitting date validation; these never do). Confirm no `min-date` validation runs inside `quote()` — it does not.
- Verify with a floor calculation that `private_car_single_floor` genuinely floors and `private_car_two_legs_spec_example`'s second leg floors (23 km + 5 buffer = 28 km × rate < floor for the car tier) so the warning string is captured in the snapshot. If the current rate card's numbers make it not floor, shrink the km until it does.

- [ ] **Step 2: Run, generate snapshots, eyeball them**

Run: `cd api && npx vitest run src/quote/goldens.test.ts`
Expected: all tests pass, `__snapshots__/goldens.test.ts.snap` created. **Open the snap file and verify**: the no-space warning `Dambulla→Habarana hit the $… minimum` appears; labels use `A → B (vehicle)` spaced form; meta has `distanceKm`/`billableKm`/`vehicle` and nothing else.

- [ ] **Step 3: Full check**

Run: `cd api && npm run check`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add api/src/quote/goldens.test.ts api/src/quote/__snapshots__/goldens.test.ts.snap
git commit -m "test(quote): golden corpus pinning pre-ride-model engine outputs (phase 0)"
```

---

## Phase 1 — engine

### Task 2: Ride types + normalizer

**Files:**
- Modify: `api/src/quote/types.ts`
- Create: `api/src/quote/rides.test.ts`

**Interfaces:**
- Produces (later tasks rely on these exact names):
  - `interface Ride { stops: string[]; segmentKms: number[] }`
  - `interface ChauffeurRideDay extends Ride { date: string }`
  - `QuoteRequest` private arm: `legs: (PrivateLeg | Ride)[]`; chauffeur arm: `travelDays: (ChauffeurTravelDay | ChauffeurRideDay)[]`
  - `function normalizeRide(leg: PrivateLeg | Ride): Ride`
  - `function normalizeChauffeurDay(day: ChauffeurTravelDay | ChauffeurRideDay): ChauffeurRideDay`
  - `function rideRawKm(ride: Ride): number` — `segmentKms` sum
  - `function validateRide(ride: Ride): void` — throws `Error('INVALID_RIDE')` on: `stops.length < 2`, `segmentKms.length !== stops.length - 1`, any consecutive pair equal after `.trim()`, any segment km `< 0` or not finite. (The 8-stop cap is an OPS-SCHEMA rule, not an engine rule — the engine accepts any length ≥ 2.)

- [ ] **Step 1: Write failing tests** in `api/src/quote/rides.test.ts`: old-shape leg normalizes to `{ stops: [from, to], segmentKms: [distanceKm] }`; a `Ride` passes through **by reference-equal fields** (no copy drift); `normalizeChauffeurDay` keeps `date`; `rideRawKm` sums; `validateRide` throws on each invalid case above and accepts an out-and-back `['A','B','A']`.
- [ ] **Step 2: Run to see them fail** (`npx vitest run src/quote/rides.test.ts` — fails: not exported).
- [ ] **Step 3: Implement** in `types.ts`. Discriminate shapes with `'stops' in leg`.
- [ ] **Step 4: Green + full check** (`npm run check` — goldens untouched, still green).
- [ ] **Step 5: Commit** `feat(quote): Ride types + normalizer (phase 1)` — stage `types.ts`, `rides.test.ts` by path.

### Task 3: Ride-aware pricers (private.ts + chauffeur.ts)

**Files:**
- Modify: `api/src/quote/private.ts`, `api/src/quote/chauffeur.ts`
- Modify: `api/src/quote/private.test.ts`, `api/src/quote/chauffeur.test.ts` (internal-helper suites — signature updates allowed)

**Interfaces:**
- Consumes: `Ride`, `ChauffeurRideDay`, `rideRawKm` from `./types` (Task 2).
- Produces: `quotePrivateLegs(legs: Ride[], vehicle, perKmCentsOverride?, rateCard?)` — same return shape as today; `quoteChauffeur` input `travelDays: ChauffeurRideDay[]` — same return shape. `billableKm` and `legPriceCents` exports unchanged. **Callers (engine) normalize before calling; the pricers only ever see rides.**

Per-ride private pricing (GC-2/3/4/7 govern the exact strings/shapes):

```ts
for (const ride of legs) {
  const rawKm = rideRawKm(ride);
  const bKm = billableKm(rawKm, rateCard);
  const amountCents = legPriceCents(bKm, vehicle, perKmCentsOverride, rateCard);
  if (amountCents === floor && Math.round(bKm * rate) < floor) {
    warnings.push(ride.stops.length === 2
      ? `${ride.stops[0]}→${ride.stops[1]} hit the ${dollars} ${vehicle} minimum`   // byte-exact legacy form
      : `${ride.stops.join(' → ')} hit the ${dollars} ${vehicle} minimum`);
  }
  const meta: Record<string, unknown> = { distanceKm: rawKm, billableKm: bKm, vehicle };
  if (ride.stops.length >= 3) { meta.stops = ride.stops; meta.segmentKms = ride.segmentKms; }  // GC-4
  lineItems.push({ label: `${ride.stops.join(' → ')} (${vehicle})`, amountCents, meta });
  subtotalCents += amountCents;
}
```

Chauffeur: `travelKm = Σ rideRawKm(day)`; `bufferedTravelKm = Σ billableKm(rideRawKm(day))`. Everything else in `quoteChauffeur` unchanged.

- [ ] **Step 1: Write failing tests** (in the two internal suites): multi-stop ride 72+23 km car prices as ONE day — 95 raw + 10 buffer = 105 km × 40.25¢ = **$42.26** (4226 cents; use the live rate card's numbers — if perKm ≠ 40.25¢ compute the expected from `RATE_CARD`, don't hardcode the spec's example blindly); out-and-back 47+47 floors once not twice; 2-stop ride equals today's leg output exactly; floor-hit warning spaced form for 3 stops, no-space form for 2; chauffeur day with 2 segments buffers ONCE on the sum.
- [ ] **Step 2: Red** — types don't accept rides yet.
- [ ] **Step 3: Implement** as above (update the two pricers' input types to `Ride[]` / `ChauffeurRideDay[]`; existing tests in these suites that construct `{from,to,distanceKm}` update to call through `normalizeRide` or construct rides directly).
- [ ] **Step 4: Green.** `npm run check` will FAIL at this point only if engine.ts/breakdown.ts call sites don't compile — if so, do the minimal call-site fix `legs.map(normalizeRide)` in `engine.ts`/`breakdown.ts` **without changing their math** (protected-minimum/cost/breakdown still per-element = per-ride, which is correct), and confirm goldens still pass. Goldens green is the gate.
- [ ] **Step 5: Commit** `feat(quote): per-ride pricing in private + chauffeur pricers (phase 1)`.

### Task 4: Engine + breakdown integration

**Files:**
- Modify: `api/src/quote/engine.ts`, `api/src/quote/breakdown.ts`
- Modify: `api/src/quote/breakdown.test.ts` (internal suite), add cases to `api/src/quote/engine.test.ts` (black-box additions only — existing cases must not change)

**Interfaces:**
- Consumes: Task 2 normalizers, Task 3 pricers.
- Produces: `quote(req)` normalizes `req.legs`/`req.travelDays` once at entry (`const rides = req.legs.map(normalizeRide)` — validateRide each) and passes rides everywhere; `protectedMinimumCents = rides.length × floorCents[vehicle]`; `costCents = Σ round(billableKm(rideRawKm(r)) × costPerKm)`. `quoteBreakdown(req)` normalizes identically (it is the second raw-request consumer — ops `/estimate` calls it directly); `LegBreakdown` gains optional `stops?: string[]` (set only when ≥3 stops, GC-4), `from`/`to` = first/last stop always, `distanceKm` = segment sum, `billableKm` = per-ride buffered.

- [ ] **Step 1: Write failing black-box tests** (new cases in `engine.test.ts` + `breakdown.test.ts`): a private request mixing one old-shape leg and one 3-stop ride prices correctly (floors counted per ride: 2); protected minimum for 2 rides = 2 × floor (verify via the price-finishing guard or margin, however observable — if not observable black-box, assert via a floor-heavy request whose finished total proves the minimum); `quoteBreakdown` on a 3-stop ride returns one row with `from='Kandy'`, `to='Habarana'`, `stops` present, `distanceKm=95`, `billableKm=105`, `minApplied=false`; on old-shape input the row shape has NO `stops` key.
- [ ] **Step 2: Red.**
- [ ] **Step 3: Implement.** In `engine.ts`, normalize immediately after the product branch entry (private: before `selectVehicle` is fine; the legs are only read for pricing/cost/minimum). In `breakdown.ts`, normalize `src` and build rows per ride.
- [ ] **Step 4: Green + `npm run check`.** Goldens deep-equal is the headline assertion — run `npx vitest run src/quote/goldens.test.ts` and paste its output in the report.
- [ ] **Step 5: Commit** `feat(quote): normalize rides at engine + breakdown entry (phase 1)`.

### Task 5: Phase-1 safety pins — /bookings/trip pin test + §1 sample itinerary fixture

**Files:**
- Modify: `api/src/services/pricing.test.ts` (add pin test) — or `api/src/routes/bookings` test file if pricing.test.ts doesn't exercise `priceTrip`; find the existing `priceTrip` coverage and put it beside it.
- Create: `api/src/quote/sampleItinerary.test.ts`

**Interfaces:** consumes only public APIs (`priceTrip`, `quote`).

- [ ] **Step 1: Pin test (spec §8, the "website untouched" hinge):** a 3-stop `TripInput` through `priceTrip` with two short hops (each under the floor) must price as **2 floored pairwise legs** — total = 2 × floor — never one collapsed ride. Use the offline maps adapter/fake the existing tests use. Assert the exact cents.
- [ ] **Step 2: Sample itinerary fixture:** the spec §1 table as 7 rides priced `product:'private'` in one request (19 Aug = `['Kandy','Dambulla Cave Temple','Habarana']`, 21 Aug = out-and-back, 22 Aug = 4-stop hybrid; km via reasonable literals) — assert per-ride line items = 7, floors applied per ride, and the two worked-example day totals from §4 (computed from the live rate card, not hardcoded if the card differs). Then the same span as chauffeur: `firstDate` 2030-08-16, `lastDate` 2030-08-25 (shifted to future-fixed year), 8 travel days (7 + the 17 Aug `train_support` reposition day as its own old-shape day), assert `days=10`, `idleDays=2`.
- [ ] **Step 3: Red → green** (these are new tests against Task 2–4 code; red proves they assert something — e.g. write them expecting collapsed-ride pricing first if needed, then correct. If they pass immediately, mutate an expectation to prove the test bites, then restore).
- [ ] **Step 4: `npm run check` + commit** `test(quote): trip pin + sample-itinerary fixtures (phase 1)`.

**Phase 1 exit gate (controller):** goldens green · black-box suites (`engine.test.ts`, `quote.test.ts`, `internalQuote.test.ts`, `quotedTotal.test.ts`, `smoke.test.ts`) pass **with zero edits to pre-existing cases** (`git diff` those files must show only additions) · `npm run check` green.

---

## Phase 2 — ops tool

### Task 6: Ops route — schema widening + per-segment resolve

**Files:**
- Modify: `api/src/routes/internalQuote.ts`
- Modify: `api/src/routes/internalQuote.test.ts` (additions; existing cases unchanged)

**Interfaces:**
- Consumes: `Ride`, `normalizeRide` (Task 2).
- Produces (ops wire contract, consumed by Task 7's UI):
  - `ToolLegSchema` gains: `stops: z.array(z.string()).min(2).max(8).optional()` and `segmentKms: z.array(z.number().min(0).nullable()).optional()`.
  - Cross-field rules (superRefine on the leg): if `stops` present → `segmentKms` absent or length `stops.length - 1`; consecutive trimmed stops differ; `category` ≠ `stay_day` (GC-9: a stay_day carrying `stops` is a 400 with a human message).
  - Resolution: in `resolveAndPrice`, a driving leg **with stops** resolves every segment whose km is `null` or `<= 0` via one `maps.distance(stops[i], stops[i+1])` per segment (sequential loop, mirroring `resolveLegKm`'s error message per failing PAIR: ``couldn't find the distance for ${from} → ${to} — enter the km manually``); mutates `segmentKms` in place to resolved numbers and sets `distanceKm` = segment sum (legacy mirror). A leg **without stops** takes today's path untouched.
  - `toEngineRequest`: driving leg with stops → `{ stops, segmentKms }` ride (numbers guaranteed by the resolve step); without → old shape. Chauffeur `travelDays` likewise gains ride days (`{ date, stops, segmentKms }`). Fee flags / `category` stay per-leg (= per-ride).
  - `routeVariant`/`routeOptions`: unchanged passthrough (GC-10 — the UI only sets them on 2-stop legs).

- [ ] **Step 1: Failing tests:** Zod accepts a 3-stop leg with `segmentKms: [12, null]`; rejects 9 stops, rejects length mismatch, rejects `['A','A','B']` (consecutive dup), rejects stops on stay_day; `/estimate` with a 3-stop leg (offline maps adapter) resolves the null segment and returns ONE line item labeled `A → B → C (car)`; a mixed manual/auto leg (`[40, null]`) keeps the manual 40 and resolves only the null; old-shape request round-trips identically (pin against a pre-task response captured in the test); `/save` persists `request.tool` with stops and `request.engine` with the ride, and reopening (GET /:id) echoes them.
- [ ] **Step 2: Red → implement → green.**
- [ ] **Step 3: `npm run check` + commit** `feat(ops): multi-stop legs in the quote tool API (phase 2)`.

### Task 7: ops-ui.html — per-segment state model

**Files:**
- Modify: `api/src/routes/ops-ui.html` (state/model code only — render comes in Task 8, but the two land as separate commits in one task if the file can't compile-run split; keep the commits separate regardless)

This is the spec's declared cost center. The leg's scalar distance state becomes per-segment arrays.

**State contract (Task 8 + e2e depend on these exact names):**
- `newLeg()` gains `stops: ['', '']` and `segments: [newSegment()]`; the legacy scalar fields (`pickupLocation`, `dropoffLocation`, `distanceKm`, `driveTimeHours`, `manualDistance`, `autoMatched`, `routeVariant`, `routeOptions`, `_sameRoute`, `_promptedRouteChoice`) are **removed from the leg** and live per segment:
  `function newSegment() { return { km: 0, driveTimeHours: 0, manual: false, autoMatched: false }; }`
  Route-choice state (`routeVariant`, `routeOptions`, `_sameRoute`, `_promptedRouteChoice`) stays **leg-level** but is only ever set when `leg.stops.length === 2` (GC-10).
- Accessors used everywhere a scalar was read: `legFrom(leg)` = `stops[0]`, `legTo(leg)` = `stops[stops.length-1]`, `legKm(leg)` = sum of resolved segment km (0 if any driving segment unresolved), `legDriveHours(leg)` = sum. Sweep EVERY reader of `pickupLocation`/`dropoffLocation`/`distanceKm`/`driveTimeHours`/`manualDistance`/`autoMatched` in the file (grep; ~60 sites incl. `buildToolRequest` ×2 (≈ lines 2228, 2724), reopen mapping (≈2893), long-drive flag (≈3562), undistanced counter (≈3430), dist-check flag (≈3648), `routeText` (≈3771), `itinStops` (≈5203), `hasBuiltItinerary` (≈4381), airport-detection scan (≈4169), `addLeg` chain-from-previous (≈2485), autocomplete pick/blur handlers (≈4942, 5410, 5546)).
- **Structural invalidation** (spec §5): `function rebuildSegments(oldStops, oldSegments, newStops)` — for each new pair `(newStops[i], newStops[i+1])`, consume the first unconsumed old segment whose old pair matches exactly (trimmed); matched segments carry km/duration/manual/autoMatched over; unmatched → `newSegment()`. Every stop edit/insert/delete/reorder goes through it. A stop text edit at index i is a stops-array replace → rebuild (pairs i-1 and i naturally reset).
- `dupLeg` **deep-clones**: `copy.stops = src.stops.slice(); copy.segments = src.segments.map(s => Object.assign({}, s));` and deep-copies `routeOptions`.
- `addLeg` chains `leg.stops[0] = prev last stop`; stay_day keeps the single-location behavior via `stops:['',''],` untouched semantics (stay_day UI never shows stop controls, GC-9).
- **Reopen mapping** (client-side normalizer — must agree with the server's): `var stops = tl.stops || [tl.from || '', tl.to || '']; var kms = tl.segmentKms || [tl.distanceKm || 0];` each segment: `km = kms[i] || 0; manual = (kms[i] || 0) > 0;` (per-segment carry-over of the existing `>0 ⇒ manual` rule). Route-choice restore only when `stops.length === 2`.
- `buildToolRequest` sends per driving leg: `stops`, `segmentKms` (manual/resolved → number; unresolved auto → `null`), plus legacy mirror `from`/`to`/`distanceKm(sum or 0)`; stay_day sends legacy fields only.
- **Resolve pipeline** (`runAutoDistance` ≈5015): per-segment — resolve each unresolved, non-manual segment pair; the debounce/cache re-keys by `(from, to)` pair string; route-compare (`compareRoutes`, `openRouteModal`, `maybeOfferRouteChoice` ≈5059) short-circuits unless `stops.length === 2`; the manualDistance action (≈4867) and the `distanceKm`/location-change patches (≈4942, 5410, 5546) become per-segment (add `data-seg` index alongside `data-leg` — Task 8 wires the DOM).
- Adding a 3rd stop to a leg with route state clears `routeVariant`/`routeOptions`/`_sameRoute`/`_promptedRouteChoice`.

- [ ] **Step 1:** Implement the state model + all readers/writers sweep. There is no unit-test harness inside ops-ui.html; correctness is proven by Task 6's API tests + Task 9's e2e + a manual smoke: `cd api && npm run dev`, open `/ops`, build a 2-stop quote → identical behavior to before (autocomplete, auto-distance, route compare, manual edit, save, reopen).
- [ ] **Step 2:** `npm run check` (ops-ui is embedded in the api routes — the check must stay green) + commit `feat(ops-ui): per-segment leg state model (phase 2)`.

### Task 8: ops-ui.html — stop-list UI

**Files:**
- Modify: `api/src/routes/ops-ui.html` (render + handlers)

**DOM contract (Task 9's e2e depends on it):**
- Stop inputs: `data-leg="<id>" data-field="stop" data-stop="<index>"` (replaces the two-value `data-field="pickupLocation"|"dropoffLocation"` enum). Focus-restore, autocomplete attach (`_menuWasOpen` guard ≈4667, selector build ≈4684/4714/5584), and location-sync-on-pick/blur generalize to every stop input.
- Per-leg controls: "+ stop" (inserts before the last stop), per-stop remove (only when >2 stops), reorder via existing move affordances if trivial — otherwise skip reorder UI (the model supports it; UI reorder is not in the spec's DoD), **"and return"** button that appends a copy of `stops[0]` (pure sugar).
- Per-segment km display: each segment renders its km pill / manual-edit input with `data-seg` index (`data-action="manualDistance" data-leg data-seg`); the per-ride drive-time total feeds the existing ≥6 h long-drive flag; unresolved segments show the existing "set" affordance.
- Route-compare button/modal render **only when** `stops.length === 2` (GC-10).
- `routeText(leg)` (≈3771) = `stops.join(' → ')` + the existing route-variant suffix (2-stop only) — this single choke point updates the leg card title, map captions, and WhatsApp/email quote message together. **DoD includes eyeballing the generated quote message at 4 stops** (paste the rendered message in the task report).
- Map: `itinStops()` returns the flattened stop sequence (all stops, not just endpoints) — `drawItinRoute` already renders waypoints.
- stay_day cards: unchanged single-location UI (no stop controls).

- [ ] **Step 1:** Implement render + handlers. Manual smoke in the browser: quote the spec §1 19-Aug day (3 stops) and 21-Aug out-and-back via "and return"; verify ONE line item each in the money pane, per-segment km pills, drive-time sum, map waypoints, quote message text.
- [ ] **Step 2:** `npm run check` + commit `feat(ops-ui): stop-list editor UI (phase 2)`.

### Task 9: e2e migration + new coverage + known-places pre-check

**Files:**
- Modify: every `web-tests/e2e/*.spec.js` using `data-field="pickupLocation"`/`"dropoffLocation"` (grep — spec says ~9 files; migration to the `data-field="stop"` + `data-stop` contract is **in-scope work, not incidental breakage**)
- Create: `web-tests/e2e/quote-tool-multistop.spec.js`
- Modify (if gaps found): `KNOWN_PLACES` in `api/src/adapters/maps.ts`

- [ ] **Step 1: Selector migration.** Mechanical sweep; every migrated spec must pass: `cd web-tests && npm run test:e2e:tool && npm run test:e2e:ops` (CH_E2E_API specs boot the api server; the 8787-squatter globalSetup guard exists — if specs fail with `#login not found`, check the port, don't debug blind).
- [ ] **Step 2: New spec** covering: build a 3-stop leg; one segment manual + one auto (mixed); "and return"; reopen an old-shape saved quote (2-stop) and verify it reprices identically; save + reopen a multi-stop quote.
- [ ] **Step 3: Known-places pre-check (spec §5):** compare `KNOWN_PLACES` against the attraction-type stops in the spec §1 itinerary (Dambulla Cave Temple, Polonnaruwa, Thanthirimale, Anuradhapura, Nilaveli Beach) + obvious POI gaps; add missing entries with coords following the file's existing pattern. Keep it to genuinely obvious gaps — a catalog audit is not this task.
- [ ] **Step 4:** Full suite green: `cd web-tests && npm run test:all` and `cd api && npm run check`. Commit `test(e2e): stop-list selector migration + multi-stop coverage (phase 2)` (separate commit for the maps.ts additions: `feat(maps): known-place POIs for multi-stop itineraries`).

**Phase 2 exit gate (controller):** the spec §7 DoD — quote the §1 sample itinerary as 7 rides in one quote (manual smoke, screenshot in the phase report), old stored quote reopens + reprices identically (e2e), quote-message rendering eyeballed at 4 stops, full e2e suite green.

---

## Phase 3a — website signpost

### Task 10: Signpost copy

**Files:**
- Modify: the page hosting the transfer route picker (locate the `#add-stops` affordance the spec names near `search.html` / the homepage booker — grep the front-end for `add-stops`; the copy goes near it)
- Modify (only if a copy test exists for that section): the matching `web-tests/unit` spec

- [ ] **Step 1:** Add one line of copy: *"Want a stop along the way, a day trip and back, or a longer route? Message us — we'll price it in minutes."* linking the existing contact/WhatsApp affordance (reuse the exact `wa.me` link pattern already on the page — do not invent a new number). Styling: match surrounding classes; no new CSS beyond what placement needs. **Restyle-contract reminder:** hero redesign contract forbids touching booker JS/image-slot bg; SEO guard forbids the string "4.9" in index.html.
- [ ] **Step 2:** `cd web-tests && npm run test:all` green (booking flow untouched — any failure is a regression, stop and report).
- [ ] **Step 3:** Commit `feat(site): multi-stop signpost copy (phase 3a)`.

---

## Final gate (controller)

1. Whole-branch adversarial review (superpowers:requesting-code-review, most capable model), explicitly hunting: golden regeneration cheating, black-box test edits, `/quote` public schema widening, meta-shape drift on 2-stop output, per-segment invalidation holes, route-choice regressions, e2e selector coverage gaps.
2. `cd api && npm run check` + `cd web-tests && npm run test:all` from clean.
3. Phase PRs opened per the branch mechanics above; staging soak + prod promote are owner-gated follow-ups, NOT part of this plan.
