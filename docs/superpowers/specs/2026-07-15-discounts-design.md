# Discounts and promotions across quotes, bookings, and customer surfaces

**Date:** 2026-07-15
**Status:** Product decisions complete; one cost-data input required before M18.2.
Amended 2026-07-16 (owner-approved, pre-implementation): quote-shape conditions
(minimum trip km, minimum leg count) and per-family total redemption budgets.
**Milestones:** M18-M22
**Depends on:** M11 authoritative pricing, M12 Ops/RBAC, the seven-day quote lock, and
the psychological-pricing contract

## 1. Problem

Ceylon Hop needs two founder-controlled ways to reduce a quote:

1. A founder manually discounts a particular Ops quote.
2. A founder creates a promotion that applies automatically or through a promo code.

Promotions may be sitewide, target a directional route, or target one of Ceylon Hop's
named tours. A named tour may contain one leg or many legs. Discounts affect more than a
displayed total: the same decision and amount must survive quote edits, approval, a
seven-day web lock, booking creation, checkout, PayHere, confirmation, customer views,
messages, and reporting.

The backend pricing domain is the only authority for discount eligibility, cost
protection, arithmetic, promotion selection, and the final amount. The website and Ops
tool send intent and render structured server results. They never calculate an
authoritative discount independently.

## 2. Goals and success criteria

- A founder can create, schedule, version, and deactivate automatic or code-only
  promotions from Ops.
- A founder can apply, replace, or remove one manual discount on an editable Ops quote.
- A qualifying website or Ops quote receives the same deterministic automatic
  promotion. On the website, a valid code may compete with automatic promotions but
  never stacks with them.
- A promotion can target bigger itineraries: minimum spend, minimum total trip
  distance, or minimum leg count, alone or combined.
- A finite code stops applying once its redemption budget is spent — always before
  payment, never by changing an amount already shown or charged.
- Every discounted final total is at or above the engine's estimated cost. No role can
  override this rule and no complimentary booking can be created.
- Website, Ops, booking, payment, confirmation, email, and copied customer output agree
  to the cent from one stored server-authored snapshot.
- An omitted discount remains cent-identical to current production behavior.
- Existing shared-seat pricing, inventory, full-payment policy, quote statuses, and
  editable customer-message behavior remain intact.

Launch is successful when the staged parity suite proves all supported private,
chauffeur, and named-tour paths through sandbox payment; no amount mismatch is observed;
and founders can stop new promotion creation without invalidating already locked quotes.

## 3. Confirmed owner decisions

| Decision | Policy |
| --- | --- |
| Launch mechanisms | Manual Ops discounts, automatic promotions, and promo codes |
| Human authority | Founder role only |
| Promotion activation | Automatic or code-only |
| Promotion scope | Sitewide, route, or named tour |
| Route direction | One-way or both directions, selected when the rule is created |
| Quote-shape conditions | Optional minimums for eligible subtotal, total trip km, and leg count; all configured conditions must hold together |
| Named tour | A stable Ceylon Hop tour offering containing one or many legs |
| Public eligibility | Private transfers, chauffeur trips, and named tours |
| Public exclusions | Shared seats and extras |
| Manual eligibility | The full supported Ops quote, including extras |
| Stacking | Never; exactly zero or one discount applies |
| Multiple matches | Apply the eligible candidate with the greatest actual saving after caps |
| Manual versus automatic | An explicit founder manual discount replaces the automatic winner until removed |
| Cost protection | Cap the discount at estimated cost; never allow a below-cost final total |
| Fare floors | A founder-created discount may cross a sell-price fare floor, but not cost |
| Promo expiry after lock | A promotion valid when locked remains valid for that quote's full lock; the one exception is a finite budget exhausting before conversion (§7.6) |
| Public lock duration | Seven days, fixed from creation and never extended by edits |
| Redemption limits | Optional total budget per rule family (revised 2026-07-16; supersedes the launch deferral); still no per-customer or per-device limits |
| Quote state | Discounted is derived display state, not a lifecycle status |
| Payment policy | Full payment remains unchanged |

Only founders can create, version, or deactivate promotion rules; apply, replace, or
remove a manual discount; or approve a discounted Ops quote. A customer triggering a
valid rule is using a founder-authorized rule and receives no staff capability.

## 4. Scope

### 4.1 In scope

- Fixed-amount and percentage manual discounts.
- Fixed-amount and percentage promotions.
- Automatic and code-only activation.
- Sitewide, canonical directional-route, and named-tour targeting.
- Required start and expiry times for every promotion.
- One winning discount per quote, including deterministic overlap handling.
- Optional rule conditions: minimum eligible subtotal, minimum total trip km, and
  minimum leg count.
