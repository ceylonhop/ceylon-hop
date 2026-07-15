# Discounts across quotes, bookings, and customer surfaces

**Date:** 2026-07-15
**Status:** Approved for milestone planning; implementation not started
**Milestones:** M18-M20
**Depends on:** M11 authoritative pricing, M12 Ops/RBAC, and the psychological-pricing contract

## 1. Problem

Ceylon Hop needs two discount mechanisms:

1. Founder-applied manual discounts in the Ops quoting tool.
2. Founder-created public promo codes that customers can apply on the website.

Discounts affect more than the displayed quote total. The same amount must survive quote edits,
approval, the seven-day web rate lock, booking creation, checkout, PayHere, confirmation, customer
messages, and reporting. The existing system also has deliberate behavior that must remain intact:

- The backend quote engine is authoritative for money.
- Ops quotes remain editable until approval; approval locks their rate card.
- A customer web quote locks a rate card for seven days and may be repriced as the itinerary changes.
- Website booking routes resolve distances server-side before persisting money.
- Checkout charges the booking's stored `amountDueNow`.
- Customer bookings currently pay in full. The engine's deposit figure is informational and this
  feature must not activate deposit collection.
- Shared seats use authoritative corridor prices and transactional inventory holds.
- Psychological price finishing runs once after core pricing and may never undercut its protected
  minimum automatically.

A discount implementation that exists independently in the website, Ops UI, and booking routes
would drift. Discount decisions and arithmetic therefore live in the backend pricing domain;
clients render the structured result.

## 2. Owner decisions

The owner confirmed on 2026-07-15:

| Decision | Policy |
| --- | --- |
| Launch mechanisms | Manual Ops discounts and public promo codes |
| Human authority | Founder only |
| Breaching fare floor or estimated cost | Allowed, with founder-only warnings and confirmation |
| Public promo eligibility | Private transfers, chauffeur trips, and tours; never shared seats or extras |
| Promo expiry after lock | A promo valid when locked remains valid for that quote's full seven-day lock |
| Stacking | One active discount per quote or tour |

Only founders can create/deactivate promo rules, apply or remove a manual discount, replace an
existing discount, or approve a discounted Ops quote. A customer may redeem a valid public code;
that is use of a founder-approved rule, not a privileged staff action.

## 3. Scope

### 3.1 In scope

- Fixed-amount and percentage manual discounts in Ops.
- Fixed-amount and percentage public promo rules.
- One active discount per quote.
- Founder-only controls, warnings, reasons, and approval.
- Discount snapshots on Ops and web quotes.
- Seven-day public promo durability when the promo was valid at lock time.
- Structured discount display in Ops, website booking summary, confirmation, customer booking view,
  checkout, email, and manually copied WhatsApp output.
- Immutable booking pricing snapshots and a source-quote link.
- Promo expiry, optional rule-level redemption limits, reservation, and redemption tracking.
- Exact integer-cent arithmetic, parity tests, auditability, and a guarded rollout.

### 3.2 Out of scope

- More than one discount on a quote.
- Promo codes on shared-seat bookings.
- Public promo discounts on extras.
- Per-customer redemption limits. The public website has no customer account and identity is not
  known at initial quote time, so a reliable per-person limit needs a separate abuse-control design.
- Automatic campaign/surge/loyalty pricing.
- Gift cards, account credits, referral balances, or vouchers with stored monetary value.
- Zero-value/complimentary bookings. The existing booking and payment flow expects a positive amount;
  a comped-booking workflow is a separate feature.
- Partial-refund allocation and accounting integration.
- A generic organization-wide audit framework. This feature records its own attributed history.

## 4. Terminology and amount contract

All authoritative amounts are integer USD cents. Percentage values are integer basis points.

| Term | Meaning |
| --- | --- |
| Gross subtotal | Current engine subtotal after core fares and extras, before discount and finishing |
| Eligible subtotal | Portion against which this discount may be calculated |
| Discount total | Positive number of cents removed by the one active discount |
| Discounted subtotal | Gross subtotal minus discount total |
| Finishing adjustment | Signed psychological adjustment applied after the discount |
| Final total | Amount presented to the customer and stored on the quote/booking |

The invariant is:

```text
discountedSubtotalCents = subtotalCents - discountCents
totalCents = discountedSubtotalCents + priceAdjustmentCents
amountDueNowCents = totalCents
```

`QuoteResult.subtotalCents` keeps its current pre-finishing meaning and becomes the gross,
pre-discount subtotal. This avoids silently changing the meaning of a stable interface.

The extended result adds:

