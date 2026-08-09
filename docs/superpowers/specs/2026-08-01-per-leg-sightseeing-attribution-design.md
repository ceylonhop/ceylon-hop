# Per-leg sightseeing attribution — design

**Date:** 2026-08-01
**Status:** approved, ready for implementation plan
**Scope:** ops quote tool + quote engine. No website/customer-booking changes.

**Applies to all three per-leg toggles.** Sightseeing is the one that prompted this, but
`addSightseeingFee`, `addWaitingFee` and `addSafariWait` all flow through the same
`collectExtras` → `priceExtras` path and all three lose their leg identity the same way.
Attributing only sightseeing would leave two neighbouring rows behaving inconsistently, so
attribution applies to all three. D2 (chauffeur emits nothing) likewise covers all three —
they are all in `CHAUFFEUR_INCLUDED_EXTRAS`.

## Why

Sightseeing is a $10 per-leg add-on on private transfers. Ops ticks it per leg and the
engine charges it per leg — that part works today and is not being rebuilt.

What is missing is **attribution**. `collectExtras` flattens the per-leg toggles into a
bare `ExtraCode[]`, so two ticked legs become `['sightseeing','sightseeing']`. The leg
identity is destroyed before pricing, and the quote ends up with two identical
`Sightseeing stops (up to 3h) — $10` rows and nothing anywhere saying which legs they
belong to. Ops has to remember; the traveller can only guess.

## What already works (do NOT rebuild)

Verified on `main` and `production` before this design was written:

- Per-leg `+ Fees` chip → Sightseeing / Waiting / Safari wait, on every leg that is not a
  chauffeur leg and not a stay day (`ops-ui.html`).
- Each ticked leg bills its own extra — `collectExtras` pushes one entry per leg, no dedupe.
  Three ticked legs = 3 × $10.
- Sightseeing is already $10 (`rateCard.ts` `sightseeing: 1000`, mirrored to
  `transfers-data.js` as `10`). **This design changes no prices.**
- Chauffeur never charges it — the engine, not the UI, enforces that.

## Owner decisions taken during design

| # | Decision |
|---|---|
| D1 | **Stops never imply sightseeing.** A stop may just be a pickup along the way. Sightseeing stays an explicit tick, available on multi-stop legs exactly as on 2-stop legs. |
| D2 | **Chauffeur shows nothing.** The `$0 (included)` line items are removed entirely rather than deduped. The car is the traveller's all day; the charge is not a line worth printing. |
| D3 | **Website is parked.** The extras block stays hidden on multi-leg trips. No `booking.html` / `booking.js` changes. |
| D4 | **Warnings are kept.** The ops-facing `"sightseeing included in chauffeur day rate"` warning stays — it is the only remaining trace that a flag arrived and was deliberately ignored, which matters because the toggle is hidden under chauffeur. |

## User stories

Satisfied today, protected by this change:

1. As ops pricing a private multi-leg transfer, I tick Sightseeing only on the legs that
   need it, and each ticked leg adds $10.
2. As ops pricing a leg whose stops are just pickups, nothing is charged automatically.
3. As ops pricing a chauffeur trip, the toggle does not appear.
4. As the business, a chauffeur quote arriving with sightseeing flags set is still never
   charged — the rule lives server-side, not in a UI that can be bypassed.

Delivered by this change:

5. As ops reviewing the money pane, I can see which leg each sightseeing charge belongs to.
6. As a traveller reading my quote, the sightseeing is attached to the Kandy → Ella day,
   not stacked anonymously at the bottom.
7. As ops explaining a quote over WhatsApp, I can name the sightseeing days without
   reopening the builder.

## Design

### 1. Engine interface — widened, not replaced

```ts
type ExtraInput = ExtraCode | { code: ExtraCode; legIndex?: number }
```

`QuoteRequest.extras` accepts either shape and normalizes once at engine entry.

This is deliberately back-compatible. The four other producers of `extras` —
`routes/quote.ts`, `services/pricing.ts`, `domain/singleTransfer.ts`, and
`services/__fixtures__/sampleBookings.ts` — keep passing plain `ExtraCode[]` and are not
touched. An unattributed extra prices and labels exactly as it does today.

**Expected consequence:** `goldens.test.ts` should be byte-identical. If a golden moves,
stop and investigate — it means the normalization is not behaviour-preserving.