- Optional total redemption budget per rule family, enforced at code entry and again
  at conversion.
- Cost capping, founder warnings, reasons, and attributed audit history.
- Discount snapshots on Ops quotes, web quotes, and bookings.
- Seven-day locked promotion durability.
- Structured display in Ops, website booking summary, confirmation, customer booking
  view, checkout, email, and manually copied WhatsApp/email output.
- Exact integer-cent arithmetic, locked FX presentation, parity tests, feature flags,
  and guarded rollout.

### 4.2 Out of scope

- Stacking, compounding, or allocating multiple promotions.
- Shared-seat discounts and public discounts on extras.
- Complimentary or below-cost bookings.
- Per-customer or per-device redemption limits. Anonymous customer identity is
  insufficient for a reliable per-person limit. A total per-family budget is in scope
  (§7.6); "one per person" is approximated by setting the budget to the intended
  audience size.
- Geofencing arbitrary typed addresses. Route promotions use preserved canonical route
  context; exact pickup and drop-off addresses remain separate fulfillment data.
- Cross-device web-quote editing. The edit credential is private to the browser session.
- Gift cards, account credits, referrals, loyalty balances, and stored-value vouchers.
- Surge pricing, partial-refund allocation, and accounting integration.
- A generic organization-wide audit framework. This feature records its own events.

## 5. Product and route identity

Promotion matching must not depend on free-text place labels.

### 5.1 Route context

A single private route carries canonical `fromPlaceId` and `toPlaceId` separately from
the customer's exact pickup and drop-off addresses. A one-way rule matches only the
ordered pair. A both-directions rule matches either ordering.

The route context originates from the route/search selection and survives entry of an
exact hotel or airport address. If the customer changes the logical origin or
destination, the website clears or replaces that context and the server reprices.
Arbitrary free-text trips without recognized place IDs do not qualify for an automatic
route rule; a founder may still discount them manually.

A route promotion targets a one-leg route quote. It does not become a full-tour discount
merely because the same ordered pair appears inside a custom multi-leg itinerary.

### 5.2 Named-tour context

A named tour carries a stable `tourId` and canonical route fingerprint from the tour
catalog through tour page, planner, booking page, web quote, and booking. The catalog
uses one source contract with a parity test so website and backend IDs cannot drift.

A tour may contain one leg or many. A tour promotion matches the `tourId` and its route
fingerprint. Changing dates, stays, passengers, vehicle, or service type may preserve
the identity; changing the canonical stop sequence clears the named-tour identity and
forces fresh promotion matching.

### 5.3 Sitewide context

A sitewide promotion matches every otherwise eligible private, chauffeur, or named-tour
quote during its validity period. It still excludes shared seats and extras.

## 6. Amount contract

All authoritative amounts are integer USD cents. Percentage values are integer basis
points. Presentation in LKR uses the quote's locked FX snapshot after all USD arithmetic;
clients do not independently derive a second monetary result.

| Term | Meaning |
| --- | --- |
| Gross subtotal | Existing engine subtotal after core fares and extras, before discount and finishing |
| Eligible subtotal | Portion against which the chosen discount may be calculated |
| Estimated cost | Existing engine cost estimate for the complete quote, never exposed publicly |
| Requested discount | Amount produced by the rule or manual request before caps |
| Applied discount | Actual positive cents removed after all caps |
| Discounted subtotal | Gross subtotal minus applied discount |
| Finishing adjustment | Signed psychological adjustment applied after discount |
| Final total | Customer price stored on quote and booking |

The invariant is:

```text
discountedSubtotalCents = subtotalCents - discountCents
totalCents = discountedSubtotalCents + priceAdjustmentCents
amountDueNowCents = totalCents
totalCents >= estimatedCostCents
```

`QuoteResult.subtotalCents` keeps its current pre-finishing meaning and becomes the
gross, pre-discount subtotal. Existing interfaces gain only additive optional fields
until the migration is fully deployed:

```ts
discountCents: number;
discountedSubtotalCents: number;
discount: AppliedDiscountSnapshot | null;
```

The internal line-item order is existing core items, existing extras, one negative
customer-facing discount item, then the existing internal finishing item. The complete
line-item sum equals `totalCents`. Customer renderers show the friendly discount row but
continue hiding the internal finishing-policy label.

## 7. Eligibility, calculation, and winner selection

### 7.1 Public promotion

