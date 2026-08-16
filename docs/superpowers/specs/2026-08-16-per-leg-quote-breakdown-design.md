# Per-journey prices on the customer quote page — design

Date: 2026-08-16
Owner decisions captured in this session; nothing built yet.

## The problem

A customer (Martina, Q- thread 2026-08-16) received a quote link for an eleven-day private
trip and replied:

> "Is it possible to also have a breakdown of the quote for each single route? We were
> planning on being flexible on the itinerary so this would be useful to decide."

She cannot act on one total. She is choosing which journeys to keep, and that decision needs
a price per journey. The quote page has no such view, so ops answers by hand.

The owner's constraint: **this must not be shown to every customer** — only to the ones who
ask.

## What already exists

**Private quotes already carry real per-leg prices.** `quotePrivateLegs` (`private.ts:72`)
pushes one `lineItem` per driving leg, and those rows sum exactly to `subtotalCents`. The
engine then appends, in order:

1. N driving-leg rows — one per journey
2. extras rows, attributed to a leg by name where the ops tool supplied `legIndex`
3. `Final price adjustment` (`meta.kind: 'price_adjustment'`) — only when non-zero
4. `Discount` (`meta.kind: 'discount'`, negative) — only when a founder discount applied

These sum to `totalCents` exactly. That is not an accident: `engine.ts:145` records that the
discount was deliberately moved to run *after* price finishing so that "the three figures a
customer sees reconcile exactly" and no customer-facing breakdown would need to expose the
internal finishing row.

**Chauffeur quotes carry no per-leg price at all.** `chauffeur.ts:64-65` emits two rows for
the whole trip: a day rate × days, and one distance charge across all days. `quoteBreakdown()`
can synthesise a per-leg km share, but that figure is not what dropping the leg would save —
the day rate does not move. Showing it would mislead exactly the customer who is deciding what
to cut.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Who gates it? | **Ops ticks it per quote**, off by default. Not a customer-openable expander. |
| 2 | Chauffeur card? | **No breakdown.** Private card only. |
| 3 | The gap between legs and total | **Its own reconciliation row.** Leg prices stay identical to the ops timeline's. |
| 4 | Placement | **In the DAY BY DAY rail**, price right-aligned on the journey's header line, invoice-style. |
| 5 | Rate exposure | **Accepted.** Per-leg money makes the ~$0.44/km rate derivable; that is inherent and the gate limits who sees it. |
| 6 | Number format | **Whole dollars**, with the reconciliation row absorbing the remainder so the column always adds up. |
| 7 | Storage | **A new column** — the long-term solve, not the JSON shortcut. |

## Design

### Storage

Add to `quotes`:

```
show_leg_prices boolean not null default false
```

Every existing row is off, which is the required default. Migration is additive: no backfill,
no rewrite, and nothing reads the column until the ops checkbox ships.

**Rejected — `request_json`.** No migration, but that blob is *what the quote was priced
from*. `quoteDiff` reads `request.engine` and `request.tool.legs`, and re-pricing on reopen
feeds off the same object. A cosmetic tick would be editing the priced request.

**Rejected — bake it into the `?t=` token.** No storage at all, but ticking the box would not
change a link already sent; ops would have to re-mint and re-send. Decision 1 requires the
customer's existing link to pick it up.

### Ops control

A checkbox in the quote builder, saved with the quote, off by default. It is a display
setting, not a pricing input: it must not re-estimate and must not require re-approval.

### What the API projects

`CustomerQuoteView`'s option gains:

```ts
legPrices: {
  rows: { label: string; amountUsd: string }[];   // one per journey, in itinerary order
  reconcile: { label: string; amountUsd: string } | null;
  totalUsd: string;
} | null
```

`null` unless **all** of:

- `quote.showLegPrices` is true, and
- the option is the **lead** option (the one that was priced), and
- the priced product is `private`.

