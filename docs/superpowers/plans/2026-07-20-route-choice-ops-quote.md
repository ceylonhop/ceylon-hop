# Route Choice (Compare Routes Button) — Ops Quote Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **v2 of this plan (2026-07-20, same day):** supersedes the auto-detection design after owner
> critique + a deep review against `origin/main`. Changes: on-demand **Compare routes button**
> instead of automatic toggle (no allowlist, no aliases, no auto-gate); leg field is
> `driveTimeHours` not `durationMin`; cache successes only; store offered options for
> conversion analytics; routeVariant cleared at all three reset sites; both payload builders.

**Goal:** A *Compare routes* button on any driving leg in the ops quote tool: click → both the
default (expressway) and toll-free (local road) routes appear with km + hours → the operator
picks one → the price re-computes from the chosen km (e.g. Ella ≈ $140 / 5.5 h vs ≈ $98 / 6.5 h).

**Architecture:** On demand only — no automatic detection. The button POSTs the existing
`/admin/quote/distance` endpoint with `compare: true`, which calls a new additive
`distanceVariants()` adapter method (two parallel Distance Matrix calls, the second with
`&avoid=tolls`). The chosen variant + both offered options ride inside the leg object in
`requestJson` (jsonb) — **no schema migration**. Pricing untouched: the engine is duration-blind
and km-only (verified 2026-07-20 deep review), so the chosen `distanceKm` inherits every guard
(floors, buffer, margin, nearest-50¢ finishing) with zero engine/rate-card changes.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Vitest (`api/`) · vanilla JS in
`api/src/routes/ops-ui.html` · Playwright e2e in `web-tests/` (`CH_E2E_API=1` harness,
dev-login bypass).

## Global Constraints

- **Build from fresh `origin/main` in an isolated worktree** — the shared tree sits on stale
  `codex/discount-spec` (ops-ui.html is 1,200+ lines behind). All anchors below were verified
  against `origin/main` on 2026-07-20; re-grep the quoted markers, don't trust line numbers.
- One task = one branch = one PR. Adapter interface change is its own task (hard rule 5).
- `cd api && npm run check` green before every commit; `npm run test:all` green for Task 3.
- Stage files by path only — never `git add -A` (shared tree).
- No real external services in tests: Google via stubbed `fetch`; e2e on `FakeMapsAdapter`.
- **Owner gates:** WhatsApp copy wording (Task 3 Step 6) and the prod promote (Task 4).
- Out of scope: customer website/booker (Phase 2, own plan — hazards catalogued in the
  2026-07-20 deep review: baked route-page prices, `kms` URL param, e2e single-route mocks,
  `services/pricing.ts` threading), shared rides, toll prices, Routes API migration,
  auto-detection/allowlists (Phase 2 candidates), any change to auto-resolve (`runAutoDistance`
  stays single-call).

---

## Task 0: Live-API spike (go/no-go gate — approved by owner 2026-07-20)

**Files:** scratch only, nothing committed. Results pasted into PR 1's description.

- [ ] **Step 1:** Locate the real key (`GOOGLE_MAPS_API_KEY` — `api/.env` locally, else Render
  env). For each pair below, call Distance Matrix twice (default and + `&avoid=tolls`),
  using `COORDS` values from `api/src/adapters/maps.ts`:
  - Colombo City (6.93,79.85) → Ella (6.87,81.05) — expect ~290 km/5.5 h vs ~205 km/6.5 h
  - Colombo Airport (7.18,79.88) → Galle (6.03,80.22) — expect big duration gap, similar km
  - Colombo City → Yala (6.37,81.52) — expect E01-extension difference
  - Kandy (7.29,80.63) → Sigiriya/Dambulla (7.95,80.76) — negative control, expect ~no gap
- [ ] **Step 2:** Record all 8 km/duration results.
- **Gate:** proceed if the 3 positive pairs show ≥ 30 min gaps and the control shows ~none.
  Otherwise stop — owner decision on next step.

---