- Eligible products are private transfer and chauffeur/named-tour pricing.
- Shared is rejected before promotion resolution.
- Eligible subtotal contains core transport/chauffeur/tour charges only.
- Extras remain full price and are excluded from percentage calculations and the fixed
  amount ceiling.
- A fixed promotion cannot remove more than the eligible subtotal.
- A percentage uses the eligible subtotal and may have an optional maximum amount.
- A rule may require a minimum eligible subtotal.
- A rule may require a minimum total trip distance in km. The distance is the engine's
  **real driven km** for the product, never a client-supplied figure:
  - private and multi-leg/tour quotes: the sum of server-resolved transfer-leg
    distances; stay legs contribute nothing;
  - chauffeur: the engine's `travelKm` — the unbuffered sum of travel-day driving
    distances, excluding both the km buffer and the idle-day minimum-km billing
    padding. Idle days never earn distance toward a promotion.
  If any contributing distance is unresolved, the condition is unmet and the rule does
  not match: fail closed, consistent with §9.5.
- A rule may require a minimum leg count, counted as **transfer legs** — movements
  between places. Stay legs are excluded. For chauffeur, the count is the number of
  travel days (days with driving); idle days do not count.
- When a rule configures several conditions, all of them must hold together.
- Resolved distance is deliberately outside the canonical fingerprint (§12.3), so the
  same itinerary may resolve slightly different km on different days as Maps re-routes.
  A km threshold set at a popular route's exact total will apply intermittently across
  quotes; founders should set km thresholds with headroom below the trips they mean to
  reward.
- The complete quote's estimated cost protects the final total, including when extras
  are present.

### 7.2 Manual Ops discount

- The eligible subtotal is the complete supported Ops quote, including extras.
- A founder may enter fixed cents or integer basis points.
- There is no global founder discount cap, but the cost cap is absolute.
- A reason is mandatory.
- An explicit manual discount suppresses automatic promotion matching for that Ops
  quote. Removing it immediately restores normal automatic matching. The preview warns
  when the requested manual saving is less than the current automatic offer.
- Crossing an ordinary sell-price floor shows a founder-only warning and requires
  confirmation. Reaching the cost cap shows a stronger warning but cannot be overridden.
- If cost cannot be computed, the server rejects the discount with
  `discount_cost_unavailable`; it never trusts a browser amount.

### 7.3 Integer arithmetic and cost cap

Percentage cents use round-half-up integer arithmetic:

```text
percentageDiscount = floor((eligibleSubtotalCents * basisPoints + 5,000) / 10,000)
maximumCostSafeDiscount = max(0, subtotalCents - estimatedCostCents)
```

The applied amount is the smallest of:

- Requested/calculated discount.
- Optional rule maximum.
- Eligible subtotal.
- `maximumCostSafeDiscount`.

When the cost cap reduces the requested amount, the snapshot records
`capReason: 'estimated_cost'`, requested cents, and applied cents. Founders can see the
warning and margin; customers see only the actual applied discount. A zero-cent result
does not create a discounted state.

### 7.4 Automatic and code candidate selection

For every eligible quote without an explicit founder manual discount, the server:

1. Finds active automatic rules whose time, product, scope, route/tour identity, and
   quote-shape conditions (minimum subtotal, trip km, leg count) match.
2. For a website quote with a submitted code, validates that one code-only rule —
   including its remaining redemption budget (§7.6) — and adds it as a candidate.
3. Computes each candidate independently, including optional maximum and cost cap.
4. Selects exactly one candidate with the greatest applied cents.
5. Breaks equal-value ties deterministically: submitted code, then tour, route,
   sitewide, then stable rule family/version order.
6. Stores only the winner as the active discount snapshot.

Rules never stack. If a submitted code is valid but an automatic promotion gives a
larger saving, the automatic promotion remains and the response says that a better
offer is already applied. An invalid/expired/exhausted/ineligible submitted code
rejects that edit and leaves any previously locked quote unchanged.

Ops estimates use the same automatic resolver, including route/tour identity and
greatest-saving selection. An explicit founder manual discount is a deliberate
replacement, not another candidate; it remains the only active discount until removed.

### 7.5 Psychological finishing

The order is fixed:

```text
core pricing -> select/apply one discount -> psychological finishing -> amount due
```

Finishing's 2.5% reduction limit is calculated from the discounted subtotal. For an
explicit discount, its downward minimum is estimated cost rather than the ordinary
sell-price fare floor, because the founder may intentionally cross the sell floor.
Finishing may round upward. It may never reduce the final total below estimated cost;
at cost it returns unchanged.

Shared remains outside both public promotions and psychological finishing.

### 7.6 Redemption budget

