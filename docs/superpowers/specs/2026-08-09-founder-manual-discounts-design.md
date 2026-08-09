# Founder manual discounts on Ops quotes — design

**Date:** 2026-08-09
**Status:** design and its pricing assumption (§5.3) approved by the owner 2026-08-09. No open
decisions. Build not started.
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

**As a founder**, I am stopped — not warned, stopped — from discounting below cost.

**As ops or finance**, I can see that a quote is discounted and the customer-facing amount, but I
cannot apply, change, or remove one, and I never see cost or margin.

## 3. Scope

### 3.1 In scope

- One manual discount per quote: `fixed` cents or `percentage` basis points.
- Founder-only, via a new `discount:apply_manual` capability.
- Eligible base is the **complete quote including extras** (parent §7.2).
- Absolute cost cap. No override exists for any role.
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
- Below-cost or complimentary quotes, by any role, by any route.

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
| `cap_reason` | text null — `'eligible_subtotal'` or `'estimated_cost'` |
| `estimated_cost_cents` | integer — founder-only. Always present: a discount cannot exist without it (§6) |
| `margin_before_cents`, `margin_after_cents` | integer — founder-only. **NOT NULL**, for the same reason |
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
| Did the cost cap bite? | `cap_reason` |
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
core pricing → apply the manual discount → psychological finishing → amount due
```

Unchanged from parent §7.5. Finishing runs exactly once, after the discount.

### 5.2 Percentage and caps

```text
requestedCents          = method === 'fixed'
                            ? value
                            : floor((eligibleSubtotalCents * value + 5_000) / 10_000)
maximumCostSafeDiscount = max(0, subtotalCents - estimatedCostCents)
appliedCents            = min(requestedCents, eligibleSubtotalCents, maximumCostSafeDiscount)
```

Round-half-up integer arithmetic throughout. `eligibleSubtotalCents` is the full quote subtotal
including extras (parent §7.2). A zero-cent result does not create a discounted state.

When the cost cap reduces the amount, `cap_reason = 'estimated_cost'` is recorded with both the
requested and applied figures, and the founder sees the difference. **It cannot be overridden.**

### 5.3 Extras cost basis — owner-approved 2026-08-09

Parent §17 requires owner-confirmed cost cents for the six chargeable extras (`sightseeing`,
`safari-wait`, `luggage`, `front`, `flex`, `waiting`) before any cost cap can honestly protect a
full-quote discount. That input has not arrived, and per-leg sightseeing attribution will
restructure three of the six before it is worth collecting.

**Owner decision (2026-08-09): treat every extra's cost as equal to its sell price** — zero
incremental margin — until real figures exist:

```text
estimatedCostCents = transportCostCents + extrasSellCents
```

This is **strictly conservative**. It can never permit a below-cost total; it only caps the
discount lower than strictly necessary on extras-heavy quotes, so the founder meets the cap
slightly early. Tightening it later, when real extras costs land, only ever *increases* available
headroom — it can never invalidate a discount already given.

`api/src/quote/rateCard.ts` gains no new sell-price fields and no existing arithmetic changes.

Worked example, for the reviewer. A $210 quote — $200 driving plus a $10 sightseeing fee —
where the driving costs $174 (sell = cost × 1.15):

| | Estimated cost | Max discount |
| --- | --- | --- |
| This assumption (sightseeing costs $10) | $184 | **$26** |
| Real figure, if sightseeing costs $4 | $178 | $32 |

The founder loses $6 of headroom on that quote and no safety. Supplying real costs later only
raises the ceiling; it can never invalidate a discount already given, which is why this is safe
to ship ahead of the data.

### 5.4 Shared quotes cannot be discounted

`engine.ts:143` sets `marginEstimateCents = null` for shared, because shared cost is not modelled
at all — the engine emits a `margin not modelled for shared` warning. Without a cost basis the
absolute cost cap cannot be honoured, so a discount on a shared quote would be unprotected.

**A shared Ops quote rejects any discount request with `discount_cost_unavailable`.** This is a
consequence of §6's fail-closed rule, not a separate policy, but it is stated explicitly here
because it is the one product where the rejection is guaranteed rather than exceptional, and it
must be covered by its own test rather than left to be discovered.

This also keeps the `margin_before_cents` / `margin_after_cents` columns NOT NULL: the only
product with a null margin can never produce a row.

### 5.5 Finishing on a discounted quote

`api/src/quote/engine.ts:123` currently calls:

```ts
finishPrice(subtotalCents, Math.max(costCents, protectedMinimumCents), rateCard.priceFinishing)
```

For a **discounted** quote the downward minimum becomes `costCents` alone, because a founder may
deliberately cross a sell-price fare floor but never cost (parent §3, "Fare floors"). The
undiscounted path keeps `Math.max(costCents, protectedMinimumCents)` exactly as it is.

Finishing's own limits are unchanged and apply to the **discounted** subtotal: the proportional
`maxReductionBps` cap and the absolute `MAX_REDUCTION_CENTS` ($10) cap, on the fixed $10 charm
grid (owner rule 2026-07-26).

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
- If cost cannot be computed, the server rejects with `discount_cost_unavailable`. It never
  trusts a browser-supplied amount.

### 6.1 The rate lock governs the cost cap

A quote priced against a locked rate card (`quotes.rate_card_json`, `rate_locked_until`) must
compute `estimatedCostCents` — and therefore the cost cap — **from that locked card**, never from
the live one. `rateCardFor()` already returns the live card once a lock expires, which is exactly
the trap: a founder reopening a stale quote would otherwise cap against today's costs while the
customer was quoted yesterday's.

The rule is the one the engine already follows for pricing: whichever card priced the quote also
costs it. This is the same class of bug the hot-zones design guards with its C2 rate-lock test,
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

**Discount arithmetic.** Fixed and percentage half-up boundaries; the optional maximum; extras
included in the eligible base; exact-at-cost; cap diagnostics; sell-floor crossing permitted;
cost-unavailable failing closed; zero-cent producing no discounted state.

**Shared.** A discount request against a shared Ops quote rejects with
`discount_cost_unavailable`, and no `quote_discounts` row is written (§5.4).

**Rate lock.** A quote locked against a snapshot card computes its cost cap from that card, not
the live one — including after `rate_locked_until` has passed, where `rateCardFor()` would
otherwise hand back the live card (§6.1). Changing the live card must not move the cap on a
locked quote.

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