```ts
discountCents: number;
discountedSubtotalCents: number;
discount: AppliedDiscountSnapshot | null;
```

The line-item order is:

1. Existing core transport/chauffeur items.
2. Existing extras.
3. One negative customer-facing discount item, when applied.
4. Existing internal final-price adjustment item, when applied.

The complete line-item sum must equal `totalCents`. Customer drafts show the friendly discount row
but continue hiding the internal price-finishing label; the customer-row renderer must still
reconcile exactly to the final total.

## 5. Eligibility and calculation

### 5.1 Public promo

- Eligible products: private transfer and chauffeur/tour.
- Ineligible product: shared.
- Eligible subtotal: core private/chauffeur/tour charges only.
- Extras remain at their full amount and are excluded from the percentage base and fixed-discount
  ceiling.
- A fixed promo cannot remove more than the eligible subtotal.
- A percentage promo is calculated from the eligible subtotal, then limited by the rule's optional
  `maxDiscountCents`.
- A rule may define a minimum eligible subtotal.
- A public rule can cross a fare floor or cost basis because the founder explicitly created it.
  The founder sees that risk while configuring/testing the rule; the customer never sees cost data.

### 5.2 Manual Ops discount

- Eligible products are those supported by the Ops quote builder: private and chauffeur/tour.
- Eligible subtotal is the complete Ops quote subtotal, including extras. The public-only exclusion
  for extras does not restrict a founder's explicit manual quote adjustment.
- The founder may enter either fixed cents or a percentage in basis points.
- There is no global manual-discount cap. The founder is the sole authority and may deliberately
  cross the fare floor or cost basis.
- Final total must remain positive and compatible with the existing minimum accepted booking amount.
- A reason is mandatory. Crossing a floor or cost requires an additional explicit confirmation.

### 5.3 Integer arithmetic

Percentage discount cents use round-half-up integer arithmetic:

```text
percentageDiscount = floor((eligibleSubtotalCents * basisPoints + 5,000) / 10,000)
```

The engine applies the smallest of:

- The calculated/requested amount.
- The rule's optional maximum amount.
- The eligible subtotal.
- The amount that leaves the final pre-finishing total positive.

No browser or Ops JavaScript independently calculates the authoritative discount.

### 5.4 Psychological finishing interaction

The order is fixed:

```text
core pricing -> discount -> psychological finishing -> amount due
```

The finishing module's 2.5% reduction limit is calculated from the discounted subtotal. A discount
may explicitly cross the protected fare floor or cost basis; psychological finishing may not cross
it automatically. If the discounted subtotal is already below the finishing minimum, finishing
returns `unchanged` rather than reducing it further.

Shared prices remain outside psychological finishing and outside public discounts.

## 6. Discount representations

### 6.1 Discount request

Only server routes accept unresolved requests:

```ts
type DiscountRequest =
  | { source: 'promo'; code: string }
  | { source: 'manual'; method: 'fixed'; amountCents: number; reason: string }
  | { source: 'manual'; method: 'percentage'; basisPoints: number; reason: string };
```

Public callers may submit only the `promo` arm. Manual arms require a founder identity. Clients never
submit `appliedCents`, cost, margin, or an authorization override.

### 6.2 Resolved instruction

A discount service validates the request against identity, rule state, time, product, and caps. It
passes a resolved instruction into the pure pricing pipeline. The engine does not query Postgres or
authorize users.

### 6.3 Applied snapshot

The result records enough information to replay and explain the decision without reading a mutable
rule:

```ts
interface AppliedDiscountSnapshot {
  source: 'promo' | 'manual';
  ruleId: string | null;
  ruleVersion: number | null;
  customerLabel: string;
  method: 'fixed' | 'percentage';
  value: number;
  eligibleSubtotalCents: number;
  appliedCents: number;
  appliedAt: string;
  appliedBy: string | null;
  reason: string | null;
}
```

Public responses expose only `customerLabel`, `appliedCents`, and the resulting money breakdown.
Founder identity, reason, rule internals, cost, and margin stay server-side.

## 7. Lifecycle

### 7.1 Discount is not a quote status

`draft`, `pending_review`, `ready`, `sent`, `won`, `lost`, and `expired` continue describing quote
workflow. A quote is displayed as `Discounted` when its authoritative result has
`discountCents > 0`. No `discounted` lifecycle status is added.

### 7.2 Ops quote

- A founder can preview, add, replace, or remove the one discount while the quote is editable.
- Finance and Ops can view the customer-facing discount but cannot mutate it.
- A non-founder editing itinerary content on an already discounted editable quote retains the
  discount; the server reprices it, preserves the existing editable lifecycle state, and still
  requires founder approval before `ready`.
