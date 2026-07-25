# Founder Analytics — Funnel & Pipeline + Demand & Geography Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A founder-only “Analytics” view in `/ops` with two sub-tabs: **Funnel** (quote funnel & pipeline: KPI tiles, quotes-per-day/week chart, cohort funnel, lost reasons, pipeline aging, cycle times) and **Demand** (top destinations, corridors, rising/falling movers, service & vehicle mix, distance/pax).

**Architecture:** New `analytics:view` capability (founder-only) → new route file with `GET /admin/ops/analytics/funnel` and `GET /admin/ops/analytics/demand` → two **range-bounded** repo projections on `QuoteRepo` (`listFunnelRows` — scalars only, never `request_json`; `listDemandRows` — the only query touching `request_json`, created-in-range only) feeding **pure TS aggregation functions** `computeFunnel()` / `computeDemand()` → hand-rolled SVG charts in `ops-ui.html`. Strictly read-only. One additive migration (indexes only).

**Scaling contract (owner requirement 2026-07-23):** analytics must never slow the ops dashboard or customer site as tables/traffic grow. Hence: query cost scales with the *viewed window*, not table age; `request_json` blobs are fetched only for the demand window; hard row caps (funnel 10,000 / demand 5,000 most-recent) return `truncated: true` → visible UI banner, never silently wrong numbers; supporting indexes created now while the table is tiny; analytics fetch is lazy + founder-only with **no polling**, and a 60s client cache per tab+range. Escape hatch if p95 > ~500ms or quotes > ~20k: persist a per-quote demand summary (places/km) at save time — additive, nothing above the repo changes.

**Tech stack:** Hono + Zod + Drizzle (Postgres), Vitest, single-file vanilla-JS ops UI, Playwright e2e in `web-tests/`.

## Global constraints

- Work happens in an **isolated git worktree off `origin/main`** (shared-tree rule); stage only files this plan touches, never `git add -A`.
- Soft-deleted quotes (`deleted_at IS NOT NULL`) are excluded from every number.
- Money: integer cents; **never sum across currencies** — every money aggregate is grouped by currency.
- Day/week bucketing in **Asia/Colombo** = fixed UTC+5:30 (no DST since 2006) — shift then slice, no tz library.
- Percentage tiles with denominator n < 5 display "2 of 3", not "67%".
- Server-side enforcement: every endpoint behind `requireCap('analytics:view')`; UI gating is cosmetic only.
- Test dates: use date helpers / relative dates, never literal future dates (date-bomb rule).
- The `/admin/ops/finance/summary` stub is left untouched (retiring it is out of scope here).
- Main branch protection is strict: update-branch → CI → merge, serially.

---

### Task 1: `analytics:view` capability

**Files:**
- Modify: `api/src/lib/opsAuth.ts` (OpsAction union + founder set)
- Modify: `api/src/routes/ops.ts` (`ALL_ACTIONS` list — feeds `/whoami` caps)
- Test: `api/src/lib/opsAuth.test.ts`

**Interfaces produced:** `can(role, 'analytics:view')` → true only for `founder`; `/admin/ops/whoami` returns `analytics:view` in `caps` for founders.

- [ ] **Step 1: failing test** in `opsAuth.test.ts`:

```ts
it('analytics:view is founder-only', () => {
  expect(can('founder', 'analytics:view')).toBe(true);
  for (const r of ['finance', 'ops', 'system'] as const) expect(can(r, 'analytics:view')).toBe(false);
});
```