A rule may carry `max_redemptions`, an optional positive integer. The budget belongs to
the rule **family**, not the version: versions of one family share a single spent count,
so editing a label or window never resets a code's budget.

A redemption is a **converted booking** whose frozen snapshot applies a version of that
family. Quote locks, previews, and estimates never consume budget — window-shoppers
cannot exhaust a code by browsing.

Enforcement happens twice:

- **At matching.** A rule whose budget is spent is not a candidate. A submitted
  exhausted code rejects with `promotion_exhausted`, wording it as fully redeemed.
- **At conversion.** Between lock and conversion the budget may run out, so the booking
  transaction re-verifies it: it takes a transaction-scoped Postgres advisory lock on
  the family id (the uuid is hashed into the bigint advisory-lock keyspace; a hash
  collision merely serializes an unrelated conversion, which is harmless), counts
  committed conversions, and fails closed with `promotion_exhausted` when the budget is
  spent. The advisory lock serializes concurrent conversions of the same family so the
  budget can never overshoot. No booking is ever created at an amount other than the
  one shown; after a rejection the quote reprices without the discount on its next
  edit, and the customer confirms the corrected total before converting.

A spent unit stays spent: cancelling or refunding a booking never returns budget, so
the count stays monotonic and the history append-only. The founder remedy is versioning
the rule with a higher budget — the family's spent count is unchanged, so raising
`max_redemptions` by one restores exactly one unit.

This is the single, deliberate exception to locked-promotion durability (§3): a lock
preserves a promotion's terms, but cannot promise a share of a finite budget. For the
launch use case — codes handed to a known circle of friends — the budget is set to the
audience size and the window kept short.

## 8. Domain representations

Only server routes accept unresolved requests:

```ts
type DiscountRequest =
  | { source: 'promotion'; code?: string }
  | { source: 'manual'; method: 'fixed'; amountCents: number; reason: string }
  | { source: 'manual'; method: 'percentage'; basisPoints: number; reason: string };
```

The public arm expresses an optional code; the server always evaluates automatic
candidates. Manual arms require founder authorization. Clients never submit applied
cents, cost, margin, candidate rules, or an override flag.

The resolver validates identity, time, product, scope, and rule state, then passes a
resolved instruction into the pure pricing pipeline. The engine does not query
Postgres or authorize users.

```ts
interface AppliedDiscountSnapshot {
  source: 'promotion' | 'manual';
  ruleId: string | null;
  ruleFamilyId: string | null;
  ruleVersion: number | null;
  activation: 'automatic' | 'code' | null;
  scope: 'sitewide' | 'route' | 'tour' | null;
  customerLabel: string;
  method: 'fixed' | 'percentage';
  value: number;
  eligibleSubtotalCents: number;
  requestedCents: number;
  appliedCents: number;
  capReason: 'rule_maximum' | 'eligible_subtotal' | 'estimated_cost' | null;
  appliedAt: string;
  appliedBy: string | null;
  reason: string | null;
}
```

Public responses expose only customer label, actual applied cents, cap-neutral customer
copy, and the resulting money breakdown. Founder identity, reason, rule internals,
cost, margin, and cap diagnostics stay server-side.

## 9. Lifecycle

### 9.1 Discount is not a quote status

Existing quote workflow states remain unchanged. A quote displays `Discounted` when its
authoritative result has `discountCents > 0`; no `discounted` lifecycle state is added.

### 9.2 Ops quote

- A founder can preview, add, replace, or remove one manual discount while editable.
- Finance and Ops may see the customer-facing discount but cannot mutate it.
- Quotes without a manual discount receive the same automatic promotion that an
  equivalent website quote would receive.
- Before approval, current automatic rules are reevaluated on every estimate/save. Ops
  approval freezes the selected rule snapshot with the rest of the quote; later rule
  expiry/version/deactivation does not change an approved quote.
- Editing itinerary content retains the discount request and reprices server-side.
- Quote save and discount-history mutation are one transaction.
- Every mutation supplies the last-read quote revision. A stale save returns 409 and
  cannot overwrite another user's work.
- Omitted discount means preserve; explicit `null` means founder-requested removal.
- Any discount or price-input change invalidates prior approval.
- Ready/sent quotes use the existing reopen flow before editing.
- Approval freezes rate card, discount snapshot, calculation, FX, and output basis.

### 9.3 Web quote

- `POST /quote/v2/lock` creates a server-priced quote and returns a signed edit token.
- The browser keeps that bearer token in session storage and supplies it for edits and
  conversion. Quote IDs alone cannot read, mutate, or convert a web quote.
