# Ceylon Hop — Pricing Engine Reference

Current, authoritative reference for how a quote is priced — the model, the rate card, every
formula, and **how prices are shown in the front-end vs the backend**. Keep this in sync when the
engine changes.

> The M11 docs (`quote-engine-spec.md`, `quote-engine-README.md`, `quote-engine-worked-examples.md`)
> are the original **design** and are historical — some numbers there predate later rate changes.
> **This file + `api/src/quote/rateCard.ts` are the source of truth for current behaviour.**

---

## 1. What it is

A single, server-authoritative, **pure** pricing engine: given a trip description + distances, it
returns a priced quote (integer USD cents). It does not fetch distances, send messages, or take
payment. It lives in **`api/src/quote/`** and is the one place prices are defined; the static
front-end's prices are **code-generated from it** (§7), never hand-typed.

Entry point: `quote(req: QuoteRequest): QuoteResult` in `api/src/quote/engine.ts`.

Money is **integer minor units (USD cents)** everywhere in the backend. USD→whole-dollar and
USD→LKR conversions happen only at display boundaries.

---

## 2. The pricing model (owner 2026-07-11)

The rate-card numbers are **COSTS**. The customer **SELL price = cost × (1 + markup)**, so margin is
real: `sell − cost = markup × cost`.

- **markup = 15%** (`RATE_CARD.markupPct`).
- Applies to: **per-km rates (all vehicles)** and the **chauffeur day rate**.
- Does **NOT** apply to: **minimum fares (floors)** and **extras** — those are final prices set by the
  owner (a short leg below the floor is charged the floor as-is; the floor already covers fixed cost).

Margin as reported = 15% markup over cost ≈ **13% of revenue**.

---

## 3. The rate card — `api/src/quote/rateCard.ts`

