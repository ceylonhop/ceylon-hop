# Pricing: cost + 15% margin (owner correction, 2026-07-11)

## Problem

The rate card was **inverted**. The owner-provided per-km numbers (car $0.35/km, van $0.47/km, …)
were being used as the customer **sell** price, while `costPerKmCents` was back-computed as
`sell ÷ 1.25`. But those owner numbers are the **cost**. Net effect: every transfer was sold **at
cost with zero real margin**, and the on-screen "Est. margin" was fictitious (it was just
`sell − sell/1.25`). Example: a 146 km car quote read **$56.35** (= 161 billable km × $0.35), the
exact cost.

## Decision (owner, 2026-07-11)

The stored per-km and day-rate numbers are **COSTS**. Customer **sell = cost × 1.15** (15% margin).

- **Per-km, every vehicle** → cost + 15%.
- **Chauffeur day rate** ($27 cost) → cost + 15% = $31.05 sell.
- **Minimum fares** (floors: $29 car / $50 van / $85 van14 / …) → **NO markup**; final floor price. A
  short leg that prices below the floor is charged the floor as-is (it already covers fixed cost).
- **Extras** (sightseeing $10, luggage $5, …) → **NO markup**; final prices.

Formula: `legSell = max(floor, round(billableKm × sellPerKm))`, `billableKm = round(rawKm × 1.10)`,
`sellPerKm = costPerKm × 1.15`. Margin = `sell − cost` (real 15% markup on distance + day rate;
floored trips keep `floor − cost`; extras contribute 0 margin).

## Implementation

- **`api/src/quote/rateCard.ts`** — single source restructured: `COST_PER_KM_CENTS` (car 35, van 47,
  van9 47, van14 48, custom 175) + `MARKUP_PCT = 15`. `perKmCents` = derived sell (`cost × 1.15`,
  fractional cents so the final leg price rounds exactly once). `costPerKmCents` = the real costs.
  `chauffeur.dayRateCents` = derived sell (whole cent, 3105); new `dayRateCostCents = 2700` for margin.
  Floors + extras unchanged. `sell()` uses integer-cent math (`cost × (100+markup) / 100`) to avoid
  `× 1.15` float error. Version → `2026-07-11`.
- **`api/src/quote/engine.ts`** — chauffeur cost now includes the day-rate cost
  (`days × dayRateCostCents + round(billableKm × costPerKm)`), so chauffeur margin is real too. The
  private path already read `costPerKmCents` (now the real cost) and `perKmCents` (now the sell), so
  it needed no change.
- **Front-end** — regenerated from the rate card via `npm run generate` (`pricingPayload` → codegen):
  `transfers-data.js` (`PER_KM {car:0.4025, van:0.5405}`, `CHAUFFEUR_DAY_FEE 31.05`) and all
  `trip/*/index.html` route-page prices. Shared-seat prices (`routes-data.js`) unchanged.
- **Tests** — every pricing golden number across `api` + `web-tests` reconciled to the new sell model;
  FE↔BE parity + codegen guards pass (they derive from source).

## Before / after (car)

| Route | Before | After | Margin |
|---|---|---|---|
| 146 km (the $56.35 quote) | $56.35 | **$64.80** | $8.45 |
| 178 km | $68.60 | **$78.89** | $10.29 |
| 30 km (floored) | $29 | **$29** | floor kept |

Normal trips rise ~15%; floored short trips unchanged. `rateCard.ts` (`RATE_CARD.costPerKmCents` +
`markupPct`) remains the single source of truth for both the engine and the codegen'd front-end.