## Task 1: `MapsAdapter.distanceVariants()` (adapter interface step) → PR 1

**Files:**
- Modify: `api/src/adapters/maps.ts`
- Test: `api/src/adapters/maps.test.ts`
- Touch (typecheck only): counting adapter doubles in `api/src/routes/bookings.test.ts`,
  `api/src/routes/trip.test.ts` — add the method by delegation to their wrapped fake.

**Interfaces produced (Tasks 2–3 rely on these exact shapes):**

```ts
export interface RouteVariants {
  fastest: DistanceResult;          // always present when the pair resolves at all
  noTolls: DistanceResult | null;   // present ONLY when it is a materially different road
  hasChoice: boolean;               // noTolls !== null
}
// added to MapsAdapter:
distanceVariants(from: string, to: string): Promise<RouteVariants | null>;
export const CHOICE_MIN_TIME_SAVED_MIN = 30;  // display rule: below this, report "same route"
```

- [ ] **Step 1: Failing tests** (append to `maps.test.ts` in its existing stubbed-`fetch`
  style — build helpers mirroring the file's current OK-payload pattern):

```ts
describe('distanceVariants', () => {
  it('fires two Distance Matrix calls, exactly one with avoid=tolls', async () => {
    /* stub fetch capturing URLs; call distanceVariants('Colombo City','Ella');
       expect 2 URLs, exactly 1 containing 'avoid=tolls', both containing '6.93,79.85' (known
       coords substitution applies to BOTH calls) */
  });
  it('reports a choice when the toll-free route is ≥30 min slower', async () => {
    /* fastest 292km/330min, noTolls 205km/390min → { hasChoice: true, noTolls: {km:205,durationMin:390} } */
  });
  it('reports NO choice when routes are near-identical', async () => {
    /* 90km/150min vs 90km/155min → hasChoice false, noTolls null */
  });
  it('degrades to no-choice when the avoid=tolls call fails', async () => {
    /* fastest ok, second rejects → { fastest, noTolls: null, hasChoice: false } */
  });
  it('never claims a choice off the offline fallback', async () => {
    /* both calls fail, known pair → fastest from offlineEstimate, hasChoice false */
  });
  it('applies MAX_SL_ROAD_KM to the toll-free result too', async () => {
    /* second call returns 10,284 km → hasChoice false */
  });
  it('caches successful comparisons (no refetch on second call)', async () => {
    /* two full successes → second distanceVariants() call makes 0 fetches */
  });
  it('does NOT cache failures — a Google blip must not hide the local road for 24h', async () => {
    /* first attempt: second call fails; second attempt: both succeed → hasChoice true.
       Total fetches: 4 (nothing served from cache after the failure) */
  });
  it('FakeMapsAdapter returns synthetic choice pairs both ways (Colombo City↔Ella, Airport↔Galle)', async () => {});
  it('FakeMapsAdapter returns no-choice offline estimate for other known pairs', async () => {});
});
```

- [ ] **Step 2:** `cd api && npx vitest run src/adapters/maps.test.ts` — FAIL
  (`distanceVariants is not a function`).
- [ ] **Step 3: Implement:**

```ts
// GoogleMapsAdapter:
//  - refactor: private googleDistance(from, to, avoidTolls = false) — appends '&avoid=tolls';
//    timeout, HTTP/status checks, known-coords substitution, MAX_SL_ROAD_KM all shared.
//  - private variantsCache = new Map<string, { expires: number; value: RouteVariants }>();
async distanceVariants(from: string, to: string): Promise<RouteVariants | null> {
  const key = `${norm(from)}|${norm(to)}`;
  const hit = this.variantsCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const [fast, slow] = await Promise.all([
    this.googleDistance(from, to),
    this.googleDistance(from, to, true),
  ]);
  const fastest = fast ?? offlineEstimate(from, to);
  if (!fastest) return null;
  // A choice requires BOTH answers from Google (never the offline estimate) + a material gap.
  const hasChoice = !!fast && !!slow &&
    slow.durationMin - fast.durationMin >= CHOICE_MIN_TIME_SAVED_MIN;
  const value: RouteVariants = { fastest, noTolls: hasChoice ? slow : null, hasChoice };
  // Cache ONLY full successes: a failed/partial comparison must be retryable immediately.
  if (fast && slow) {
    if (this.variantsCache.size >= 500) this.variantsCache.clear();
    this.variantsCache.set(key, { expires: Date.now() + 24 * 60 * 60 * 1000, value });
  }
  return value;
}

// FakeMapsAdapter — synthetic pairs so keyless dev + e2e exercise the picker (owner's real
// corridor figures, 2026-07-20):
const FAKE_VARIANT_PAIRS: [string, string, DistanceResult, DistanceResult][] = [
  ['colombo city', 'ella', { km: 292, durationMin: 330 }, { km: 205, durationMin: 390 }],
  ['colombo airport (cmb)', 'galle', { km: 148, durationMin: 120 }, { km: 130, durationMin: 205 }],
];
// FakeMapsAdapter.distanceVariants: matched pair (either ordering) → hasChoice true;
// else offlineEstimate → { fastest, noTolls: null, hasChoice: false }; unknown pair → null.
```

- [ ] **Step 4:** vitest green, pre-existing `distance()` tests untouched and green.
- [ ] **Step 5:** `cd api && npm run check` — fix the counting doubles (delegate).
- [ ] **Step 6:** Commit by path:
  `git add api/src/adapters/maps.ts api/src/adapters/maps.test.ts api/src/routes/bookings.test.ts api/src/routes/trip.test.ts`
  `git commit -m "feat(maps): distanceVariants() — on-demand default+avoid=tolls comparison with success-only cache and fake pairs"`

---

## Task 2: `/admin/quote/distance` compare mode + leg fields → PR 2

**Files:**
- Modify: `api/src/routes/internalQuote.ts`
- Test: `api/src/routes/internalQuote.test.ts`

**Interfaces produced (Task 3 relies on):**
- `POST /admin/quote/distance` body gains optional `compare: true`.
  - Without it: exactly today's behavior (single `maps.distance()` call — auto-resolve path
    untouched).
  - With it: calls `distanceVariants()`; response
    `{ km, durationMin, hasChoice, variants?: { fastest: {km,durationMin}, noTolls: {km,durationMin} } }`
    — top level = fastest (back-compat); `variants` present only when `hasChoice`.