- [ ] **Step 2:** run `npm test -- opsAuth` in `api/` → FAIL (type error / false).
- [ ] **Step 3:** add `'analytics:view'` to the `OpsAction` union and to the `founder` set in `CAPABILITIES`; add it to `ALL_ACTIONS` in `ops.ts` (without this, whoami never sends it and the UI can't gate).
- [ ] **Step 4:** run test → PASS. Also `npm test -- ops.auth` still green (whoami shape).
- [ ] **Step 5:** commit `feat(ops): add founder-only analytics:view capability`.

### Task 2: bounded analytics projections on QuoteRepo + index migration

**Files:**
- Modify: `api/src/db/quoteRepo.ts` (row types + interface methods + InMemory impls)
- Modify: `api/src/db/postgresQuoteRepo.ts`
- Create: `api/drizzle/0021_analytics_indexes.sql` (via drizzle-kit, matching how prior index migrations were produced)
- Test: `api/src/db/quoteRepo.test.ts`

**Interfaces produced:**

```ts
export interface FunnelQuoteRow {      // scalars only — NEVER request_json/result_json
  id: string;
  status: QuoteStatus;
  product: string;
  totalCents: number;
  currency: string;
  marginCents: number | null;
  lostReason: string | null;
  createdAt: Date;
  sentAt: Date | null;
  decidedAt: Date | null;
}
export interface DemandQuoteRow {      // the ONLY projection carrying request_json
  id: string;
  status: QuoteStatus;
  product: string;
  vehicle: string | null;
  requestedService: string | null;
  totalCents: number;
  currency: string;
  createdAt: Date;
  request: unknown;                    // { tool, engine } wrapper (legacy rows may be bare)
}
// on QuoteRepo:
export type AnalyticsChannel = 'ops' | 'web' | 'all';   // web/all unused by v1 UI, keeps the
                                                        // later customer-website analytics a
                                                        // parameter instead of a rework
listFunnelRows(since: Date, limit: number, channel?: AnalyticsChannel): Promise<{ rows: FunnelQuoteRow[]; truncated: boolean }>;  // default 'ops'
listDemandRows(from: Date, to: Date, limit: number, channel?: AnalyticsChannel): Promise<{ rows: DemandQuoteRow[]; truncated: boolean }>;
```

Both restricted to non-deleted `channel='ops'` quotes (web quotes are a different funnel and would pollute win rates; owner-visible decision, see self-review). **Bounding semantics:**
- `listFunnelRows(since, limit)`: rows where `created_at >= since` OR `sent_at >= since` OR `decided_at >= since` — **OR** current status ∈ {`sent`,`pending_review`,`changes_requested`,`ready`} regardless of age (the pipeline/aging/in-review snapshots need the whole live set, which is inherently small). Caller passes `since = from − (to − from)` so the delta window is covered. Ordered `created_at` desc; `truncated = rows hit limit`.
- `listDemandRows(from, to, limit)`: rows where `created_at` between from and to only. Ordered `created_at` desc so a truncation keeps the most recent.
- The pure functions still do exact range filtering — bounding is a superset fetch, precision stays in tested TS.

Index migration `0021` (additive, instant on today's table sizes, boot-applied staging-first): btree on `quotes(created_at)`, `quotes(sent_at)`, `quotes(decided_at)`, and partial `quotes(status) WHERE deleted_at IS NULL` for the live-set arm.

- [ ] **Step 1: failing tests** (InMemory): funnel rows exclude soft-deleted + `channel:'web'`; funnel includes an OLD quote still in `sent` status (live-set arm) but excludes an old decided one; funnel rows have no `request` field; demand rows bounded to created-in-range, carry `request`/`requestedService`/`vehicle`; both honor `limit` + set `truncated`, keeping most-recent rows.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement InMemory + Postgres (Drizzle select of just those columns; `or(...)` bound conditions; `desc(quotes.createdAt)`; `limit(limit + 1)` to detect truncation). Generate migration 0021. **Step 4:** run → PASS. **Step 5:** commit.

### Task 3: pure funnel computation

**Files:**
- Create: `api/src/services/analytics/funnel.ts`
- Test: `api/src/services/analytics/funnel.test.ts`

**Interfaces produced:**

```ts
export interface AnalyticsRange { from: Date; to: Date; bucket: 'day' | 'week'; now: Date }
export function computeFunnel(rows: FunnelQuoteRow[], q: AnalyticsRange): FunnelReport;

export interface FunnelReport {
  range: { from: string; to: string; bucket: 'day' | 'week' };
  tiles: {
    created: Delta; sent: Delta;
    won: Delta; lost: Delta; expired: Delta;
    winRate: Ratio;        // won / decided-in-range
    sendRate: Ratio;       // created-in-range since sent / created
    pipeline: Snapshot;    // status='sent' NOW: count + value per currency
    inReview: Snapshot;    // pending_review|changes_requested|ready NOW
  };
  series: { bucketStart: string; created: number; sent: number; won: number }[]; // bar chart
  funnel: { created: number; sent: number; won: number };                        // cohort: of created-in-range
  lostReasons: { reason: string | null; count: number; valueCents: CurrencyMap }[];
  aging: { bucket: '0-2' | '3-7' | '8-14' | '15+'; count: number; valueCents: CurrencyMap }[];
  cycles: {
    draftToSentHours: { median: number; p90: number; n: number } | null;
    sentToDecidedDays: { median: number; p90: number; n: number } | null;
  };
}
// Delta = { value: number; prev: number }  (prev = same metric over the previous equal-length window)
// Ratio = { num: number; den: number }     (UI renders "x of y" when den < 5)
// CurrencyMap = Record<string, number>     (cents keyed by ISO currency)
// Snapshot = { count: number; valueCents: CurrencyMap }
```

Colombo helpers (shared module `api/src/services/analytics/time.ts`): `colomboDayKey(d)` = `new Date(d.getTime() + 5.5*3600e3).toISOString().slice(0,10)`; `colomboWeekKey(d)` = Monday of that shifted date. Definitions per spec §A: created = `createdAt` in range; sent tile = `sentAt` in range; won/lost/expired = `decidedAt` in range split by status; win-rate denominator = decided-in-range only; funnel is the created-in-range **cohort**; pipeline/in-review/aging are `now` snapshots ignoring the range; aging buckets by whole days since `sentAt` (0–2 = <3d, 3–7 = <8d, 8–14 = <15d, else 15+); cycles use median & p90 over transitions completed in range (`sentAt` in range for draft→sent; `decidedAt` in range for sent→decided).

- [ ] **Step 1: failing tests** — one per definition (TDD, table-driven with a `mk()` row factory using relative dates):
  1. created/sent/decided tile counts and windowing edges (createdAt exactly at `from` counts; at `to`+1ms doesn't)
  2. win-rate denominator excludes open `sent` quotes
  3. cohort funnel: quote created before range but sent in range is NOT in `funnel.sent`
  4. **Colombo midnight**: a quote at `18:45Z` buckets to the NEXT Colombo day (00:15+0530)
  5. week bucketing: Sunday 23:00 Colombo and Monday 01:00 Colombo land in different ISO weeks
  6. pipeline snapshot: only current `status='sent'`; decided absent; value grouped per currency (mixed USD+EUR rows never merge)
  7. aging boundaries: test each bucket edge
  8. lost reasons: null reason grouped separately, sorted by count desc
  9. deltas: prev window = equal length immediately before `from`
  10. cycles: median/p90 exact on odd/even n; `null` when n = 0
- [ ] **Step 2:** run → FAIL. **Step 3:** implement (single pass over rows building all buckets; no dependencies). **Step 4:** run → PASS. **Step 5:** commit.

### Task 4: leg extraction + pure demand computation

**Files:**
- Create: `api/src/services/analytics/extractLegs.ts`
- Create: `api/src/services/analytics/demand.ts`
- Test: `api/src/services/analytics/extractLegs.test.ts`, `api/src/services/analytics/demand.test.ts`

**Extraction (`extractLegs.ts`):** `request_json` is `{ tool, engine }` (internalQuote.ts:594); use `request.engine`, falling back to the bare object for legacy rows. Normalize every product shape to a uniform ride list using the existing helpers:

```ts
import { normalizeRide, normalizeChauffeurDay, rideRawKm } from '../../quote/types';

export interface ExtractedTrip {
  places: string[];                          // unique, normalized (trim, collapse spaces, title-case key) — union of all stops
  corridors: { from: string; to: string }[]; // first→last stop per ride, directional
  totalKm: number | null;                    // Σ rideRawKm over rides; null if unparseable
  pax: number | null;
}
export function extractTrip(request: unknown): ExtractedTrip | null; // null = unparseable/shared
```

- `product:'private'` → `legs[]` via `normalizeRide`; `product:'chauffeur'` → `travelDays[]` via `normalizeChauffeurDay`.
- **`product:'shared'` returns `null`** — shared legs are `routeId`-based (no place names); shared quotes still count in service/vehicle mix (from the row columns), just not in destination/corridor charts. A "based on N quotes" caption on those charts makes the exclusion visible.
- Everything defensive: wrong shapes, missing arrays, non-string stops → `null` or skip, never throw (this runs over historical JSON).
- Place normalization: match against `KNOWN_PLACES` (`api/src/adapters/maps.ts`) case-insensitively → canonical known-place name; unmatched names keep their trimmed literal (visible, not hidden in "Other").

**Demand (`demand.ts`):**

```ts
export function computeDemand(rows: DemandQuoteRow[], q: AnalyticsRange): DemandReport;

export interface DemandReport {
  range: { from: string; to: string };
  tiles: {
    serviceMix: { private: number; chauffeur: number; both: number; unrecorded: number }; // requestedService of created-in-range
    vehicleMix: Record<string, number>;                    // vehicle column, created-in-range
    avgTripKm: number | null; kmBuckets: { bucket: string; count: number }[]; // <50 / 50–100 / 100–200 / 200+
    avgPax: number | null;
  };
  topDestinations: { place: string; touches: number; wonValueCents: CurrencyMap }[];  // top 12; touch = 1 per quote
  topCorridors: { from: string; to: string; count: number; avgKm: number | null }[];  // top 12, directional
  movers: { place: string; recent: number; prior: number; changePct: number }[];      // recent half vs prior half of range; only ≥3 recent touches AND ≥50% change
  serviceTrend: { bucketStart: string; private: number; chauffeur: number; both: number }[]; // weekly stacked
  coverage: { parsed: number; total: number };             // extraction coverage, drives chart captions
}
```

Scoping: all demand metrics are over quotes **created in range** (demand = what was asked for, regardless of outcome), except `wonValueCents` which attributes won-quote totals to each touched place.

- [ ] **Step 1: failing tests:**
  - extractLegs: engine-wrapper and legacy-bare shapes; multi-stop ride → union of stops, each place once per quote; corridor = first→last (directional: A→B ≠ B→A); chauffeur travelDays normalize; shared → null; garbage JSON → null; KNOWN_PLACES case-insensitive canonicalization ("kandy " → "Kandy"); unmatched literal kept
  - demand: touches counted once per quote (6-leg tour ≠ 6 touches of same place twice); top-12 cut; movers small-n guard (1→2 not flagged; 3→6 flagged); recent/prior halves split correctly on odd-length ranges; serviceTrend weekly buckets in Colombo time; km bucket edges; coverage counts
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS. **Step 5:** commit.

### Task 5: route file — both endpoints

**Files:**
- Create: `api/src/routes/opsAnalytics.ts`
- Modify: `api/src/app.ts` (mount `/admin/ops/analytics`)
- Test: `api/src/routes/opsAnalytics.test.ts`

**Interfaces produced:** `opsAnalyticsRoutes(deps: { quotes: QuoteRepo; auth: OpsAuthConfig })` → Hono sub-app with `GET /funnel` and `GET /demand`. Shared zod query: `from`/`to` optional ISO dates (default: last 28 Colombo days ending today), `from > to` → 400; optional `channel` enum ops|web|all default ops (future customer-website analytics); funnel adds `bucket` enum day|week default day. Handlers: `opsIdentity` + `requireCap('analytics:view')` →
- funnel: `listFunnelRows(from − (to − from), FUNNEL_LIMIT)` → `computeFunnel` → `c.json({ ...report, truncated })`, `FUNNEL_LIMIT = 10_000`
- demand: `listDemandRows(from, to, DEMAND_LIMIT)` → `computeDemand` → `c.json({ ...report, truncated })`, `DEMAND_LIMIT = 5_000`

- [ ] **Step 1: failing tests** (mirror the harness in `ops.auth.test.ts` — dev session cookie per role):
  - both endpoints: no session → 401; `ops` and `finance` sessions → **403**; `founder` → 200
  - funnel 200 body has `tiles.pipeline`, `series`, `aging`, `truncated:false`; demand 200 body has `topDestinations`, `movers`, `coverage`, `truncated:false`; defaults applied when no query params
  - truncation: with a stub repo returning `truncated:true`, both endpoints surface `truncated:true`
  - `?from=<later>&to=<earlier>` → 400 (relative dates)
- [ ] **Step 2:** run → FAIL. **Step 3:** implement + mount in `app.ts` next to the `/admin/ops` mount, reusing the same deps/auth config. **Step 4:** run → PASS; full `npm test` green. **Step 5:** commit.

### Task 6: ops-UI — Analytics view with Funnel + Demand sub-tabs

**Files:**
- Modify: `api/src/routes/ops-ui.html` (nav, routing, new view, SVG helpers, styles)

**Wiring (all existing patterns):** add `analytics` to the route state machine — `syncUrl` (`#analytics`), `routeStateFromUrl`, `render()` dispatch, `setNav()` third button gated on `state.caps.includes('analytics:view')`; deep-link without the cap bounces to Bookings (same guard style as quotes at `:1841`). The existing `api()` helper already toasts + bounces on 403.

**View (`viewAnalytics()`):**
- Header row: sub-tab pills **Funnel · Demand** (`state.analytics.tab`), then shared range presets `7d · 28d · 12w · This month · Last month · All` + `Day/Week` toggle (funnel only; filter-chip styling like the quotes queue chips). State: `state.analytics = { tab:'funnel', preset:'28d', bucket:'day', funnel:null, demand:null, loading:false }`. Each tab fetches its own endpoint lazily on first open and on range change, with a **60s TTL cache keyed by tab+range** (pill-flipping never refetches; there is NO polling/auto-refresh — analytics loads only on explicit founder interaction).
- When a response carries `truncated:true`, render a banner above the charts: "Showing the most recent N quotes for this range" — never silently partial numbers.
- **Funnel tab:** tile row (Created · Sent · Won · Lost · Expired with ▲/▼ deltas; Win rate & Send rate as "x of y" when den<5; Open pipeline and In review snapshots with per-currency values) then: created-per-bucket bars (sent overlaid as second tone) · cohort funnel (3 horizontal bars) · lost reasons list ("(no reason recorded)" for null) · **pipeline aging** — 4 bucket cards (15+ in warning tone; click → `setShellRoute('quotes')` with the queue's status filter pre-set to `sent`; v1 status-filter only) · cycle-time stat cards (median + p90 + n, "—" when null).
- **Demand tab:** tile row (service mix incl. "unrecorded" share · vehicle mix · avg km + km-bucket mini-bars · avg pax) then: top destinations (h-bar list, touches + won value) · top corridors (directional, with avg km) · **rising/falling movers** (chip list: "▲ Ella 3→6") · weekly service-mix stacked bars · every destination/corridor chart captioned "based on N of M quotes" from `coverage` (shared-product + unparseable exclusion made visible).
- Charts via new ~150-line helpers `svgBars(series, opts)`, `svgHBar(items, opts)` returning SVG strings; existing card styling.
- Loading skeleton tiles + proper empty states ("No quotes in this range yet") consistent with the recent bookings empty/loading work.
- Gotcha guards: analytics render is self-contained — do NOT hook it into the background `loadQueue()` re-render; no inputs to preserve so no morphdom needed; add `data-testid` hooks (`analytics-nav`, `analytics-tiles`, `analytics-chart-created`, `analytics-tab-demand`, `analytics-top-destinations`) for e2e.

- [ ] **Step 1:** implement wiring + view + helpers. **Step 2: verify in the real app** — `npm run dev` in `api/` with dev-login: as founder (nav shows, both tabs paint, presets refetch, empty state on an empty range) and as ops (no nav item; `#analytics` deep link bounces + toast). **Step 3:** commit.

### Task 7: e2e (Playwright, `web-tests/`)

**Files:**
- Create: `web-tests/e2e/ops-analytics.spec.ts` (follow the existing CH_E2E_API ops spec pattern + globalSetup port guard)

- [ ] **Step 1:** spec: founder login → Analytics nav visible → Funnel tiles + created chart render → switch to Demand tab → destinations list renders (assert on the Task-6 `data-testid` hooks). Second case: ops login → nav item absent.
- [ ] **Step 2:** run `npm run test:all` in `web-tests/` → green. **Step 3:** commit.

### Task 8: verification & PR

- [ ] Full `npm test` (api) + `npm run test:all` (web-tests) green; run `verification-before-completion` checks.
- [ ] Commit the approved spec + this plan into `docs/superpowers/` in the same branch.
- [ ] PR to `main` titled `feat(ops): founder analytics — funnel & demand (v1)`, body maps to spec §A + §C; strict branch protection: update-branch → CI → merge.
- [ ] After merge: staging soak on ops.staging.ceylonhop.com (`/health/deep` db:ok, founder login, both tabs paint against real staging data). Prod promote is a separate later decision (batch with the next promote).

## Self-review notes

- Spec coverage: §A fully mapped (Tasks 3+6); §C mapped (Tasks 4+6) with two explicit narrowings: **hot-zone touches dropped from v1** (spec marked it stretch; depends on zone hits being recoverable from `result_json` — parked as follow-up) and shared-product quotes excluded from destination charts (routeId-based, no place names) but kept in mix tiles, with visible coverage captions.
- `channel='ops'` restriction is a new decision (owner sign-off requested in plan summary).
- Aging click-through narrowed to status-filter-only in v1 — flagged, not silently dropped.
- Type consistency: `AnalyticsRange` shared by both compute functions; `FunnelQuoteRow`/`DemandQuoteRow` defined once in Task 2 and consumed by Tasks 3–5; extraction helpers imported from `quote/types.ts`, not re-implemented.
- Perf (owner requirement 2026-07-23): fetch cost bounded by viewed window + small live set; `request_json` only ever fetched for the demand window; hard caps with visible truncation; indexes shipped ahead of need (migration 0021, additive only); no polling; customer site shares no code path — contention risk addressed at the query layer. Snapshot-table escape hatch documented in the architecture header with explicit triggers (p95 > ~500ms or > ~20k quotes).
- Migration 0021 is indexes only — no schema/data change; no customer-facing files touched; `/finance/summary` stub untouched.
