# Server-authoritative pricing in the booking flow

**Date:** 2026-07-16
**Status:** Proposed — deliberate, non-urgent. The backend already supports it; the plan is
gated on one infra (hosting) decision.
**Depends on:** the live `POST /quote` engine endpoint; psychological price-finishing (shipped
2026-07-16, PR #43); the rate-lock / quote-lifecycle work.
**Related:** `docs/superpowers/specs/2026-06-30-quote-lifecycle-design.md`,
`docs/superpowers/specs/2026-07-11-pricing-cost-plus-margin-design.md`.

## 1. Problem

The backend engine (`api/src/quote/`) is the authority for every price. But the booking wizard
and the SEO route pages **recompute prices client-side** from a hand-maintained mirror in
`transfers-data.js` (`legPrice`, `billableKm`, `finishPrice`) that duplicates the engine. Two
implementations of the same logic drift, and every pricing bug in the July cycle was a drift bug:

- a **stale route page** advertised `$139` while the backend charged ~`$132`;
- the **booking summary** showed the raw pre-finishing fare (`$67.22`) while checkout charged the
  finished `$67`, and multi-leg / chauffeur summaries didn't reconcile to their own totals.

The authoritative *charge* is already server-sourced at booking (`adoptServerQuote` in
`booking.js`), so this is a **displayed/estimated-price consistency** problem, not a charge-
integrity hole. But the inconsistency is customer-facing and erodes trust ("shown $139, charged
$132").

## 2. Key insight — the backend already supports this

`POST /quote` ([`api/src/routes/quote.ts:36`](../../../api/src/routes/quote.ts)) already exists in
production:

- Prices through the **same engine** as `/quote/lock` and bookings — authoritative by construction.
- **Stateless** (persists nothing), **rate-limited** (`api/src/app.ts:114`), **public**, and
  **margin-stripped** (`marginEstimateCents` removed for non-internal callers).
- Returns the full structured result: `lineItems` (including the `Final price adjustment` row),
  `subtotalCents`, `totalCents`, `depositCents`, `amountDueNowCents`, `priceAdjustmentCents`,
  `rateCardVersion`, `warnings`.
- Live-verified 2026-07-16: `POST /quote {private, car, CMB→Sigiriya 152 km}` →
  `totalCents: 6700` with a `Final price adjustment: -22` line (raw `6722` → finished `6700`);
  round-trip `0.40 s` — identical to `/health`, i.e. pricing compute ≈ 0.

**So this is not a backend project.** It is a front-end migration plus one infra decision.

## 3. Goals / success criteria

- The prices the customer **sees** in the wizard and summary are the **engine's** prices, to the
  cent — no client recomputation, no mirror drift.
- The booking summary rows **reconcile to the total by construction** — render the server
  `lineItems` (including the finishing adjustment), so rows always sum to `totalCents`. This closes
  the reconciliation gap the `booking.js` display fix (PR #43) handled by hand, permanently and
  without a bespoke invariant.
- No regression to the authoritative **charge** (already server-sourced at booking).
- Per-interaction latency stays acceptable — target: warm **≤150 ms from Sri Lanka, steady**.

## 4. Non-goals / out of scope

- **Distance/Maps** stays client-side. The browser resolves `distanceKm` and passes it in;
  `POST /quote` already prices from a supplied km, so pricing never blocks on Maps.
- **Build-time SEO route-page generation** stays. Route pages remain static, generated from the
  engine at build; the `npm run generate` + the CI freshness gate (PR #45) already keep them honest.
- No change to the **finished-price policy** or any pricing math.
- No front-end **build system**. This needs only `fetch`; the site stays "no-build".

## 5. Design

### 5.1 Backend — already built (documented for completeness)

`POST /quote` request = the `QuoteSchema` discriminated union in `quote.ts` (`product:
shared|private|chauffeur`, `vehicle`, `pax`/`bags`, `legs: [{ from, to, distanceKm }]`, `extras[]`,
and chauffeur `firstDate`/`lastDate`/`travelDays`). Response = the public `QuoteResult`. **No change
required.**

*Optional hardening:* confirm the `/quote` rate-limit window is generous enough for debounced
typing; consider a short-TTL edge cache keyed on the canonical request (pricing is deterministic, so
identical requests are cacheable).

### 5.2 Front-end (`booking.js`) — the actual work

- On any priced-input change (route/legs, vehicle, pax/bags, extras, service type): **debounce
  ~150 ms**, build the `QuoteSchema` payload, `POST /quote`.
- **Render the response directly.** Iterate `lineItems` for the summary rows; show
  `totalCents` / `amountDueNowCents` / `depositCents`. Delete `calcTotal()` and the client-side
  summary math — `sum-adamt` / `sum-total` become "render the server's rows".
- **Optimistic UI.** Keep the last shown price plus a subtle "updating…" state while a call is in
  flight; on error, hold the last valid price (never blank, never a wrong number).
- **Cache by request signature.** Reuse the existing `chQuoteLock` localStorage pattern so unchanged
  inputs don't re-call.
- **First paint.** Optionally keep a *single* client-side estimate for the very first render (before
  the first call returns) — the same number — or accept a ~150 ms spinner on load.

### 5.3 What stops being load-bearing

The client pricing mirror (`transfers-data.js` `legPrice` / `finishPrice` / `billableKm`) no longer
drives the booking flow. It survives only for **build-time route-page generation** (and the optional
first-paint estimate). `web-tests/unit/backend-price-parity.test.js` can narrow to that build-time
use.

## 6. Latency & infra — the gating decision

Measured against production 2026-07-16 (free Render tier, already fronted by Cloudflare):

| Leg | Time |
| --- | --- |
| TCP connect → Cloudflare edge | ~24 ms (steady) |
| TLS done at edge | ~58 ms (steady) |
| Origin fetch (edge → Render → edge), trivial request | **250 ms – 1.3 s, wildly jittery** |

The fast, consistent part is **Cloudflare** (already in front). The slow, jittery part is the
**Render free-tier origin** answering a request that does no work (`POST /quote` timed the same as
`/health`, so it is *not* compute or Maps). To make per-interaction pricing feel good:

- **Paid Render tier** (dedicated CPU) — removes the jitter/queueing (the biggest issue).
- **Render Singapore region** — ~30–60 ms from Sri Lanka vs ~250 ms+ from a US origin. (The
  measurement above was taken near the US-East Cloudflare edge, so it does **not** include the
  Sri-Lanka→origin distance a real customer pays.)
- Expected after both: warm **~≤150 ms, steady** — fine for debounced repricing with optimistic UI.

**This infra investment is the owner decision that gates the whole migration.** Without it,
per-interaction backend pricing is a UX downgrade from today's instant client-side pricing.

## 7. Failure modes

- **API slow / unreachable:** optimistic UI holds the last valid price; `adoptServerQuote` at
  booking remains the charge-integrity backstop.
- **Demo/offline mode** (`window.CEYLON_HOP_API` unset): fall back to a client-side estimate (keep a
  minimal mirror path) or disable live pricing — decide per product need.
- **Rate limits:** debounce + signature-cache keep call volume low; confirm the `/quote` window
  suits typing bursts.
- **Added API load/cost:** more requests than today (which only calls the API at lock). Bounded by
  debounce + cache; trivial to size on a paid tier.

## 8. Rollout (phased, reversible)

1. Provision the **paid Render tier + Singapore region**, then **re-measure warm `/quote` latency
   from a Sri Lankan connection.** If it's not acceptable, stop — the whole plan hinges here.
2. Behind a flag, migrate one surface (single-transfer wizard) to `POST /quote`; keep the client
   estimate as fallback.
3. Verify reconciliation + no charge change in e2e; ship to a fraction of traffic if desired.
4. Extend to trip + chauffeur; then remove the client mirror's flow role.
5. Narrow the parity test to build-time generation only.

## 9. Testing

- The summary-reconciliation gap is closed **for free** (render server rows) — but add a smoke e2e
  that the wizard renders `POST /quote`'s `lineItems` and that the rows sum to `totalCents`.
- New: debounce / optimistic-hold / failure-hold behavior; signature-cache hit/miss.
- Keep the build-time codegen + the CI freshness gate (PR #45) for route pages.

## 10. Decision required

**Do we commit to the paid Render tier (+ Singapore region) so per-interaction backend pricing is
viable?** Everything else follows from that answer. If **no**, keep today's model but continue
hardening it (single generated/shared implementation + the CI freshness gate already merged); if
**yes**, this becomes a scoped `booking.js` front-end change with no new backend work.