- `PUT /quote/v2/:id` requires the token and last-read revision, then stores intent and
  result atomically.
- The seven-day expiry is fixed at quote creation. Edits never slide or extend it.
- Edits use the locked rate-card and FX. A previously locked promotion remains a
  candidate despite later expiry/version/deactivation only while the current canonical
  intent still satisfies its product, scope, route/tour identity, and quote-shape terms
  (minimum subtotal, trip km, leg count). Its amount may change with eligible subtotal
  or cost.
- A locked finite-budget promotion is not a reservation; its remaining budget is
  re-verified at conversion (§7.6).
- Currently active automatic candidates are also evaluated on each successful edit. A
  newly selected winner receives its own immutable snapshot without extending the
  quote's expiry.
- Removing a code reruns automatic matching. Entering a new code replaces the candidate
  request; it never stacks.
- Rule expiry or deactivation after lock does not invalidate the existing lock.
- After lock expiry, a new quote evaluates currently active rules. An unavailable prior
  promotion is reported rather than silently promising its old amount.
- Losing the browser-session token means the customer creates a new quote; cross-device
  quote editing is deferred.

### 9.4 Booking and payment

- Booking creation requires quote ID, signed access token, matching revision, canonical
  intent fingerprint, and an unexpired lock.
- On exact match it adopts the latest stored server-authored request/result. It does not
  call Maps or recalculate money during conversion.
- When the adopted discount's rule family carries `max_redemptions`, the conversion
  transaction re-verifies the remaining budget under the family advisory lock (§7.6)
  and fails closed with `promotion_exhausted`. The booking is never created at an
  amount other than the one the customer was shown.
- Booking creation, quote conversion, pricing-snapshot persistence, and audit event are
  one idempotent Postgres transaction.
- Existing `quotes.converted_booking_id` is made unique and remains the sole
  quote-to-booking link; no duplicate `bookings.source_quote_id` is added.
- Checkout charges the booking's stored `amountDueNow`; discounts are never recalculated
  at checkout or webhook time.
- PayHere, payment row, confirmation, email, and customer view must equal the frozen
  booking snapshot.
- Booking duration/enrichment that does not affect price may refresh separately and may
  not mutate money.

### 9.5 Unpriced fallback

Existing no-discount booking behavior may retain its guarded fallback. A manual or
promotion discount requires an authoritative estimated cost and eligible subtotal. An
unpriced request fails closed with `discount_requires_priced_quote`; it never uses a
client total.

## 10. Permissions

Add founder-only capabilities to the existing server-side RBAC map:

| Capability | Founder | Finance | Ops | System |
| --- | --- | --- | --- | --- |
| `promotion:manage` | yes | no | no | no |
| `discount:apply_manual` | yes | no | no | no |

There is no below-cost override capability. Existing `quote:manage` continues to allow
ordinary quote work and existing `quote:approve` remains the ready-to-send gate. Routes
enforce capabilities and CSRF centrally; hidden browser controls are not authorization.

Founder-only responses may contain fare-floor difference, estimated cost, resulting
margin, and whether cost capping occurred. Finance, Ops, system, and public projections
must strip those fields.

## 11. Data model

### 11.1 `promotion_rules`

Each row is an immutable rule version:

| Column | Type / rule |
| --- | --- |
| `id` | uuid primary key |
| `family_id` | uuid stable across versions |
| `version` | positive integer, unique with family |
| `activation` | `automatic` or `code` |
| `code_normalized` | nullable; required only for code activation |
| `scope` | `sitewide`, `route`, or `tour` |
| `route_from_place_id`, `route_to_place_id` | nullable canonical IDs; required for route |
| `route_direction` | nullable `one_way` or `both_ways` |
| `tour_id`, `tour_route_fingerprint` | nullable; required for tour |
| `customer_label` | non-empty public label |
| `method` | `fixed` or `percentage` |
| `value` | integer cents for fixed; basis points for percentage |
| `max_discount_cents` | nullable non-negative integer |
| `minimum_eligible_cents` | nullable non-negative integer |
| `minimum_trip_km` | nullable positive integer; compared against the product's real driven km (§7.1) |
| `minimum_leg_count` | nullable positive integer |
| `max_redemptions` | nullable positive integer; budget shared across a family's versions (§7.6) |
| `starts_at`, `expires_at` | timestamptz, start strictly before expiry |
| `active` | boolean |
| `created_by`, `created_at`, `deactivated_by`, `deactivated_at` | attribution |

