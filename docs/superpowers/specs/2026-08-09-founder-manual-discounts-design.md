# Founder manual discounts on Ops quotes — design

**Date:** 2026-08-09
**Status:** approved by the owner 2026-08-09. **Revised the same day (§5.2–§5.5): the cost cap is
replaced by a 30% ceiling plus the vehicle fare floor.** No open decisions. Build not started.
**Parent:** [`2026-07-15-discounts-design.md`](./2026-07-15-discounts-design.md) — the full
discounts/promotions design. This document is **phase 1** of it: the manual arm only. Every
decision here is drawn from the parent; where this document is silent, the parent governs.
**Milestones:** re-cut M18–M20 (see `docs/build-plan.md`)

## 1. Problem

A founder closing a deal has no way to reduce a quote. The options today are to hand-edit the
itinerary until the number looks right — losing the record of what was actually offered — or to
settle the difference off-system. Neither leaves a trace of who decided, why, or what it cost.

The parent spec designs the whole surface: manual discounts, automatic promotions, promo codes,
website integration. That is a large build gated on owner data that has not arrived. This phase
takes the piece with the clearest value and the fewest dependencies — **a founder applying a
fixed or percentage discount to one Ops quote** — and ships it with the audit trail the owner
asked for on 2026-08-09:

> "I need tracking for who created the discount, before and after prices, when it was set up
> etc etc like actual tracking."

## 2. User stories

**As a founder**, I can apply a discount to an editable quote — either a dollar amount or a
percentage — and I must give a reason. The quote reprices server-side and shows the customer a
single friendly discount row.

**As a founder**, I can replace or remove that discount while the quote is still editable, and
every one of those actions is recorded.

**As a founder**, I can open a quote's discount history and see: who applied it, when, what they
asked for, what was actually allowed, what the quote totalled before and after, and what it did
to the margin.

**As a founder**, I am stopped — not warned, stopped — from taking more than 30% off, or from
bringing the total below the vehicle's minimum fare.

**As ops or finance**, I can see that a quote is discounted and the customer-facing amount, but I
cannot apply, change, or remove one, and I never see cost or margin.

## 3. Scope

### 3.1 In scope

- One manual discount per quote: `fixed` cents or `percentage` basis points.
- Founder-only, via a new `discount:apply_manual` capability.
- Discount is taken off the **subtotal**, extras included.
- Exactly two limits, neither overridable: **max 30% of subtotal**, and the final total may not
  fall below the quote's **vehicle fare floor** (§5.2–§5.3). No cost estimate is involved.
- Append-only history with full attribution and before/after money (§4).
- A `Discounted` badge derived from the quote result, not a lifecycle status.
- Rendering the stored discount on the Ops quote, the customer quote page, pay pages, and
  generated WhatsApp/email output.

### 3.2 Out of scope — deferred to phase 2

Everything else in the parent spec:

- Promotion rules, automatic matching, promo codes, and the `promotion_rules` table.
- Redemption budgets and the `promotion_exhausted` path.
- Website `/quote/v2` promotion resolution (parent M21.3) and the public promo-code UI.
- Route, tour, and sitewide scoping, and therefore all canonical route-identity work.
- `discount_events`. See §4.4 — it earns nothing until promotion rules exist.

### 3.3 Explicitly forbidden in phase 1

- **A discounted quote may not mint a partial-leg pay link.** Owner decision 2026-08-09, parent
  §18.1 option 1. Allocating one discount across a ticked subset of legs is undesigned; the link
  mint fails closed with `not_linkable` when an active discount exists.
- A total below the quote's vehicle minimum, a discount over 30%, or a complimentary quote — by
  any role, by any route.

## 4. What gets stored

One new table. It is append-only in effect: a row is written on apply, and superseded — never
mutated in place — on replace or remove.

### 4.1 `quote_discounts`

