# Funnel Tab Simplification + Quote $ Values — Design Spec

**Date:** 2026-07-23 · **Status:** approved by owner (chat) · **Amends:** §A of
`2026-07-23-founder-analytics-design.md`

## Why

Owner feedback: the Funnel tab is over-detailed for a company doing tens of quotes a month
("too much analytics… mundane too detailed stuff"), and money should be first-class — today $
appears only as sub-text. Simplify the tab and add headline $ analytics of quotes.

## What changes (Funnel tab only; Demand untouched)

### Tile row — 7 tiles (was 9), money first

| Tile | Definition |
|---|---|
| **Won value** (new) | sum `total_cents` by currency, quotes `won` with `decided_at` in range |
| **Quoted value** (new) | sum `total_cents` by currency, quotes with `sent_at` in range |
| **Avg quote size** (new) | per-currency Quoted value ÷ quotes sent in that currency, rounded |
| Created / Sent / Won | counts, unchanged, keep delta vs previous equal period |
| Open pipeline | live snapshot count + $ awaiting decision, unchanged |

**Dropped tiles:** Lost, Expired, Win rate, Send rate, In review.

### Cards — 3 (was 5)

Kept: Quotes per day/week chart · Pipeline aging (clickable) · Lost reasons (still carries
lost counts + lost $, so the Lost tile loses nothing).
**Dropped:** Cohort funnel card · Cycle times card (median/p90).

## Implementation

- `api/src/services/analytics/funnel.ts`: `FunnelReport.tiles` drops `lost/expired/winRate/
  sendRate/inReview`, gains `wonValue`, `sentValue`, `avgSentCents` (all `CurrencyMap`, never
  merged across currencies — hygiene rule 0.3.2 unchanged). Top-level `funnel` and `cycles`
  removed. Dead code (`Ratio`, `Stat`, `stat()`, `IN_REVIEW`) removed.
- `funnel.test.ts` pins the new $ definitions (in-range filtering, per-currency grouping,
  avg rounding); tests for removed metrics deleted.
- `ops-ui.html` `anFunnelHtml()`: new tile row, two cards removed; dead helpers (`anRatio`,
  `anStatCard`) removed.
- `web-tests/e2e/ops-analytics.spec.js`: stub payload + assertions updated (asserts a $ tile).
- Safe payload change: the endpoint's only consumer is this UI, same deploy. No migration,
  no repo/query changes — all fields already fetched.