- `ToolLegSchema` gains two optional fields (both flow verbatim into `requestJson`; neither
  affects pricing — `distanceKm` stays the sole pricing input):

```ts
routeVariant: z.enum(['fastest', 'no_tolls']).optional(),
// What was OFFERED when the operator compared — the Phase-2 conversion dataset
// ("offered both, chose X" vs "never compared").
routeOptions: z.object({
  fastest: z.object({ km: z.number(), durationMin: z.number() }),
  noTolls: z.object({ km: z.number(), durationMin: z.number() }),
}).optional(),
```

- [ ] **Step 1: Failing tests:** compare-mode returns variants for the fake Ella pair (top-level
  `km` = 292, `variants.noTolls.km` = 205); compare-mode omits `variants` + `hasChoice:false`
  for Kandy→Trincomalee; **no-compare body returns today's exact shape** (regression pin);
  estimate accepts a leg with `routeVariant`+`routeOptions` (200); estimate rejects
  `routeVariant: 'scenic'` (400); saved quote's `requestJson` leg round-trips both fields.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement (handler branches on `b.compare`;
  non-compare path character-identical to today). **Step 4:** Green. **Step 5:** `npm run check`.
- [ ] **Step 6:** Commit by path → PR 2 (depends on PR 1).

---

## Task 3: Ops-UI Compare routes button → PR 3

**Files:**
- Modify: `api/src/routes/ops-ui.html`
- Test: `web-tests/e2e/ops-quote-route-choice.spec.js` (new; reuse `ops-ui.spec.js`'s
  dev-login helper + `CH_E2E_API=1` harness)