`RATE_CARD` is the single source of truth. Structure (values are the owner's current numbers):

| Field | Meaning | Current value |
|---|---|---|
| `markupPct` | Margin applied to costs | `15` |
| `costPerKmCents` | **Real cost** per km, per vehicle | car 35 · van 47 · van9 47 · van14 48 · custom 175 (¢) |
| `perKmCents` | **Derived SELL** = `cost × 1.15` (fractional cents kept on purpose — see §6) | car 40.25 · van 54.05 · van9 54.05 · van14 55.2 · custom 201.25 |
| `floorCents` | **Minimum fare** (final, no markup) | car 2900 · van/van9 5000 · van14 8500 · custom 11000 |
| `chauffeur.dayRateCents` | **Derived SELL** day rate = `round(cost × 1.15)` | 3105 ($31.05) |
| `chauffeur.dayRateCostCents` | Real day-rate cost (margin only) | 2700 ($27) |
| `chauffeur.idleMinKm` | Min km billed per idle day, per vehicle | 100 (all) |
| `deposit` | `{ pct: 10, capCents: 5000 }` | 10%, cap $50 |
| `bufferPct` | Distance buffer on travel km | `10` |
| `fxUsdToLkr` | Manual USD→LKR rate — **display only** | `330` |
| `extras` | Add-on fees (final, no markup) | sightseeing 1000 · safari-wait 1900 · luggage 500 · front 800 · flex 1200 · waiting 1000 |
| `vehicle` | pax/bag capacities per tier | car 3/3 · van 6/6 · van9 9/8 · van14 14/12 |
| `shared.colomboPickupCents` | Colombo hotel pickup surcharge per seat | 300 |

The derived sells use a private helper `sell(costCents) = costCents * (100 + markup) / 100`
(**integer-cent math**, to avoid the float error of `cost × 1.15`, e.g. `2700 × 1.15 = 3104.9999…`).
Shared-corridor **seat prices are NOT in the rate card** — they live in
`api/src/db/departureRepo.ts` `DEFAULT_CORRIDORS` (a flat seat price per corridor).

---

## 4. Pricing formulas (per product)

`billableKm(rawKm) = round(rawKm × 1.10)` — the 10% buffer (travel km only; not chauffeur idle km).

**Private leg** (`private.ts` → `legPriceCents`):
```
legSell = max( floorCents[vehicle],  round( billableKm × perKmCents[vehicle] ) )
```
A multi-stop private trip is `Σ legSell + extras`. The vehicle used is the anti-tamper pick (§5).

**Shared** (`shared.ts`): `Σ ( seatPriceCents × seats + (colomboPickup ? 300 × seats : 0) )`. Distance
unused; seat price comes from the corridor repo.

**Chauffeur** (`chauffeur.ts`):
```
days       = dateDiff(lastDate, firstDate) + 1          // inclusive, date-only (UTC)
idleDays   = max(0, days − travelDays.length)
billableKm = billableKm(Σ travelKm) + idleDays × idleMinKm[vehicle]   // idle km NOT buffered
dayCharge      = days × dayRateCents                    // SELL day rate ($31.05/day)
distanceCharge = round( billableKm × perKmCents[vehicle] )  // SELL per-km
total = dayCharge + distanceCharge + extras
```
Idle days derive from the **date gap** (no explicit "stay day" leg — that was retired). They're
folded into the price (day count + `idle-day min` km); they are **not** rendered as a separate
itinerary line in the customer message (deliberate — see the idle-day note in the specs). On a
chauffeur trip the vehicle is included all day, so `sightseeing`/`waiting`/`safari-wait` extras are
free (`CHAUFFEUR_INCLUDED_EXTRAS`).

**Chauffeur requires ≥2 distinct leg dates.** A single-day itinerary is **point-to-point only** — a
chauffeur request with `< 2` distinct leg dates is priced as a normal transfer (no day rate).
Enforced on **both** layers so a single transfer can never carry a chauffeur day rate, whoever calls
the API: the client (`ops-ui.html` `_runEstimate` reverts `state.service` before pricing) and the
server (`toEngineRequest` in `internalQuote.ts` — the canonical, tamper-proof price + save-recompute).

**Extras** (`extrasDeposit.ts`): `Σ extras[code]`, charged at face value (no markup).

**Deposit**: `min(round(total × 10%), $50)`. `amountDueNow` = full total (customers pay in full).

---

## 5. Vehicle selection (anti-tamper)

`pricedVehicle = the larger of { requested, selectVehicle(pax, bags) }` (`vehicle.ts`). A car
requested for 6 pax is priced as the required **van** (with a warning); upgrades are always allowed;
`too_big` → `TOO_BIG`. The client's vehicle is never trusted blindly.

---

## 6. Margin & rounding

- **Margin** (`marginEstimateCents = total − cost`, private + chauffeur only; null for shared):
  - Private: `cost = round(billableKm × costPerKmCents[vehicle])`.
  - Chauffeur: `cost = days × dayRateCostCents + round(billableKm × costPerKmCents[vehicle])` (day cost
    **and** distance cost, so the day-rate margin is real too).
  - A floored short leg keeps `floor − cost` (higher %). Extras contribute ~0 margin.
- **Rounding**: two deterministic rounds — km first (`round(rawKm × 1.10)`), then the price
  (`round(billableKm × perKm)`). The per-km **sell rate is kept fractional** (e.g. car 40.25¢) so the
  price rounds exactly **once** at the end — no precision lost to an early per-km rounding. Every
  caller prices through this same engine, so client and server agree (matters for booking-time
  recompute / anti-tamper).

---

## 7. Front-end vs backend — how prices are shown

**Same rates, two display granularities.**

| | Backend (`api/`) | Front-end (static site + ops tool) |
|---|---|---|
| Unit | integer **cents** | route pages: **whole dollars**; ops tool: **cents** |
| Example (car 161 billable km) | `6480` cents = **$64.80** | route page **$65**; ops tool **$64.80** |
| Currency | USD only | USD (+ an **LKR reference**, `× 330 / 100`, display-only) |

- The **backend** returns exact integer cents ($64.80) — used by the ops quoting tool, booking
  recompute, and margin.
- The **marketing route pages** (`trip/*/index.html`) and the booking widget show **whole-dollar**
  prices: `legPrice = max(floor, round(billableKm × PER_KM))` where `PER_KM` is in dollars — i.e. the
  cent price rounded to the nearest dollar. This is intentional (clean marketing prices); it can differ
  from the ops-tool cents by up to 50¢.
- **LKR** is shown next to USD in the ops tool as a convenience (`fxUsdToLkr = 330`), computed at the
  display boundary. The engine never prices in LKR.

**Single source of truth via codegen — no hand-typed front-end prices.** Flow:
```
rateCard.ts + departureRepo.ts
  → pricingPayload.ts  buildPricingPayload()   (cents → whole USD at the boundary)
  → scripts/dump-pricing.ts  (npm run dump:pricing → JSON)
  → tools/generate-pricing.mjs  (npm run generate)
      • injects the @generated:pricing block into transfers-data.js
        (PER_KM, FLOORS, BUFFER_PCT, CHAUFFEUR_DAY_FEE, DEPOSIT_PCT/CAP, EXTRAS, CORRIDOR_SEAT)
      • rewrites each shared route's price in routes-data.js from its corridor seat
  → tools/generate-route-pages.mjs  (bakes prices into trip/*/index.html)
```
So `transfers-data.js` currently reads `PER_KM {car:0.4025, van:0.5405}`, `FLOORS {car:29, van:50}`,
`CHAUFFEUR_DAY_FEE 31.05` — all derived, never edited by hand.

**Parity guards** (keep green):
- `web-tests/unit/pricing-codegen.test.js` — freshness (regenerates in memory, fails if the committed
  block is stale) + constant parity (`window.TRANSFERS` == backend dump) + extras completeness.
- `web-tests/unit/backend-price-parity.test.js` — behavioural: FE `legPrice(km)` (whole dollars) ==
  `round(backend legPriceCents / 100)` across the floor + per-km regimes.
- `web-tests/unit/shared-price-parity.test.js` — `routes-data.js` shared prices == corridor seats.

---

## 8. File map

| Concern | File |
|---|---|
| Rate card (source of truth) | `api/src/quote/rateCard.ts` |
| Engine entry / orchestration + margin | `api/src/quote/engine.ts` |
| Private leg pricing + buffer | `api/src/quote/private.ts` |
| Chauffeur pricing | `api/src/quote/chauffeur.ts` |
| Shared pricing | `api/src/quote/shared.ts` |
| Extras + deposit | `api/src/quote/extrasDeposit.ts` |
| Vehicle selection | `api/src/quote/vehicle.ts` |
| Per-leg breakdown (ops display) | `api/src/quote/breakdown.ts` |
| FE payload builder | `api/src/quote/pricingPayload.ts` |
| Shared corridor seat prices | `api/src/db/departureRepo.ts` (`DEFAULT_CORRIDORS`) |
| FE codegen | `tools/generate-pricing.mjs`, `scripts/dump-pricing.ts` |
| FE constants (generated) | `transfers-data.js` (`@generated:pricing` block), `routes-data.js`, `trip/*/index.html` |

---

## 9. How to change a price

1. Edit **`api/src/quote/rateCard.ts`** (per-km/floor/chauffeur/extras/deposit) — or
   `api/src/db/departureRepo.ts` for shared-corridor seat prices. Bump `RATE_CARD.version`.
2. Run **`npm run generate`** (root) to regenerate the front-end (`transfers-data.js`, `routes-data.js`,
   `trip/*` route pages) from the rate card.
3. Update the pricing golden numbers in the tests (they encode exact prices to catch drift) and run
   `cd api && npm run check` + `cd web-tests && npx vitest run` until green.

Never edit a front-end price to diverge from the backend — the codegen + parity guards will fail.

_Last updated 2026-07-11 (cost + 15% margin model, rate card `version: 2026-07-11`)._