| Column | Type / rule |
| --- | --- |
| `id` | uuid primary key |
| `quote_id` | uuid, FK to `quotes` |
| `quote_revision` | integer — the quote revision this was applied at. **A stamp, not a foreign key**: `quote_revisions` holds only *superseded* states, so the live revision has no row there until it is superseded (see `schema.ts`, migration `0040`) |
| `source` | text, `'manual'`. Phase 1 writes nothing else; `'promotion'` arrives with phase 2 |
| `method` | `'fixed'` or `'percentage'` |
| `value` | integer — cents for fixed, basis points for percentage |
| `reason` | text **NOT NULL** — mandatory for a manual discount |
| `subtotal_before_cents` | integer — gross subtotal at the moment of application |
| `total_before_cents` | integer — what the quote totalled before, post-finishing |
| `requested_cents` | integer — what the founder asked for, before caps |
| `applied_cents` | integer — what was actually removed after caps |
| `total_after_cents` | integer — what the quote totals now, post-finishing |
| `cap_reason` | text null — `'percentage_cap'` or `'vehicle_minimum'` (§5.2) |
| `estimated_cost_cents` | integer — founder-only. **Reporting only**; the cap no longer uses it (§5.2) |
| `margin_before_cents`, `margin_after_cents` | integer — founder-only, reporting only. Nullable: the engine returns `null` margin for shared, and although shared cannot be discounted today the column should not encode that as a constraint |
| `applied_by` | text **NOT NULL** — staff email |
| `applied_at` | timestamptz |
| `status` | `'active'`, `'replaced'`, or `'removed'` |
| `superseded_by` | text null — who replaced or removed it |
| `superseded_at` | timestamptz null |

A partial unique index permits **one `status = 'active'` row per quote**. Money columns carry
non-negative check constraints. Rows are never deleted.

### 4.2 Why before/after totals are stored, not computed

`total_after_cents` is **not** `total_before_cents − applied_cents`. Psychological finishing runs
*after* the discount (§5.5), so the final total carries an adjustment that depends on the
discounted subtotal. Recomputing it later — against a rate card that may have changed — would not
reproduce the number the customer was shown.

The same argument applies to margin: `margin_before_cents` and `margin_after_cents` are the
figures **as they stood when the founder decided**. Storing them means the history stays truthful
after the rate card moves. This is the owner's "actual tracking" requirement read literally.

### 4.3 What this gives you

Every question the owner asked, answerable from one table without a join:

| Question | Column |
| --- | --- |
| Who set it up? | `applied_by` |
| When? | `applied_at` |
| Why? | `reason` |
| What was the price before? | `total_before_cents` |
| What is it now? | `total_after_cents` |
| What did they ask for vs what were they allowed? | `requested_cents` vs `applied_cents` |
| Which limit bound, if any? | `cap_reason` |
| What did it cost us? | `margin_before_cents` − `margin_after_cents` |
| Who took it away? | `superseded_by`, `superseded_at` |

### 4.4 No `discount_events` in phase 1

The parent spec (§11.3) adds an append-only event stream alongside this table. In phase 1 it
would duplicate what `quote_discounts` already holds, against a `quote_revisions` table that
already records per-revision totals. A third audit system earns its place when **promotion rule
lifecycle** events exist — create, version, deactivate — which have no home in a per-quote table.
Deferred to phase 2, deliberately.

## 5. The arithmetic

### 5.1 Order of operations

```text
core pricing → psychological finishing → apply the manual discount → amount due
```

**Reversed 2026-08-09 (owner), and this supersedes parent §7.5.** Finishing runs BEFORE the
discount. The owner's reason:

> "We usually send these quotes to customers and then customers negotiate."

A quote goes out at its finished price, and the customer negotiates off **that**. So the founder's
figure comes off the number the customer was actually shown, and the three figures on a customer
breakdown reconcile exactly:

```text
$62.00 quoted − $10.00 off = $52.00 to pay
```

Discounting first (the original design) re-finished the reduced subtotal, so $10.00 off $62.00
landed at **$51.99** — the founder's own figure appeared nowhere, and no customer-facing breakdown
could be made to add up without exposing the internal finishing row.

Two consequences worth stating:

- **Both limits now apply to the finished total**, not to a pre-finishing subtotal the customer
  never saw. `resolveDiscount` takes `quotedTotalCents`.
