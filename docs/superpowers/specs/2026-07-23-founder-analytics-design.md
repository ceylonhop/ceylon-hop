# Founder Analytics — Design Spec

**Date:** 2026-07-23 · **Status:** v1 BUILT for families A (Funnel) + C (Demand) — owner-scoped 2026-07-23; B/D/E remain designed-but-unbuilt (fresh go needed). Owner add-ons: web-channel analytics is coming later (hence the `channel` param throughout), and analytics must never slow the ops dashboard or customer site as data grows (hence the bounded-query architecture in the plan).
**Scope:** A founder-only Analytics surface in `/ops`, covering backward-looking, forward-looking, and operational metrics across five families: **A Funnel & Pipeline · B Financial · C Demand & Geography · D Forward Operations · E Team Efficiency**.

---

## 0. Shared architecture (applies to every family)

### 0.1 Access control — founder-only, enforced server-side

- **New capability `analytics:view`** added to `OpsAction` in `api/src/lib/opsAuth.ts`, granted **only to `founder`** in the capability matrix. One row added; no other role changes.
- Why a new cap instead of reusing `margin:view`: today `margin:view` means "may see margin figures on a quote." Analytics is a different surface (whole-business aggregates, team performance). A dedicated cap keeps the matrix honest and lets you later grant e.g. finance a margin-free analytics view without a redesign.
- **Server:** every analytics endpoint is wrapped in `requireCap('analytics:view')` (existing Hono middleware, `api/src/lib/opsMiddleware.ts`). A non-founder gets 403 even with a hand-typed URL.
- **Client:** the Analytics nav item renders only when `state.caps.includes('analytics:view')` — same pattern as the Quotes nav gate (`ops-ui.html:1174`). Deep-linking `#/analytics` as a non-founder bounces to Bookings with a toast (same pattern as the builder's 403 handling).

### 0.2 API design

New route file `api/src/routes/opsAnalytics.ts` (factory returning a `new Hono()`, matching every other route file), mounted at **`/admin/ops/analytics`** in `app.ts`. The existing `/admin/ops/finance/summary` stub is retired (removed) since this supersedes it.

One endpoint per family — five total:

```
GET /admin/ops/analytics/funnel?from=&to=&bucket=day|week
GET /admin/ops/analytics/financial?from=&to=&bucket=week
GET /admin/ops/analytics/demand?from=&to=
GET /admin/ops/analytics/forward?horizonDays=28
GET /admin/ops/analytics/team?from=&to=
```

- `from`/`to` are ISO dates interpreted in **Asia/Colombo** (see 0.4). Defaults: last 28 days.
- Each returns one JSON document with every tile + chart series for that tab, so a tab paints with **one fetch** (matches the ops UI's existing whole-payload style, keeps free-tier cold-starts to one round trip).
- Aggregation lives in a new **`api/src/db/analyticsRepo.ts`** (interface + `postgresAnalyticsRepo.ts`), using Drizzle `sql` fragments for `count/sum/group by` — the first aggregating repo in the codebase, but the same repo pattern as everything else.
- **Computed live, no snapshot tables, no caching.** Volumes are hundreds of rows; every query is a single-table scan with an index already on it (or trivially added). If it ever slows down, a materialized snapshot is a later, additive change.

### 0.3 Universal data hygiene rules

These apply to **every** query in every family; each is a one-line `where` clause but getting them wrong silently corrupts every number:

1. **Soft-deleted quotes are excluded**: `deleted_at IS NULL`, always. (The repo's `list()` already hides them; raw aggregate SQL must repeat the filter.)
2. **Money is integer minor units + a `currency` column.** Never sum across currencies. Every money aggregate is `GROUP BY currency`; the UI displays the dominant currency (USD today) and shows any other currency as a separate small line rather than a fake converted total.
3. **`marginCents` is nullable** (legacy rows). Margin aggregates compute over rows where it's present and every margin tile shows **coverage** ("margin on 41 of 52 quotes") so a founder never mistakes partial data for whole.
4. **Bucket by Asia/Colombo days**, not UTC (0.4).
5. **Test-data caveat, not a filter:** pre-launch website bookings are test data. We do *not* hard-code exclusions; the Financial tab separates "Quote revenue (ops channel)" from "Website bookings" so the founder reads each lens knowing what it is. After go-live cleanup (already on the checklist) the caveat disappears naturally.

### 0.4 Time semantics

- All timestamps are `timestamptz`. Day/week bucketing converts first: `date_trunc('day', created_at AT TIME ZONE 'Asia/Colombo')`. Otherwise late-evening Colombo quotes land on the wrong day and "quotes today" is wrong every morning.
- Weeks are ISO weeks (Mon-start), labelled by their Monday.
- Global range picker presets: **7d · 28d · 12w · This month · Last month · All time**, plus bucket toggle (day/week) where a time series exists. One control, top of the Analytics view, shared by all tabs (each tab refetches with the current range).

### 0.5 UI structure — one nav item, five tabs

- One new nav item **“Analytics”** (after Quotes). Inside: pill sub-tabs — **Funnel · Money · Demand · Upcoming · Team** — matching the existing filter-chip visual language in ops-ui.
- Layout per tab: a row of **KPI tiles** (big number, small label, optional delta vs previous equal period), then **charts/lists** in the existing card style (same card/header pattern the notes-card and route-map cards use).
- **Charts are hand-rolled inline SVG** — bars, lines, sparklines. No chart library: keeps the single-file no-build ops UI dependency-free, works offline-ish on free-tier cold starts, and the chart needs here (bars/lines/simple funnels) don't justify vendoring 60kB. Shared tiny JS helpers (`svgBars()`, `svgLine()`, `svgSpark()`) ~150 lines total, written once.
- **Empty/low-data states**: every chart has a proper empty state ("No quotes in this range") in the style of the recent bookings empty-state work. With weeks of data rather than years, small-n is the norm — tiles show absolute counts prominently; percentage tiles with n < 5 show the ratio as "2 of 3" instead of "67%" so tiny samples don't masquerade as statistics.
- Loading: skeleton tiles per tab while the single fetch is in flight (free-tier staging can cold-start ~30s; skeleton + the existing wake pattern).

### 0.6 What v1 deliberately does NOT do

- No CSV export (easy later; YAGNI now).
- No cross-currency conversion.
- No caching/materialized views.
- No new writes of any kind from analytics endpoints — **strictly read-only**.
- No new migration for A–D. Family E's review-turnaround metric is the only thing wanting a new table, and it's explicitly carved out (see §E).

---

## A. Funnel & Pipeline (tab: “Funnel”)

**Purpose:** how much quoting is happening, where quotes die, and what's sitting open right now that needs chasing. Backward + the most actionable forward signal we have.

**Source:** `quotes` table only. Lifecycle: `draft → pending_review → changes_requested → ready → sent → won | lost | expired`, with `created_at`, `sent_at` (stamped on →sent), `decided_at` (stamped on won/lost/expired), `lost_reason`, `total_cents`.

### KPI tiles (range-scoped unless marked ⌖ = live snapshot)

| Tile | Definition |
|---|---|
| Quotes created | `count(*)` where `created_at` in range |
| Quotes sent | `count(*)` where `sent_at` in range |
| Won / Lost / Expired | counts where `decided_at` in range, split by status |
| **Win rate** | won ÷ (won + lost + expired), over quotes *decided in range* |
| Send rate | quotes created in range that have since been sent ÷ created |
| ⌖ **Open pipeline** | count + **value** (sum `total_cents` by currency) of quotes with `status='sent'` right now — money awaiting a customer decision |
| ⌖ In review | count currently in `pending_review` / `changes_requested` / `ready` — the internal backlog |

Each range-scoped tile shows a small **delta vs the previous equal-length period** (e.g. "12 created ▲ +4 vs prior 28d").

### Charts & lists

1. **Quotes created per day/week** — bar chart, the heartbeat. Bucket per the global toggle.
2. **Funnel bar** — created → sent → won for quotes *created* in range (cohort view: of the 30 created, 21 sent, 9 won). Cohort framing, not mixed-period counts, so the funnel never shows >100% stages.
3. **Lost reasons** — horizontal bar list of `lost_reason` values for quotes lost in range, with counts and lost value. Null reason shown as "(no reason recorded)" — which itself tells you the field isn't being filled in.
4. **⌖ Pipeline aging** — open `sent` quotes bucketed by days-since-`sent_at`: **0–2d · 3–7d · 8–14d · 15d+**, each bucket showing count + value, **clicking a bucket jumps to the Quotes list filtered to those quotes** (reuses the existing quotes-list filters; oldest bucket rendered in the warning tone). This is the "preemptive action" widget: money going cold.
5. **Cycle times** — median (and p90) hours **draft→sent** and days **sent→decided**, for quotes reaching those transitions in range. Median not mean (one week-old outlier shouldn't swamp it); n shown beside each.

### Definition notes

- "Created" excludes nothing by status — a draft counts as created (it's demand even if never sent).
- Win rate denominators use *decided* quotes only; open `sent` quotes are pipeline, not losses.
- Expired counts as a loss in win rate but is also broken out separately — a rising expired share with an aging pipeline = quotes not being chased, a different fix than losing on price.

---

## B. Financial (tab: “Money”)

**Purpose:** what we're earning, at what margin, from which products — and whether average deal size is moving.

**Source:** `quotes` (`total_cents`, `margin_cents`, `currency`, `product`, `decided_at`, `sent_at`) + `bookings`/`payments` for the website lens.

### Two revenue lenses, labelled explicitly, never merged

- **Quote revenue (ops channel):** sum `total_cents` of quotes **won** in range. This is the business's real signal today.
- **Website bookings:** sum of `payments.amount` where `status` = captured/succeeded in range. Pre-launch this is test data — the card carries a small caveat badge until go-live cleanup.

### KPI tiles

| Tile | Definition |
|---|---|
| Won revenue | quotes won in range, sum by currency |
| **Total margin** | sum `margin_cents` on won-in-range quotes (with coverage note per §0.3) |
| **Avg margin %** | Σmargin ÷ Σtotal over won quotes that have margin |
| Avg quote value (sent) | mean `total_cents` of quotes sent in range — what we're asking |
| Avg won value | mean of won in range — what customers accept. The gap between these two is a pricing signal |
| Website bookings | payments lens, caveat-badged pre-launch |

### Charts

1. **Won revenue per week** — bar chart (week granularity only; daily revenue at current volume is noise).
2. **Margin % trend** — line per week over won quotes; weeks with no margin-bearing wins render a gap, not zero.
3. **Product mix** — split of won revenue and counts by `product` (private transfer / chauffeur / shared / tour): stacked bar or side-by-side per product with revenue, count, avg value, avg margin % per product. **This tells you which product line actually makes money.**
4. **Avg sent-quote value trend** — sparkline per week; drift here changes the whole revenue forecast.

### Guardrails

- Everything on this tab is inherently `margin:view`-grade data; the whole tab (like the rest of Analytics) sits behind `analytics:view` = founder-only, so no per-field stripping needed.
- Idle-day pricing stays internal: product/margin aggregates never enumerate fee lines, so nothing here can leak the idle-day framing into anything customer-facing.

---

## C. Demand & Geography (tab: “Demand”)

**Purpose:** where people want to go, in what mix, and what's rising — feeds pricing (hot zones), marketing, and vehicle planning.

**Source:** quote `request_json` legs (`from`, `to`, `stops[]`, `date`, vehicle) for ops-channel demand; `transfer_request`/`trip_request` rows for website demand; `requested_service` on quotes.

### Extraction & normalization (the load-bearing detail)

- A quote's destinations = the union of every leg's `from`, `to`, and `stops[]` entries in `request_json` (multi-stop chains included). Each distinct place counts **once per quote** ("touches"), so a 6-leg tour doesn't drown out six single transfers.
- Place names are normalized (trim/case) and matched against `KNOWN_PLACES` (`api/src/adapters/maps.ts`); unmatched free-text names group under their normalized literal (they'll mostly be real places typed slightly differently — visible, not hidden in "Other").
- Corridors = ordered `from→to` pairs per leg, so "Airport → Kandy" and "Kandy → Airport" stay distinct (directionality matters for positioning/deadhead planning).
- Parsing `request_json` happens in TypeScript in the repo (not SQL JSON gymnastics): fetch the range's quotes (hundreds), extract in code, aggregate. Simple, testable, fast at this scale.

### KPI tiles

Requested-service mix (`private` / `chauffeur` / `both` shares of quotes created in range) · vehicle mix (car / van tiers) · avg trip distance & distribution (from leg `km`) · avg pax.

### Charts & lists

1. **Top destinations** — horizontal bar list, top 12 by quote-touches in range, each with touch count + won revenue attributable (sum of won-quote totals touching the place).
2. **Top corridors** — same treatment for `from→to` pairs, with avg priced km alongside.
3. **Rising / falling destinations** — compare touches in the most recent half of the range vs the prior half; flag movers with ≥3 touches and ≥50% change. Small-n guarded (no flags on 1→2). This is the preemptive-action widget: a rising town is a hot-zone / marketing candidate *before* it's obvious.
4. **Service-mix trend** — stacked weekly bar of requested service; watches whether the chauffeur upsell trend is real.
5. **Hot-zone touches** *(stretch, in-scope only if cheap at build time)* — count of priced quotes whose result touched an active `pricing_zones` row, per zone. Depends on zone-hit info being recoverable from `result_json`; if it isn't, this drops to a follow-up that persists zone hits at pricing time (additive) rather than guessing.

---

## D. Forward Operations (tab: “Upcoming”)

**Purpose:** the only genuinely forward-looking tab — committed future work: when, how full, and is fulfilment ready. Horizon: next 28 days (param `horizonDays`).

**Source:** `transfer_request.travel_date` + `trip_request` dates for booked website trips; won quotes' leg dates from `request_json`; `shared_departures` (`date`, `seats_total`, `seats_booked`, corridor); `ride_ops` fulfilment statuses; `bookings.amount_due_now` / `payments` for balance state.

### Widgets

1. **Travel-load calendar strip** — one bar per day for the next 28 days: count of trips touching that day (booked trips + won-quote legs dated that day). Undated won-quote legs are counted in an explicit "**unscheduled won work**" tile rather than silently dropped — that tile is itself an action item (trips sold but not yet dated).
2. **⚠ Fulfilment red-flag list** — the tab's centerpiece: upcoming trips (soonest first) where readiness is behind, from `ride_ops`: travel date within 7 days AND fulfilment not yet vehicle-confirmed / driver-acknowledged. Each row: date, route, customer, current `fulfilment_status`, days remaining. Empty state: "All upcoming rides are staffed ✓".
3. **Shared-departure fill** — next departures (Wed/Sat corridors) as `seats_booked / seats_total` bars per departure; near-empty departures close to date are visible cancel/merge decisions, full ones are add-capacity signals.
4. **Money still to collect** — upcoming bookings with outstanding balance (total − captured payments), sum + list. Pre-launch caveat badge as in §B.

### Definition notes

- "Upcoming" = travel date ≥ today (Colombo). Past-dated unfinished fulfilment rows appear in a separate small "overdue" bucket at the top of the red-flag list — never silently mixed into future counts.
- Won-quote leg dates come from the same `request_json` leg extraction as §C (dates are optional on legs — hence the unscheduled tile).

---

## E. Team Efficiency (tab: “Team”)

**Purpose:** who's producing what, and where quotes wait on people. Deliberately the thinnest tab — the team is small and over-instrumenting it now is noise.

**Source:** `quotes.created_by`, `assigned_to`, `sent_at`, `decided_at`, statuses.

### v1 (existing columns only — no migration)

1. **Per-person table** (by `created_by`): quotes created · sent · won · win rate (n-guarded per §0.5) · won value · median draft→sent hours. Null `created_by` (pre-audit rows) grouped as "(before tracking)".
2. **⌖ Current assignment load** — open (undecided, undeleted) quotes per `assigned_to`, split by status group (drafting / in review / sent). Shows at a glance if one person is sitting on a pile.

### Explicitly deferred: review-turnaround metric

"How long do quotes wait in `pending_review` before the founder acts" is the most valuable team metric — and **cannot be computed from current columns** (intermediate transitions aren't timestamped; only `sent_at`/`decided_at` are). Doing it right needs a small additive `quote_status_events` table (quote_id, from_status, to_status, actor, at) written on every transition in `postgresQuoteRepo.updateStatus` — cheap, additive migration 0021, and it only accrues data from the day it ships.

**Decision needed from you:** include `quote_status_events` in v1 (migration 0021, starts collecting now, metric appears once data accrues) — my recommendation, since the table only becomes useful the day it starts writing — or defer entirely.

---

## Delivery & quality

- **Order:** ship as three PRs to keep review sane under strict branch protection — **PR 1:** `analytics:view` cap + route file + analyticsRepo + Funnel & Money tabs (families A+B). **PR 2:** Demand + Upcoming (C+D). **PR 3:** Team (E) ± the events migration per your call. Each lands on `main` → staging soak → promote batch to `production`.
- **Tests (Vitest):** analyticsRepo aggregation tests with seeded rows — the definitions above (win-rate denominator, cohort funnel, timezone day-bucketing across the Colombo midnight boundary, soft-delete exclusion, currency grouping, margin coverage) each get a unit test; route tests assert 403 for ops/finance roles and 200 shape for founder. Test dates use the `testSupport/dates` helpers (never literals — the date-bomb rule).
- **E2E (Playwright):** founder sees Analytics nav and tab renders tiles; ops role doesn't see the nav and deep-link bounces.
- **Perf:** each endpoint is a handful of single-table aggregates over hundreds of rows; add an index on `quotes(created_at)` only if measurement says so (it won't at this scale).
- **No customer-facing surface is touched.** Ops-ui only; booker/homepage untouched.

## Open questions for you

1. **Sub-tab set OK?** (Funnel · Money · Demand · Upcoming · Team) — or would you rather v1 ship only some tabs (my earlier recommendation was A+B+C first)?
2. **`quote_status_events` migration in v1?** (§E — recommend yes, it's write-and-forget and the data can't be backfilled later.)
3. **Default range:** 28 days OK?