Editing inserts a new family version and deactivates the prior active version in one
transaction. Partial unique indexes permit one active version per family and one active
code rule per normalized code. Check constraints enforce activation/scope-specific
columns. There is no hard delete. `max_redemptions` is copied forward to each new
version unless the founder changes it; the spent count always belongs to the family
(§7.6), so raising or lowering the budget on a new version compares against the same
count.

### 11.2 `quote_discounts`

History-retaining applied snapshots:

| Column | Type / rule |
| --- | --- |
| `id` | uuid primary key |
| `quote_id` | foreign key to quote |
| `source` | `promotion` or `manual` |
| `promotion_rule_id` | nullable FK |
| `rule_snapshot_json` | nullable immutable rule terms |
| `request_json` | rule/activation reference without plaintext code, or founder request |
| `eligible_subtotal_cents`, `requested_cents`, `applied_cents` | non-negative integers |
| `cap_reason` | nullable enum-like text |
| `reason` | required for manual |
| `applied_by` | nullable founder email |
| `status` | `active`, `replaced`, or `removed` |
| timestamps | created and superseded times |

A partial unique index permits one active row per quote. Replace/remove changes the old
row's status and inserts or clears the next row in the same quote transaction. History
is never deleted.

### 11.3 `discount_events`

An append-only attributed event stream records rule create/version/deactivate, quote
apply/replace/remove, cost cap, approval/reopen, web lock/update, and conversion. It
stores entity type/id, action, actor, safe metadata, and timestamp. Public code values,
customer PII, and signed access tokens are not written to logs.

### 11.4 Existing tables

Add to `quotes`:

- `revision integer not null default 1` for optimistic concurrency.
- A unique index on nullable `converted_booking_id`.

Canonical intent/fingerprint, promotion snapshot, locked FX, and server engine I/O stay
inside the existing request/result snapshots unless query requirements later justify a
column. The web edit credential is signed and is never stored in plaintext.

Add nullable, legacy-compatible fields to `bookings`:

- `subtotal integer`.
- `discount_total integer`.
- `pricing_snapshot_json jsonb`.

Existing `total`, `amount_due_now`, and `currency` remain the payment contract. A null
snapshot means legacy/no-discount. Money checks are non-negative; application and
integration tests enforce the cross-field equation. The booking pricing snapshot is
immutable after creation.

No `discount_redemptions` table is added. Budget enforcement (§7.6) counts committed
conversions — converted quotes whose active `quote_discounts` row references a version
of the family — inside the conversion transaction, serialized by a transaction-scoped
advisory lock on the family id. At Ceylon Hop's booking volume the count is cheap and
the lock uncontended; a separate reservation ledger becomes worthwhile only if that
stops being true.

## 12. API contracts

### 12.1 Founder promotion administration

```text
GET   /admin/promotion-rules
POST  /admin/promotion-rules
POST  /admin/promotion-rules/:id/version
POST  /admin/promotion-rules/:id/deactivate
POST  /admin/promotion-rules/preview
```

All endpoints are mounted under existing authenticated admin middleware and require
`promotion:manage`, CSRF, validated integer inputs, and attributed events. Preview runs
the same resolver and engine against supplied quote intent but writes nothing.

### 12.2 Ops quote API

Extend existing quote estimate/save/read contracts. Estimate/save include `revision`
and an optional tri-state `discount`:

- Omitted: preserve existing discount, or none for a new quote.
- Manual request: founder-only add/replace.
- `null`: founder-only removal.

Estimate is side-effect free. Save resolves and prices the complete quote server-side
and writes quote content, revision, discount history, and event in one transaction. A
stale revision returns `409 quote_conflict` with the latest revision. Client totals and
applied amounts are never trusted.

### 12.3 Public quote v2

```text
POST /quote/v2/lock
PUT  /quote/v2/:id
```

Create accepts canonical private/chauffeur intent plus optional promo code, never
client-authored distance, cost, or totals. Update requires signed bearer token and
revision. Responses include quote ID, access token on creation only, revision, fixed
expiry, structured amounts, customer-safe line items, applied promotion label, and
stable errors.

Stable errors include `promotion_invalid`, `promotion_not_started`,
`promotion_expired`, `promotion_exhausted`, `promotion_not_eligible`,
`discount_cost_unavailable`,
`discount_requires_priced_quote`, `quote_conflict`, `quote_access_denied`, and
`quote_expired`.

The existing `/quote/lock` stays unchanged for legacy no-discount flows until v2 has
proven parity. Rate limiting covers `/quote/*`, not only the exact legacy path.