- Discount mutation and complete quote save happen atomically. Omitted discount means preserve;
  explicit `null` means founder-requested removal.
- Any discount change invalidates prior approval.
- A `ready` or `sent` quote must follow the existing founder-gated reopen flow before editing.
- Approval freezes the rate-card snapshot, resolved discount snapshot, calculation, and customer
  output basis. Reopening unlocks and requires a new approval.

### 7.3 Web quote

- A code must be valid when first applied.
- The locked web quote stores the rate-card snapshot and immutable promo-rule snapshot for seven
  days.
- Editing the itinerary during that period reprices against those locked snapshots. The discount
  amount may change because the eligible subtotal changed; rule eligibility and limits do not.
- Website edits update/reprice the same quote id rather than minting a new rate lock.
- The latest server-priced intent and its server-resolved engine request/result are stored together.
  Booking creation must match that intent exactly.
- Normal promo expiry or deactivation after locking does not invalidate the lock.
- After the seven-day quote lock expires, the promotion must be currently valid to create a new
  lock. Otherwise the API returns `discount_expired`; it never silently removes a displayed discount.

### 7.4 Booking and payment

- Booking creation validates the source quote, canonical customer intent, quote lock, and discount.
- After an exact intent match, it adopts the quote's latest server-authored engine request/result
  rather than resolving Maps or calculating money again. This prevents a Maps response or code
  deployment between preview and booking from changing the promised amount.
- The quote links to the converted booking and a promo reservation becomes redeemed.
- Booking creation, quote conversion, redemption, and booking pricing persistence are one atomic,
  idempotent operation for the Postgres path.
- Checkout continues charging `booking.amountDueNow`. It does not recalculate discounts.
- The PayHere amount, persisted payment amount, confirmation, and customer view must all equal the
  frozen booking snapshot.
- The discount feature must not change the current full-payment policy.

### 7.5 Unpriced fallback

The existing booking routes can use a guarded fallback when maps cannot price a normal request. A
discounted request may not use that fallback: there is no trustworthy eligible subtotal. It returns
a clear `discount_requires_priced_quote` error and routes the customer to support rather than
silently changing the amount.

## 8. Permissions

Add capabilities to the existing data-driven RBAC map:

| Capability | Founder | Finance | Ops | System |
| --- | --- | --- | --- | --- |
| `discount:manage_rules` | yes | no | no | no |
| `discount:apply_manual` | yes | no | no | no |
| `discount:override_protection` | yes | no | no | no |

Existing `quote:manage` still lets all three human roles build ordinary quotes. Existing
`quote:approve` remains the ready-to-send gate. The route enforces both founder discount authority
and quote approval; hiding controls in the browser is not authorization.

When a manual or simulated promo result is below a configured fare floor or estimated cost, only a
founder response may include:

- Difference below fare floor.
- Difference below estimated cost.
- Resulting estimated margin.

The UI requires a reason and explicit confirmation. Customer, Finance, and Ops responses must never
receive cost/margin values.

## 9. Data model

### 9.1 `discount_rules`

Founder-created promo definitions:

| Column | Type / rule |
| --- | --- |
| `id` | uuid primary key |
| `code_normalized` | text; trimmed uppercase representation |
| `customer_label` | text shown to customer |
| `method` | `fixed` or `percentage` |
| `value` | integer cents for fixed; basis points for percentage |
| `max_discount_cents` | nullable integer |
| `minimum_eligible_cents` | nullable integer |
| `starts_at`, `expires_at` | timestamptz |
| `max_redemptions` | nullable positive integer |
| `version` | positive integer |
| `active` | boolean |
| `created_by` | founder email |
| `created_at`, `deactivated_at` | timestamptz |

Rules are immutable once used. Editing creates a new version; the old row remains available for
locked-quote replay. Use a unique `(code_normalized, version)` constraint plus a partial unique index
allowing only one active version of a normalized code. Deactivation prevents new locks but does not
invalidate a valid existing lock.

### 9.2 `quote_discounts`

Attributed application history:

| Column | Type / rule |
| --- | --- |
| `id` | uuid primary key |
| `quote_id` | foreign key to quote |
| `source` | `promo` or `manual` |
| `discount_rule_id` | nullable FK |
| `rule_snapshot_json` | nullable JSONB |
| `request_json` | founder/manual request or normalized promo reference |
| `eligible_subtotal_cents` | integer |
| `applied_cents` | positive integer |
| `reason` | nullable for promo, required for manual |
| `applied_by`, `approved_by` | nullable email fields |
| `status` | `active` or `voided` |
| `created_at`, `voided_at` | timestamptz |