Rejected alternatives:

- *Retype `extras` to `{code, legIndex}[]` outright.* Cleanest model, but it breaks an
  existing engine interface and drags every caller, golden, and test into a labelling fix.
  CLAUDE.md rule 5 says an interface change is its own step.
- *Parallel `extraOrigins?: number[]` beside an untouched `extras`.* Smallest diff, but two
  arrays that must stay index-aligned with nothing in the type system holding them together.
- *Attribute at the route boundary, rewriting labels after `quote()` returns.* Requires
  replaying the engine's internal ordering — and the chauffeur path regroups extras into
  included/chargeable — so it couples the route to engine internals that are free to change.

### 2. `collectExtras` carries the leg index

`internalQuote.ts` emits `{ code, legIndex }` instead of a bare code.

**The index must be the driving index the engine uses, not the raw `state.legs` index.**
Stay days are filtered out before pricing, so on any trip containing an idle day those two
indices diverge and every attribution after the stay day would name the wrong leg. This is
the single most likely place for the change to go quietly wrong, and it needs a test with a
stay day sitting between two ticked legs.

`ops-ui.html` already documents this hazard: travel line items are indexed by *driving*
position, not `state.legs` position.

### 3. `priceExtras` names the leg

An attributed extra produces:

- `label: "Sightseeing stops (up to 3h) — Kandy → Ella"`
- `meta: { kind: 'extra', code, legIndex }`

The engine already holds the normalized rides, so it resolves the leg name itself. Every
consumer reading `result.lineItems` — the ops money pane, the customer quote, the share
card — inherits attribution with no per-consumer work.

An unattributed extra (`legIndex` absent) keeps the bare label. That is what preserves the
website and `singleTransfer` paths unchanged.

`meta` is an established pattern here, not a new concept: `LineItem.meta` already carries
`billableKm`, `hotZone`, and `kind: 'price_adjustment'`.

### 4. Chauffeur emits no extras line items

Per D2, the `$0 (included)` line items are dropped. The chauffeur total is unchanged — it
was already zero. Warnings are retained per D4.

### 5. Invariant to preserve

**Extras must continue to be pushed after travel line items.** `ops-ui.html` splits
`lineItems` into travel-vs-extras by `meta.billableKm`, falling back to "the first N items
are the driving legs". Today that ordering is guaranteed only by the order of two `push`
calls in the engine. This design adds an explicit test for it, because the change edits
that exact region.

### 6. Rider

The comment in `ops-ui.html` describing `+ Fees` as *"point-to-point only"* predates
multi-stop rides and contradicts D1. Correct the sentence. Comment only, no behaviour change.

## What does not change

- **Any amount.** $10 per ticked private leg; $0 on chauffeur. No `rateCard.ts` edit, so no
  `npm run generate`, no front-end price mirror change, no parity-test movement.
- **DB schema.** No migration. Leg flags are already persisted as booleans.
- **`notifications.ts`.** Booking emails carry their own extras label map and are fed by
  booking extras, not quote line items. The plan verifies this rather than assuming it.
- **Website booking flow.** Per D3.

## Testing

Red → green per CLAUDE.md maintenance rule 5.

New coverage:

- Two ticked legs on a private multi-leg quote produce two line items naming *different*
  legs, and the total is unchanged from today.
- A trip with a **stay day between two ticked legs** attributes both to the correct legs —
  the driving-index regression guard from §2.
- A chauffeur quote with flags set produces **no** extras line items, an unchanged total,
  and still emits the warnings.
- Extras line items sort after travel line items (§5 invariant).
- An unattributed `extras: ['sightseeing']` request is unchanged — same label, same amount.

Existing tests to update:

- `engine.test.ts` — the chauffeur included-line assertions, now that those rows are gone.
- `internalQuote.test.ts` — the chauffeur-vs-private extras assertions; extend the private
  cases with attribution.
- `goldens.test.ts` — expected unchanged; treat any movement as a red flag, not a rebaseline.
- `web-tests/e2e/quote-tool.spec.js` — check whether any assertion pins an extras label.

Gate: `cd api && npm run check` plus `npm run test:all` green before the PR.

## Delivery

One PR off `main`, in an isolated worktree (`worktree-sightseeing-leg-attribution`) since
several sessions share the primary tree. Merging to `main` deploys to staging; production
is a separate promote PR and is not part of this work.