- **The undiscounted path is byte-identical to pre-feature behaviour by construction** — finishing
  sees exactly what it always saw. The golden corpus proves it without a single snapshot changing.

### 5.2 The whole rule — two limits, nothing else

**Revised 2026-08-09 (owner). This supersedes the cost-cap design entirely.** The founder
discounts the subtotal. Exactly two limits apply:

```text
requestedCents = method === 'fixed'
                   ? value
                   : floor((subtotalCents * basisPoints + 5_000) / 10_000)

percentageCap  = floor(subtotalCents * 30 / 100)          -- never more than 30% off
floorHeadroom  = max(0, subtotalCents - protectedMinimumCents)

appliedCents   = min(requestedCents, percentageCap, floorHeadroom)
```

Round-half-up integer arithmetic. A zero-cent result does not create a discounted state.

`cap_reason` records which limit bound: `'percentage_cap'`, `'vehicle_minimum'`, or `null`.
Neither can be overridden by any role.

**There is no cost estimate, no extras cost basis, and no `discount_cost_unavailable`.** Those are
deleted from this design. Cost still exists in the engine and `marginEstimateCents` is still
recorded on the history row (§4) — but as *reporting*, never as a control.

### 5.3 Why the floor, and not cost

The owner's reason, recorded because it is not obvious from the code (2026-08-09):

> A per-kilometre cost estimate is meaningless exactly where discounting is most dangerous. In
> Sri Lanka a driver does not charge by distance for a short job — they charge a minimum to take
> the work at all. Roughly **$20–23 of a car's $29 minimum** and **about $40.43 of a van's $49.99**
> goes straight to the driver. The engine's `costCents` for a 25 km van run is $14.10, which
> implies $35 of headroom that does not exist.

So the fare floor — not the modelled cost — is the real protection, because the floor *is* the
driver minimum. The engine already computes exactly this:

```ts
protectedMinimumCents = rides.length * rateCard.floorCents[vehicle]   // engine.ts:58
```

One driver minimum per leg, which is the right shape: a three-leg car day is three drivers each
taking a minimum. The discounted total may never fall below it.

Floors come from `rateCard.floorCents` and are **read, never hardcoded**, so this rule tracks the
rate card and cannot drift from it:

| Vehicle | Minimum | Note |
| --- | --- | --- |
| `car` | $29.00 | owner-confirmed 2026-08-09 |
| `van` | $49.99 | the existing floor; the owner said "49", and reading the card resolves it |
| `van9` | $49.99 | tracks van, as the owner chose for the larger tiers |
| `van14` | $85.00 | its own, higher — a bigger vehicle's driver minimum is higher |
| `custom` | $110.00 | operator-priced; the 30% cap still applies |

**Chauffeur has no `protectedMinimumCents`** — `engine.ts:58` sets it only on the private branch,
so it stays `0`. A chauffeur quote is therefore bounded by the 30% cap alone, which is correct:
chauffeur is day-rate priced and has no per-leg driver minimum to protect.

### 5.4 Shared quotes cannot be discounted

Shared is per-seat corridor pricing with no vehicle and therefore no floor, and it is excluded
from discounts in the parent design. A discount request against a shared Ops quote is rejected.
This is stated explicitly, and tested, rather than left to be discovered.

### 5.5 Finishing is untouched by the discount

`engine.ts:123` stays exactly as it is:

```ts
finishPrice(subtotalCents, Math.max(costCents, protectedMinimumCents), rateCard.priceFinishing)
```

with `rawCents` becoming the **discounted** subtotal on a discounted quote — the only change, and
it follows from §5.1's ordering rather than from any new policy.

The minimum argument is left alone. That is safe by construction: `appliedCents` is already capped
at `floorHeadroom`, so the discounted subtotal is `>= protectedMinimumCents` before finishing sees
it, and `finishPrice` never returns below its minimum. The floor therefore holds through finishing
without the call being touched.

An earlier draft of this design changed that second argument to `costCents` alone, so a founder
could cross the fare floor. **That is now exactly backwards** — the floor is the protection.

### 5.6 The discount line item

