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
| 3 | The gap between legs and total | ~~Its own reconciliation row.~~ **Superseded — see Revisions.** The rounding is spread into the leg prices instead. |
| 4 | Placement | **In the DAY BY DAY rail**, price right-aligned on the journey's header line, invoice-style. |
| 5 | Rate exposure | **Accepted.** Per-leg money makes the ~$0.44/km rate derivable; that is inherent and the gate limits who sees it. |
| 6 | Number format | **Whole dollars**, summing exactly to the total. |
| 7 | Storage | **A new column** — the long-term solve, not the JSON shortcut. |

## Revisions — 2026-08-16, owner, after seeing it built

Three changes on the built feature. They supersede the decisions above wherever the two disagree;
the body of this spec has been updated to describe what actually ships.

1. **No reconciliation row.** Decision 3 gave the rounding remainder its own "Rounded down" line.
   The owner cut it. The requirement it existed to serve — the column must add up — stands, so
   the remainder is now spread across the leg prices instead. This is the option originally
   declined as "spread it across the legs"; removing the row makes it the only way to keep both
   whole dollars and an honest sum.

   **Consequence, accepted:** a leg on the customer's page can read up to $1 below the figure the
   ops timeline shows for that same leg (Martina's Kitulgala → Nuwara Eliya: engine $31.80, page
   $31). Quoting a leg by hand from the tool may not match what the customer is looking at.

2. **No "no charge" on stay days.** Stay rows render exactly as they did before this feature.
   The "you only pay for the days you're moving" claim goes unproven on the page; the owner
   preferred the quieter rail.