A partial unique index permits at most one `active` row per quote. Replacing/removing voids the old
row and inserts the next history row; history is never deleted.

### 9.3 `discount_redemptions`

Reservation rows support promo rules whose optional `max_redemptions` is configured:

| Column | Type / rule |
| --- | --- |
| `discount_rule_id` | FK |
| `quote_id` | unique FK |
| `booking_id` | nullable unique FK |
| `status` | `reserved`, `redeemed`, `released`, or `expired` |
| `reserved_until` | web quote lock expiry |
| timestamps | reserved/redeemed/released times |

Locking reserves one redemption atomically. Booking conversion redeems it. An expired/released lock
returns capacity. This is necessary because the owner promise honors a locked promo for seven days.
There is no per-customer limit in this milestone.

### 9.4 Existing tables

`quotes` keeps `total_cents` and the complete `result_json`; no new financial lifecycle status is
added. `result_json` is the authoritative calculation snapshot.

Add to `bookings`:

- `source_quote_id uuid null` referencing `quotes`.
- `subtotal integer null` for compatibility with existing rows.
- `discount_total integer null` for compatibility with existing rows.
- `pricing_snapshot_json jsonb null` for compatibility with existing rows.

Existing `bookings.total`, `amount_due_now`, and `currency` remain the payment contract. Existing
rows require no synthetic discount backfill: null snapshot means legacy/no discount.

All money columns have non-negative checks where appropriate. Application code and tests enforce the
full cross-table equation; the booking snapshot is immutable after creation.

## 10. API contracts

### 10.1 Founder promo administration

```text
GET   /admin/discount-rules
POST  /admin/discount-rules
POST  /admin/discount-rules/:id/deactivate
POST  /admin/discount-rules/:id/version
```

All require `discount:manage_rules`, CSRF protection, validated integer inputs, and attributed
responses. There is no hard delete.

### 10.2 Ops quote API

Extend existing endpoints rather than adding an independent money mutation:

```text
POST /admin/quote/estimate
POST /admin/quote/save
GET  /admin/quote/:id
```

`estimate` and `save` accept an optional tri-state `discount` field:

- Omitted: preserve an existing discount or use none for a new quote.
- Discount request: founder-only add/replace.
- `null`: founder-only removal.

The save route resolves and prices the complete quote server-side, writes quote content and discount
history atomically, and returns the complete role-filtered result. Client totals and applied discount
amounts are never trusted.

### 10.3 Public quote lock

The legacy no-promo `/quote/lock` contract remains compatible. Add a versioned customer-intent arm
that accepts private/chauffeur booking intent without customer PII, plus optional promo code and
optional existing web quote id. The route resolves distances with the Maps adapter and returns:

- Quote id and seven-day expiry.
- Structured gross subtotal, discount, final total, and amount due.
- Customer-safe line items.
- Stable error codes such as `discount_invalid`, `discount_not_started`, `discount_expired`,
  `discount_not_eligible`, `discount_limit_reached`, and `discount_requires_priced_quote`.

Shared requests remain on the existing authoritative corridor booking path. The website hides the
promo control for shared and the backend rejects attempts to apply a code to shared. The public
promo route uses the existing public rate limiter; codes are normalized server-side and never
treated as authentication secrets.

The canonical intent fingerprint includes every pricing input: product/service, normalized route
places, dates, vehicle, passenger/bag counts, extras, and currency. It excludes customer PII,
client-authored totals, and resolved distance because those are not client pricing inputs. The quote
stores the server-resolved engine request/result beside that fingerprint.

### 10.4 Booking APIs

Existing `/bookings/single` and `/bookings/trip` continue accepting optional `quoteId`. For a
discounted quote they require the latest intent fingerprint to match and perform strict conversion
by adopting the stored server-authored result.
Unknown, mismatched, expired, or already-converted discounted quotes return an explicit 409/422;
they do not fall back to live undiscounted pricing.

Existing no-discount behavior, including guarded fallback and mismatch alerts, remains unchanged.
`/bookings/shared` gains no discount behavior.

## 11. UI and message behavior

### 11.1 Website

- Promo input appears in the private/chauffeur booking price summary, not marketing/search cards.
- Shared bookings do not show the control.
- Apply/remove calls the backend and renders its structured response.
- While validation is pending, checkout is disabled without changing the displayed price.
- Invalid/expired/ineligible errors preserve the prior valid amount and explain the next action.
- Any itinerary, vehicle, passenger, date, service, or extras edit triggers server repricing of the
  same locked quote before checkout.