**Behavior contract (each bullet = an e2e assertion):**
1. Any driving leg (`category !== 'stay_day'`) with both locations set shows a *Compare routes*
   link beside the distance pill (auto, manual, and reopened-manual states alike — it's an
   explicit operator action, consistent with rate-lock: reopened quotes re-estimate on the
   locked card).
2. Click on the fake Ella pair → **inline** two-pill picker (no popover — background estimate
   renders wipe floating DOM, the autocomplete-reopen gotcha class):
   `Expressway · 5 h 30 m · 292 km` / `Local road · 6 h 30 m · 205 km`. Picking *Local road*
   sets `distanceKm: 205`, `driveTimeHours: 6.5`, `routeVariant: 'no_tolls'`,
   `routeOptions: {…}`, `manualDistance: false`, `autoMatched: true`, re-estimates — total
   drops. Picking again swaps back from stored `routeOptions`, no refetch.
3. Click on a no-choice pair → transient inline note “Same route — no expressway on this trip”;
   leg unchanged.
4. **Stale-label guard (the #1 wrong-quote risk):** `routeVariant` and `routeOptions` are
   cleared at **all three** existing reset sites — (a) the location-edit patch that sets
   `manualDistance:false, autoMatched:false` and deletes `_distCache[legId]`, (b) the
   `action === 'autoDistance'` branch, (c) the resolve-failure reset
   (`distanceKm: 0, driveTimeHours: 0`). E2e: pick Local road, edit the pickup location,
   assert the pills/label are gone and the message text has no route note.
5. Manual pencil (`action === 'manualDistance'`) also clears `routeVariant` (typed km is not a
   Google route).
6. Both payload builders — estimate (`legs: st.legs.map(...)`) **and** save
   (`legs: state.legs.map(...)`) — include `routeVariant` + `routeOptions`; saved quote's
   `requestJson` verified via the API in e2e.
7. WhatsApp/copy text gains a per-leg route note only when `routeVariant` is set —
   `via expressway (E01)` / `via local road (no highway tolls)` — **OWNER GATE: wording
   approval before merge.**
8. Expected side effect, not a bug: choosing a ≥ 6 h local road trips the existing red
   *long-drive warning* (`driveTimeHours >= 6`) — assert it fires for Ella local road.

- [ ] **Step 1:** Write the e2e spec (contracts 1–6, 8). **Step 2:** `npm run test:all` — new
  spec FAILS. **Step 3:** Implement (`apiDistance` gains an optional `compare` arg passing
  `compare: true`; picker markup rendered inline in the leg-distance block; new
  `data-action="routeVariant"` branch beside `manualDistance`). **Step 4:** all green +
  `npm run check`. **Step 5:** Browser-verify in preview (fake adapter): all contracts + a
  reopened sent quote. **Step 6:** Owner approves the two copy strings. **Step 7:** Commit by
  path → PR 3 (depends on PR 2).

---

## Task 4: Staging soak + prod promote (owner-run gates)

- [ ] Merge PR 1 → 2 → 3 to `main` (auto-deploys staging: ops.staging.ceylonhop.com — first
  environment with real two-call variants).
- [ ] Soak (~2–3 days): compare Colombo→Ella (both directions), Airport→Galle, Colombo→Yala,
  one northern pair (expect "same route"), one reopened quote; **check Google's local-road km
  against what our drivers actually drive** (margin risk #7); expect the red long-drive flag on
  local-road Ella; eyeball WhatsApp text.
- [ ] Watch Sentry + Render logs for `[maps]` errors; degrade path must keep quotes flowing.
- [ ] Owner: write the one-line on-the-day route-switch policy for drivers before the first
  local-road booking goes out.
- [ ] Owner go → promote `main → production` PR. **No migration ships.**

## Open items

1. Copy wording (Task 3 Step 6) — owner.
2. On-the-day switch policy (Task 4) — owner, business not code.
3. Phase 2 (customer booker) — separate spec+plan, justified by `routeOptions` conversion data.