The canonical fingerprint contains every pricing input and identity field: product,
service, canonical route or tour context, exact locations used by Maps, dates, vehicle,
passengers/bags, extras, and currency. It excludes PII, client totals, access token, and
resolved distance.

### 12.4 Booking APIs

Existing private/trip booking routes accept the v2 quote ID, access token, and revision.
For v2 they require exact intent match and adopt the stored server result. Unknown,
mismatched, expired, stale, unauthorized, already converted, or budget-exhausted
(`promotion_exhausted`, §7.6) quotes fail closed; they do not fall back to undiscounted
live pricing.

Legacy no-discount behavior remains unchanged while migration is active. Shared gains
no discount behavior.

## 13. UI and message behavior

### 13.1 Website

- Automatic promotions appear in eligible private/chauffeur summaries without input.
- Promo-code input appears only in eligible booking summaries, not search cards.
- Apply/remove calls quote v2 and renders its structured response.
- Shared never shows a control or discount row.
- While repricing is pending, checkout is disabled and the last confirmed amount stays
  visible.
- A failed edit leaves the prior valid quote and amount untouched.
- Any pricing-input edit reprices the same quote with token and revision.
- Summary shows subtotal, winning promotion label and negative amount, total, and due
  now. Extras remain visibly full price.
- When a valid code loses to a better automatic promotion, explain that the better
  offer is already applied.
- A code whose budget is spent is rejected as fully redeemed, at entry and — in the
  rare late-conversion case — before payment, never after (§7.6).
- Demo/offline mode does not simulate promotions or discounts.

### 13.2 Ops promotion management

- Only founders can load the promotion-management view or mutate a rule.
- Controls select automatic or code-only activation; sitewide, route, or tour scope;
  one-way or both-way route behavior; fixed/percentage value; optional maximum and
  minimum; optional minimum trip km and leg count; optional total redemption budget;
  customer label; and required validity period.
- Route selection uses canonical places and shows direction clearly.
- Tour selection shows stable offered-tour identity and route summary.
- List states are scheduled, active, expired, and deactivated; a finite rule also shows
  redemptions spent against its budget. Version and deactivate are explicit; no hard
  delete exists.
- Preview shows actual candidate result and founder-only floor/cost/margin warnings for
  the supplied sample quote. Rule creation alone does not claim a universal margin,
  because cost varies by quote.

### 13.3 Ops quote builder and output

- Only founders see enabled manual controls; other roles see a read-only discount row.
- Automatic promotions appear on equivalent eligible Ops quotes for every quote-managing
  role; only a founder can replace one with a manual discount.
- Founder controls support fixed/percentage value, required reason, replace, and remove.
- Cost capping cannot be bypassed. Founder sees requested versus applied amount and
  resulting margin.
- When an applied automatic promotion's family budget is nearly or fully spent, the
  founder-facing preview warns before approval: an approved, already-sent price that
  later bounces at conversion with `promotion_exhausted` is a human workflow cost, not
  just an error code.
- Queue/detail derives a `Discounted` badge.
- Internal output shows gross, discount, finishing, final, and founder-only margin.
- WhatsApp/email customer drafts show the friendly discount but not internal finishing,
  cost, or margin.
- Editable prose remains supported. The UI stores a generated-message basis hash; if
  structured pricing changes after manual edits, it warns that the message is stale and
  offers regenerate or explicit confirmation. It does not parse prose to infer money.

### 13.4 Booking, payment, and confirmation

Ops booking detail, checkout, PayHere, confirmation, customer booking view, and email
render from the frozen booking snapshot. No surface recalculates a discount or accepts a
client-authored amount.

## 14. Accuracy and anti-drift gates

### 14.1 Permanent zero-discount compatibility

Before production behavior changes, commit independent golden fixtures for current:

- Private vehicle classes, floors, route overrides, and multiple legs.
- Chauffeur day/distance/idle-day calculations.
- Extras and capacity upgrades.
- Shared seats and extra bags.
- Psychological charm, nearest-50-cent, unchanged, and protected-minimum outcomes.
- Ops estimate/save/reopen/approval and customer output.
- Website quote, booking persistence, checkout, webhook, and confirmation.

Expected values are reviewed constants, not generated by the implementation under test.
Every later step proves that omitting a discount leaves existing fields and totals
cent-identical.

### 14.2 Required promotion and discount tests

- Fixed/percentage golden arithmetic and half-up boundaries.
- Eligible subtotal excludes public extras but includes manual full-quote extras.
- Absolute cost cap, exact-at-cost behavior, and unavailable-cost failure.
- Automatic/code overlap, greatest-saving winner, stable tie-breaks, and no stacking.
- Sitewide, one-way, both-way, and named-tour identity matching.
- Free-text route and altered-tour non-matches.
- Start/expiry boundaries using an injected clock.
- Minimum trip-km and leg-count boundaries, combined-condition AND semantics, and an
  unresolved leg distance failing the km condition closed.