3. **Nothing at all on a quote that offers chauffeur.** The gate was "lead option and privately
   priced". It is now additionally: if the view carries more than one option, every option gets
   `null`. This replaces labelling the rail with the lead option's name — that code and its test
   were removed, since there is no longer a case where prices sit beside a chauffeur total.

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
  discount: { label: string; amountUsd: string } | null;
  totalUsd: string;
} | null
```

`null` unless **all** of:

- `quote.showLegPrices` is true, and
- the view carries exactly **one** option (revision 3 — a quote offering chauffeur shows no
  per-journey prices anywhere), and
- the option is the **lead** option (the one that was priced), and
- the priced product is `private` — tested against the engine's product, not the view's service,
  which maps every non-chauffeur product to `private`.

**Why lead-only.** On a `both` quote only the priced option has a stored `result`; the other
option's total is a live recompute. A breakdown on the recomputed card would reconcile to a
number that is not the approved one — which contradicts the rule `customerQuoteView` already
enforces, that the stored total wins and a recompute must never quietly outrank it. Revision 3
makes this moot for two-option quotes, but the rule stays as the inner guard.

**Row order.** Leg rows are ordered by `drivingRailOrder()`, which replicates `quoteDays.ts`'s
date sort — *including* its fallback to request order when any leg has an unparseable date. The
rail and the prices are matched positionally, and `quoteDays` sorts by date while the engine
prices in request order, so without this a quote whose legs were entered out of chronological
order puts every price on the wrong journey. The two sorts are duplicated and must be kept in
step by hand.

Rows are projected from `result.lineItems`. **Never** their `meta`, which carries the
founder-only `hotZone` annotation. The existing "never emits margin on any path" test in
`customerQuoteView.test.ts` guards this and must keep passing.

### The invariant

**`Σ(rows) − discount === totalCents`, exactly, for every input.** `totalCents` is the figure the
pay link actually charges. Display rounding can never change what is billed.

It holds by construction rather than by care: the rows are *derived from* the total, not summed
toward it. Let `target = totalCents + discountCents`. The displayed amounts are a distribution of
`target`, so their sum is `target` by definition, and `target − discount` is `totalCents`.

The distribution (revision 1 — the reconciliation row is gone):

1. Loose extra rows take their own value first, quantised as below. The legs absorb the remainder.
2. The rest is spread across the leg rows in proportion to their true engine amounts, by
   **largest remainder**, so the shares sum to exactly the remaining target.
3. **The quantisation unit follows the target.** If `target` is a whole number of dollars — the
   common case, since charm finishing lands on `…9.00` — rows are whole dollars. If `target`
   carries cents, rows are quantised in cents instead.

Step 3 exists because forcing whole dollars onto a cents-bearing target produced visibly broken
output: two *identical* $200 legs against a $397.54 target rendered `$199.54` and `$198`, because
$397.54 cannot split evenly into whole dollars. Following the target gives `$198.77` twice. A
future reader will be tempted to simplify this back to always-whole-dollars; that reintroduces the
bug.

Worked example (Martina's itinerary, real engine output):

```
engine legs   45.08  31.80  59.17  51.12  59.17  36.23  78.89   = 361.46
displayed     45     31     59     51     59     36     78      = 359
total (charged)                                                 = 359
```

Note the cost, accepted by the owner: the displayed leg is not the engine's figure for that leg.
Kitulgala → Nuwara Eliya shows $31 against an engine price of $31.80. The ops timeline still shows
the engine's figures, so the two can differ by up to $1 per leg.

On a discounted quote the discount keeps its own row above the total — revision 1 removed the
rounding row, not the discount.

### Extras

An extra attributed to a leg (`meta.legIndex`) folds into that leg's amount *before* the rows are
reordered for the rail, so it stays on its own leg. The rail keeps one row per journey. An
unattributed extra — which the engine emits with **no `meta` at all** — gets its own trailing row.

Driving legs are identified as the **first N line items**, N being the request's driving-leg
count, per the contract documented at `engine.ts:71-74`. They cannot be identified by "no
`meta.kind`": an unattributed extra has no meta either, and would land in the leg bucket and shift
every subsequent price onto the wrong journey.

### Rendering

In `quote.html`'s DAY BY DAY rail:

- Price right-aligned on the journey's header line (`.hop-t` becomes a flex row: title, price).
- Stay rows carry **no price element at all** (revision 2) — they render as they did before this
  feature existed.
- Any unattributed-extra rows, then the Discount row when present, then Total, at the foot of the
  rail, divided by a hairline. No rounding row (revision 1).
- No rail label. A quote offering chauffeur shows no prices at all (revision 3), so there is no
  longer a case where the figures could be read against the wrong total.

Styles go in `quote.css`. Not `ticket.css` — `pay.html` shares `.hop` and must be unaffected.
`pay.html` does not load `quote.css`, which is what makes that separation real.

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
- **Ops/customer divergence.** Revision 1 spreads the rounding into the legs, so a displayed leg
  can sit up to $1 below the engine's figure for it. The ops timeline shows the engine's figures.
  Quoting a leg by hand from the tool may not match the customer's page. Accepted.
- **Two duplicated rules.** The date sort is copied between `quoteDays.ts` and
  `customerQuoteView.ts`, and `customerQuoteView.ts` keeps a local `drives` predicate rather than
  importing `quote/legCategory.ts`. Both are load-bearing for putting the right price on the right
  journey. Adding a new non-driving category to `legCategory.ts` without updating the local copy
  would shift every price. Known, not fixed — the correct fix spans three files.

## Testing

Unit (`customerQuoteView.test.ts`):

- flag off → `legPrices` is `null`
- chauffeur-priced quote → `null` even with the flag on
- a quote carrying two options → `null` on both
- a `shared`-product quote → `null` (the gate reads the engine product, not the view service)
- **the invariant**: `Σ(rows) − discount === totalCents`, across a discounted quote, a single-leg
  quote, one where the finish rounded up, and one whose total carries cents
- identical legs against a cents-bearing total render identical amounts
- an unattributed extra keeps its full label and its own row; an attributed one folds into its leg
- legs stored out of chronological order still put each price on its own journey
- the engine's `price_adjustment` and `discount` rows are never rendered as journeys
- margin-safety: the existing "never emits margin" assertion passes with the flag ON and populated

E2E (`quote-page.spec.js`):

- prices render right-aligned on the journey header
- stay rows carry no price element
- flag off → no prices and no summary block anywhere in the rail

## Release

One migration, one API change, one page change. Staging first via `main`; prod only on an
explicit promote.