The engine emits one negative line item, tagged:

```ts
{ label: '<friendly label>', amountCents: -appliedCents, meta: { kind: 'discount' } }
```

**`api/src/quote/paySelection.ts` must be taught to skip it**, exactly as it already skips
`meta.kind === 'price_adjustment'`. That module parses `result.lineItems` positionally — its own
comment reads *"position is the contract"* — and an untagged negative item would be mis-read as a
tickable extra on the hosted pay page, with the wrong `extraIndexes` stored against a link.
Parent §6 and §18.5 record the full failure mode.

This is a two-line change to a shipped money module and it ships **in the same PR as the line
item**, never after.

## 6. Lifecycle

- A founder may apply, replace, or remove a discount while the quote is **editable**. Ready/sent
  quotes use the existing reopen flow first.
- Discount intent on save is tri-state: **omitted** preserves, a **request** adds or replaces,
  explicit **`null`** removes.
- Quote save and the `quote_discounts` write are **one Postgres transaction**. A failure rolls
  back both.
- Any discount change invalidates prior approval, exactly as a price-input change does today.
- Approval freezes the rate card, the discount snapshot, the calculation, and the FX basis.
- The server never trusts a browser-supplied amount: it recomputes `appliedCents` from the stored
  quote on every save.

### 6.1 The rate lock governs both limits

A quote priced against a locked rate card (`quotes.rate_card_json`, `rate_locked_until`) takes
**both** its subtotal and its `floorCents` from that locked card, never from the live one.
`rateCardFor()` returns the live card once a lock expires, which is exactly the trap: raise the
van floor on the live card and a founder reopening a stale quote would be limited by a floor the
customer's price was never built on.

The rule is the one the engine already follows for pricing: whichever card priced the quote also
limits it. This is the same class of bug the hot-zones design guards with its C2 rate-lock test,
and it gets an equivalent test here.

### 6.2 Concurrent edits — accepted, not solved

`quotes.revision` is a counter, not an optimistic-concurrency token: `internalQuote.ts` has no
`quote_conflict` response, and its 409s are `not_editable`, `quote_deleted`, `not_bookable` and
`not_linkable`. Two people editing one quote is therefore a lost update today, discount or not.

**Phase 1 does not fix this**, deliberately. Only founders can apply a discount, there is one
founder, and adding a stale-edit gate means changing the save contract for every Ops quote — a
wider blast radius than this feature earns. Parent M20.2 carries the proper fix; it moves to
phase 2 alongside the promotion work that makes multi-editor contention realistic.

Recorded here so a reviewer sees a decision rather than an oversight.

### 6.3 Outstanding pay links die — and the founder must be told

`api/src/routes/internalQuote.ts:1064` signs the pay-link capability over `{quoteId, revision}`.
Applying, replacing, or removing a discount saves the quote and bumps `revision`, which
**invalidates every outstanding pay link for that quote**.

That is correct behaviour — a link minted at the old price must not keep charging it — but it is
currently silent. The Ops UI must warn at the point of applying a discount when a live link
exists, and say plainly that the link will stop working and needs re-sending.

## 7. Reading it

`GET /internal/quotes/:id/discounts` returns the full history, newest first, mirroring the
existing `GET /:id/revisions` endpoint and its UI panel.

Role projection is enforced server-side, not by hiding controls:

| Field | Founder | Finance / Ops |
| --- | --- | --- |
| `applied_cents`, `total_before_cents`, `total_after_cents`, `reason`, `applied_by`, timestamps | yes | yes |
| `estimated_cost_cents`, `margin_before_cents`, `margin_after_cents`, `cap_reason` | yes | **stripped** |

The existing `stripQuoteMargin()` pattern in `internalQuote.ts` is the model.

## 8. Permissions

| Capability | Founder | Finance | Ops | System |
| --- | --- | --- | --- | --- |
| `discount:apply_manual` | yes | no | no | no |

`promotion:manage` is **not** added in phase 1 — there are no promotions to manage. Existing
`quote:manage` and `quote:approve` are unchanged. Routes enforce the capability and CSRF
centrally; a hidden browser control is not authorization.