- Summary shows `Subtotal`, the promo's customer label as a negative row, `Total`, and `Due now`.
- Extras remain visibly full price.
- Offline/demo mode does not simulate discounts.

### 11.2 Ops

- Only founders see enabled discount controls.
- Controls support promo/manual, fixed/percentage, value, and mandatory manual reason.
- Finance/Ops see a read-only discount row without internal reason, cost, or margin.
- Founder sees floor/cost warnings and must confirm an override.
- Queue/detail shows a derived `Discounted` badge.
- Internal output shows gross, discount, finishing, final, and founder-only margin impact.
- WhatsApp/email customer drafts show the friendly discount row but not internal finishing policy.
- If staff edits generated customer text so monetary values no longer match the structured result,
  the UI warns before copy/send. Prose remains editable.

### 11.3 Booking, payment, and confirmation

- Ops booking detail, customer confirmation, customer booking view, checkout, email, and payment all
  render from the frozen booking snapshot.
- PayHere receives exactly `amountDueNow` from the booking.
- No surface recomputes or accepts a client-authored discount amount.

## 12. Accuracy and anti-drift gates

### 12.1 Permanent zero-discount compatibility

Before implementation, capture representative current outputs for:

- Private car/van/large/custom, including floors and multiple legs.
- Chauffeur day + distance + idle days.
- Extras and capacity upgrades.
- Shared seats and extra bags.
- Psychological charm, nearest-50-cent, unchanged, and protected-minimum outcomes.
- Ops estimate/save/reopen/approval and customer outputs.
- Website quote, booking persistence, checkout, webhook, and confirmation.

Every later milestone proves that omitting a discount leaves every existing money field and total
cent-identical. Existing interfaces gain only optional/additive fields.

### 12.2 Required discount tests

- Fixed and percentage golden numbers using integer cents/basis points.
- Percentage rounding boundaries and deterministic remainder behavior.
- One-discount invariant and replace/void history.
- Public eligibility excludes shared and extras.
- Manual discount includes the founder-selected Ops quote subtotal.
- Positive-total lower bound.
- Fare-floor/cost crossing warnings are founder-only.
- Finishing runs after discount, stays within 2.5%, and does not further reduce a below-protection
  discounted subtotal.
- Promo start/expiry boundaries with an injected clock.
- A promo locked before expiry remains valid for the whole quote lock.
- Rule deactivation does not invalidate existing locks.
- Reservation concurrency never exceeds `max_redemptions`.
- Ops RBAC matrix tests every role and machine identity.
- Server strips manual reason, cost, and margin from unauthorized responses.
- Itinerary edits reprice under the same locked rate/rule snapshots.
- Mismatched/replayed/converted discount quote ids fail closed.
- Discounted unpriced requests never use client/fallback totals.
- Booking snapshot equation, quote link, conversion, and idempotency.
- Checkout, payment, webhook, email, and customer view all equal the frozen booking amount.
- Website and Ops browser tests across desktop/mobile and editable customer messages.

Tests use fakes for Maps, payment, email, and time. No test calls a real external service.

## 13. Rollout and rollback

Use an expand-first migration and independent creation controls:

1. `OPS_DISCOUNTS_ENABLED`: exposes founder rule/manual controls.
2. `PUBLIC_PROMOS_ENABLED`: accepts new public promo locks and exposes the website control.

Honoring an existing valid discounted lock is unconditional, not feature-flagged. Once a discounted
quote exists, no deploy or rollback may run code that cannot read and honor its snapshot.

Sequence:

1. Deploy nullable schema and read compatibility with both creation controls off.
2. Deploy pure pricing support in shadow tests; no UI.
3. Enable founder-only Ops discounts and monitor.
4. Deploy public promo code support hidden.
5. Create one tightly limited founder-owned test promo.
6. Run staging booking/payment/confirmation for private and chauffeur.
7. Enable public UI for the test promo, then expand deliberately.

Rollback disables creation, not honoring. Code must continue reading existing discount snapshots
until every locked quote has expired or converted. A bad public promo is deactivated for new locks;
valid existing locks remain honored per owner policy.

Log structured events for rule creation/version/deactivation, discount apply/remove, protection
override, promo rejection, reservation, redemption, conversion mismatch, and payment mismatch. Alert
on any booking/payment amount mismatch and unusual promo rejection/redemption volume.

## 14. Milestone boundaries

Implementation follows the detailed M18-M20 steps in `docs/build-plan.md`. Each step is one branch,
one PR, red-to-green evidence, `cd api && npm run check`, `npm run smoke` where applicable, and
`web-tests/npm run test:all` for website/Ops changes. No step may widen an interface, schema, or
surface beyond its explicit build list.