**Why lead-only.** On a `both` quote only the priced option has a stored `result`; the other
option's total is a live recompute. A breakdown on the recomputed card would reconcile to a
number that is not the approved one — which contradicts the rule `customerQuoteView` already
enforces, that the stored total wins and a recompute must never quietly outrank it. So if ops
priced chauffeur, ticking the box does nothing.

Rows are projected from `result.lineItems`. **Never** their `meta`, which carries the
founder-only `hotZone` annotation. The existing "never emits margin on any path" test in
`customerQuoteView.test.ts` guards this and must keep passing.

### Reconciliation — the invariant

Displayed leg price = the engine's figure rounded to the nearest dollar.

The reconciliation row is **computed as the remainder**, not read from the engine's
`price_adjustment`:

```
reconcile = totalCents − Σ(displayed leg amounts)
```

This is the guarantee. Whatever rounding does, and whatever the engine's finishing did, the
column lands on `totalCents` — which is the figure the pay link actually charges. Displayed
rounding can never change what is billed.

Worked example (Martina's itinerary, real engine output):

```
engine legs   45.08  31.80  59.17  51.12  59.17  36.23  78.89   = 361.46
displayed     45     32     59     51     59     36     79      = 361
total (charged)                                                 = 359
reconcile     359 − 361                                         = −2
```

`finishPrice`'s `nearestIncrement` (`priceFinish.ts:47`) can round **up**, so `reconcile` may
be positive. It is labelled by sign — "Rounded down −$2" when negative, "Rounding +$1" when
positive — rather than assuming a discount. When it is exactly zero the row is omitted.

On a discounted quote the discount is its own row above the total, or the column would not add
up.

### Extras

An extra attributed to a leg folds into that leg's displayed price, so the rail stays one row
per journey. An unattributed extra gets its own row above the reconciliation row.

### Rendering

In `quote.html`'s DAY BY DAY rail:

- Price right-aligned on the journey's header line (`.hop-t` becomes a flex row: title, price).
- Stay rows show "no charge" **once per stay block**, not on every consecutive stay row.
- Reconciliation row and Total at the foot of the rail, divided by a hairline.
- On a `both` quote the rail is labelled with the option the prices belong to, so the figures
  are never read against the chauffeur total.

Styles go in `quote.css`. Not `ticket.css` — `pay.html` shares `.hop` and must be unaffected.

## Out of scope

- Per-leg prices for chauffeur, in any form.
- A customer-openable expander. The gate is ops-side only.
- Per-leg prices on `pay.html` or `manage.html`.
- Letting a customer act on the breakdown (drop a leg, re-price). They reply on WhatsApp as
  they do today.

## Risks

- **Rate disclosure.** Any two priced rows make the per-km rate derivable. Accepted by the
  owner (decision 5); the per-quote gate is the mitigation.
- **Migration.** Merging it to `main` *is* its release to staging; prod follows on the next
  `main → production` promote. Additive with a default, so the blast radius is small, but it
  is a schema change and needs the owner's explicit go.
- **Drift.** The rail's leg prices and the ops timeline's leg prices come from the same
  `lineItems`, so they cannot disagree — provided the projection never re-derives them from
  `quoteBreakdown()`.

## Testing

Unit (`customerQuoteView.test.ts`):

- flag off → `legPrices` is `null`
- chauffeur-priced quote → `null` even with the flag on
- non-lead option → `null`
- **the invariant**: `Σ(rows) + reconcile === totalCents`, across a range of quotes including
  a discounted one, a floored short-hop one, and one where the finish rounded up
- margin-safety: the existing "never emits margin" assertion still passes with the flag on

E2E (`quote-page.spec.js`):

- prices render right-aligned on the journey header; stay rows read "no charge" once per block
- a `both` quote labels the rail with the option the prices belong to
- flag off → no prices anywhere in the rail

## Release

One migration, one API change, one page change. Staging first via `main`; prod only on an
explicit promote.