## 9. What is NOT changing

- Shared-seat pricing, inventory, and its exclusion from finishing.
- The public website. No customer can trigger a discount in phase 1; there is nothing to trigger.
- `/quote`, `/quote/lock`, and `/quote/v2` behaviour. Quote v2 stays flag-gated as it is today.
- The full-payment policy. `amountDueNowCents = totalCents` for the discounted total.
- Legacy quotes and bookings with no discount row, which stay cent-identical forever.
- `bookings.subtotal` / `discount_total` / `pricing_snapshot_json` already exist from SH5;
  phase 1 begins writing a real `discount_total` instead of the hard-coded `0` at
  `api/src/db/quoteConversionRepo.ts:169`.

## 10. Testing

**The zero-discount gate.** Golden fixtures for current behaviour, committed as reviewed
constants, before any production code changes: private vehicle classes and floors (van minimum is
**$49.99**, not $50.00 — PR #349), chauffeur day/distance/idle-day, extras, multi-stop legs with
`via_stops`, finishing across charm / nearest-50 / unchanged / protected-minimum, and a
partial-leg pay link at `sold_cents`. Every later step proves an omitted discount leaves these
cent-identical.

**Discount arithmetic.** Fixed and percentage half-up boundaries; extras included in the base;
the 30% ceiling binding exactly at the boundary; the vehicle floor binding exactly at the
boundary; both binding at once with the smaller winning; `cap_reason` naming the right one;
zero-cent producing no discounted state; a request larger than the subtotal.

**The floor, per vehicle and per leg.** car $29.00, van and van9 $49.99, van14 $85.00, custom
$110.00, each read from `rateCard.floorCents` rather than hardcoded — a fixture proving a card
change moves the limit. A three-leg car quote floors at 3 × $29.00, not $29.00. Chauffeur has no
floor (`protectedMinimumCents` stays 0) and is bounded by the 30% cap alone.

**Shared.** A discount request against a shared Ops quote is rejected and no `quote_discounts`
row is written (§5.4).

**Rate lock.** A quote locked against a snapshot card takes both its subtotal and its
`floorCents` from that card, not the live one — including after `rate_locked_until` has passed,
where `rateCardFor()` would otherwise hand back the live card (§6.1). Raising a floor on the live
card must not move the limit on an already-locked quote.

**Finishing.** Runs once, after the discount, off the discounted subtotal; never below cost;
both the bps and the absolute $10 limit; a discount crossing a $10 grid boundary pins its
expected candidate.

**Line items.** `paySelection.payLines()` skips the discount item; a discounted quote's
`extraIndexes` still align with `engine.extras`; the hosted pay page never renders a tickable
negative line.

**Persistence.** One active row per quote; replace and remove leave complete history; injected
transaction failure rolls back both the quote and the discount row; stored before/after totals
match what the engine produced.

**RBAC.** Founder / finance / ops / system matrix on apply, replace, remove, and read; CSRF;
margin and cost stripped for non-founders including nested inside a stored quote result.

**Workflow.** Approval invalidated by a discount change; reopen path; the pay-link mint refusing
a discounted quote; the outstanding-link warning.

Tests use fake Maps, payments, email, and clock, per the repo's existing harness.

## 11. Rollout

One flag: `OPS_MANUAL_DISCOUNTS_ENABLED`, default **off**, available before any route or UI ships.

1. Land the migration and repositories with the flag off. Reading an existing discount is
   unconditional; only creation is gated.
2. Land the engine arithmetic and the `paySelection.ts` fix together, with the zero-discount
   fixtures green.
3. Land the Ops API and UI behind the flag.
4. Enable on staging. Apply, replace, remove, approve, send, convert, and pay a discounted quote
   end to end against PayHere sandbox.
5. Enable in production.

Rollback turns off **creation**, never an existing promise: a quote already discounted still
converts and pays at its stored amount with the flag off. That property is proved by test, not
asserted.

The migration merges to `main` and therefore reaches staging on merge, per the repo's
auto-migrate-on-boot rule. It is additive and nullable — no existing row changes.