- Per-product condition semantics: stay legs excluded from both km and leg count;
  chauffeur km equals `travelKm` (a quote with idle days earns no idle or buffer km
  toward a threshold); chauffeur leg count equals travel days.
- Redemption budget: the last unit converts, the next rejects; exhausted rejection at
  code entry and at conversion; concurrent conversions serialized by the family
  advisory lock never overshoot; versioning a rule preserves the family's spent count.
- Seven-day fixed expiry; edits do not slide the lock.
- A still-eligible locked rule survives version/deactivation; new locks do not use it.
- Finishing runs once after discount and never drops below cost.
- One active quote discount and complete replace/remove history.
- Optimistic quote concurrency rejects stale Ops and web edits.
- Founder/Finance/Ops/system RBAC matrix and CSRF.
- Role projections do not leak reason, cost, margin, codes, or tokens.
- Signed quote token rejects missing, forged, wrong-quote, and expired access.
- Exact intent conversion, idempotency, replay rejection, and unique conversion link.
- Discounted unpriced requests never use fallback/client totals.
- Booking snapshot equation and immutability.
- Checkout, payment, webhook, email, and customer view equal frozen booking money.
- Website/Ops browser tests on desktop and mobile, including editable stale messages.

Tests use fake Maps, payments, email, and clock. Cross-surface golden fixtures are shared
as expected data, while each surface is independently asserted against them.

## 15. Rollout, rollback, and observability

Use expand-first migrations and independent creation flags available before their UI or
route behavior ships:

1. `OPS_MANUAL_DISCOUNTS_ENABLED`.
2. `OPS_PROMOTIONS_ENABLED`.
3. `PUBLIC_AUTOMATIC_PROMOTIONS_ENABLED`.
4. `PUBLIC_PROMO_CODES_ENABLED`.

Reading and honoring an existing valid discounted snapshot is unconditional. Rollback
turns off new application/creation, not existing promises.

Sequence:

1. Deploy nullable schema and legacy readers with every creation flag off.
2. Deploy pure engine support and zero-discount fixtures.
3. Enable founder manual discounts and monitor.
4. Enable founder promotion management and create staging-only rules.
5. Deploy quote v2 and strict conversion hidden from the public site.
6. Prove private, route, named-tour, chauffeur, checkout, webhook, and confirmation in
   sandbox.
7. Enable automatic promotions for one controlled route.
8. Enable code UI for one controlled code, then broaden deliberately.

Structured events cover rule lifecycle, candidate selection — including a rule skipped
solely because a leg distance was unresolved, so a Maps hiccup suppressing an
advertised promotion is visible rather than silent — apply/replace/remove, cost cap,
budget exhaustion, stale conflicts, quote access rejection, lock/update, conversion,
and payment mismatch. Alerts fire on booking/payment amount mismatch, below-cost invariant failure,
conversion failure spikes, and unusual promotion rejection/application volume.

Rollback proof must show that all creation flags can turn off while an already locked
discounted quote still converts and pays at its stored amount.

## 16. Milestone boundaries

Implementation follows M18-M22 in `docs/build-plan.md`. Every numbered step is one
branch and one PR, contains red-to-green evidence, runs `cd api && npm run check` and
`npm run smoke` where relevant, and runs `npm run test:all` for website/Ops changes.
No step may widen a schema, interface, or surface beyond its explicit build list.

## 17. Required owner data before M18.2

The current engine models transport per-kilometer cost and chauffeur day cost, but its
extras are final sell prices without explicit cost fields. Because manual discounts may
cover the full quote, `estimatedCostCents` cannot honestly protect total cost until the
owner confirms a cost basis for each chargeable extra (`sightseeing`, `safari-wait`,
`luggage`, `front`, `flex`, and `waiting`) or confirms that a particular extra has zero
incremental cost. This is a blocking pricing-data input for M18.2, not permission to
change existing sell prices.

M18.1 records the confirmed cost fixture. M18.2 may add separate locked cost fields to
the rate card solely for protection/margin calculation; it must not alter existing
sell-price arithmetic. Until every discountable component has a known cost, discount
creation flags remain off and discounted requests fail closed.

Finite redemption limits, cross-device quote access, arbitrary-address geofencing, and
discount-aware refunds remain explicit future design steps rather than launch
improvisations.
