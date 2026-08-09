# Discounts and promotions across quotes, bookings, and customer surfaces

**Date:** 2026-07-15
**Status:** Product decisions complete for the original scope; **two owner decisions and one
cost-data input are open before M18.2** — see §18.
**Revision 3 (2026-08-09) — codebase reconciliation, NOT owner-approved.** Amends the spec to
match what shipped between 2026-07-16 and 2026-08-09. No original owner decision is reversed
here. Changes: psychological finishing rewritten to the two-limit / $10-grid rule the owner set
on 2026-07-26 (§7.5); route identity moved off never-built place IDs onto `canonPlace` canon
keys (§5.1, §11.1); via-stops identity settled (§5.1); partial-leg pay links recorded as a
second money path out of a quote and marked OPEN (§6, §9.4, §18); parts of M19.2 and all of
M21.2 marked **already delivered** by SH4/SH5 and quote version history (§11.4, §12.3); the
new customer surfaces added to the parity set (§13.4, §14.1); §17 resequenced behind per-leg
sightseeing attribution; hot zones corrected from "unbuilt" to half-shipped, with Phase 3 made
a prerequisite for public automatic promotions (§18.2); `estimatedCostCents` recorded as not
being a field (§6); new §18 collects the open items.
Amended 2026-07-16 (owner-approved, pre-implementation): quote-shape conditions
(minimum trip km, minimum leg count) and per-family total redemption budgets.
**Milestones:** M18-M22 (M19.2 and M21.2 substantially delivered already — see §11.4/§12.3;
the build plan needs re-cutting before M18.1 starts)
**Depends on:** M11 authoritative pricing, M12 Ops/RBAC, the seven-day quote lock, and
the psychological-pricing contract
**Superseded dependency:** M17.5 money & checkout security hardening was the release gate for
this feature. SH1–SH8 merged (PRs #192–#200); the refund half landed separately (#351, #352,
#357, #360, #404 and `2026-08-07-ops-refund-methods-design.md`). Treat the gate as met pending
a formal pass over that plan's final checklist.

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
| Payment policy | Full payment of whatever is sold remains unchanged — no deposits, no instalments (see the amended row below) |
| Partial-leg pay links (2026-08-09) | **OPEN — owner decision required (§18.1).** Partial-leg links shipped after this spec was written. Whether a discounted quote may mint a partial link, and how a discount behaves over a subset of legs, is undecided. Until it is decided, a discounted quote must refuse to mint a partial link. |

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
- **Discounted partial-leg pay links (added 2026-08-09).** Allocating one discount across a
  ticked subset of legs is not designed. A discounted quote refuses to mint a partial link
  until §18.1 is decided. This is a hard gate in the code, not a UI omission.
- **Deposits and balance payments.** `2026-07-23-deposits-balance-payments-design.md` is an
  approved, unbuilt design that deliberately breaks the same `amountDueNowCents = totalCents`
  invariant this spec relies on (§6). The two features must not be built concurrently; see
  §18.2 for the sequencing decision.

## 5. Product and route identity

Promotion matching must not depend on free-text place labels.

### 5.1 Route context

**Amended 2026-08-09.** The original text specified canonical `fromPlaceId` / `toPlaceId`.
**No place-ID concept exists in the codebase and none is planned.** What shipped instead is
`canonPlace(s)` string canonicalisation in `api/src/adapters/maps.ts` plus the `KNOWN_PLACES`
table, hardened by positive location identification
(`2026-08-02-positive-location-identification-design.md`, the `place_resolutions` table keyed
on `canon_key`) and one server-side source of short place labels (PRs #321/#322). Route
identity is therefore built on **canon keys**, not IDs. Introducing place IDs solely for
promotions is explicitly rejected: it would be a second identity system alongside the one the
pricing path already trusts.

A single private route carries a canonical `fromCanonKey` and `toCanonKey` — `canonPlace()` of
the resolved place — separately from the customer's exact pickup and drop-off addresses. A
one-way rule matches only the ordered pair. A both-directions rule matches either ordering.

The route context originates from the route/search selection and survives entry of an
exact hotel or airport address. If the customer changes the logical origin or
destination, the website clears or replaces that context and the server reprices.
Trips whose endpoints do not resolve to a `KNOWN_PLACES` canon key — free text, or a raw
lat/lng pickup — do not qualify for an automatic route rule; a founder may still discount them
manually. This is the same fail-closed posture as the km condition (§7.1): an unresolved
endpoint suppresses the promotion rather than guessing.

A route promotion targets a one-leg route quote. It does not become a full-tour discount
merely because the same ordered pair appears inside a custom multi-leg itinerary.

**Via stops break route identity (added 2026-08-09).** Multi-stop rides
(`2026-07-20-multi-stop-rides-design.md`) shipped after this spec was written, so a *single*
leg can now carry `via_stops`. A leg with any via stop is **not** a match for a route rule on
its endpoints: Colombo → Kandy *via Pinnawala* is a different, longer, more expensive trip than
Colombo → Kandy, and a founder advertising a discount on the latter did not offer it on the
former. A rule intended to cover a detour is authored as a tour, or applied manually. The
matcher compares the full ordered stop chain, not just first and last.

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
| Estimated cost | Existing engine cost estimate for the complete quote, never exposed publicly. **Amended 2026-08-09: this is not a field.** `engine.ts` computes `costCents` locally and exposes only `marginEstimateCents = totalCents - costCents` on `QuoteResult` — which is `null` for shared and is stripped server-side for non-founders (`stripQuoteMargin()`). The cost cap needs cost itself, inside the engine, before finishing. M18.2 surfaces it as a first-class internal value rather than back-deriving it from a founder-only, nullable field |
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

**Amended 2026-08-09 — `amountDueNowCents = totalCents` is no longer universally true.**
The engine still hard-codes it (`api/src/quote/engine.ts:142`), but two paths sit outside the
engine and already do, or will, charge less than the quote total:

- **Partial-leg pay links (shipped).** `quotes.sold_cents` freezes a trimmed-sale amount and
  `api/src/routes/quotePay.ts` books at `total = amountDueNow = soldCents`. This is a *smaller
  sale*, not a part-payment — the unticked legs are never sold — so the equation still holds
  for the booking that results, but it holds against a `totalCents` the discount engine never
  produced. See §9.4 and the open item at §18.1.
- **Deposits (approved, unbuilt).** These deliberately introduce `amountDueNow < total` for a
  booking that is genuinely part-paid. See §18.2.

The invariant as written therefore scopes to **one engine-priced quote converting in full**.
Any path that charges an amount the engine did not author must state its own equation and
prove the below-cost guard (`totalCents >= estimatedCostCents`) separately — the cost floor is
the one part of the contract that admits no exception on any path.

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

> **⚠ Amended 2026-08-09 — this ordering, as written, breaks a shipped money path.**
> `api/src/quote/paySelection.ts` parses `result.lineItems` **positionally**: the first
> `engine.legs.length` items are legs, "everything after the legs is an extra, except the
> finishing adjustment," which it drops by matching `meta.kind === 'price_adjustment'`. Its own
> comment states "position is the contract."
>
> A negative discount item placed between the extras and the finishing item therefore falls
> inside that slice, survives the filter, and is mapped as an **extra** with a positional index
> that no longer aligns with `engine.extras`. Consequences on a private quote: the hosted pay
> page (`quotePay.ts:72`) shows a negative, tickable "extra"; `extraIndexes` in a stored
> `pay_link_selection` silently refer to the wrong charge; unticking the discount makes a
> partial link charge **more** than the quote; and `isFullSelection` mis-decides whether to use
> the verbatim total. This reaches the customer, not just link minting.
>
> §18.5 records the decision. Whatever is chosen, M18.2 may not emit a discount line item into
> `lineItems` until `paySelection.ts` has been made explicitly aware of it, with a test that
> mints and prices a partial link on a discounted quote.

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

**Rewritten 2026-08-09.** The original text — "finishing's 2.5% reduction limit is calculated
from the discounted subtotal" — describes a rule the owner replaced on 2026-07-26, after a
$1,842.77 chauffeur quote finished at $1,799.00 and gave away $43.77 because 2.5% of a large
number is a lot of money. `api/src/quote/priceFinish.ts` now enforces **two** limits, and a
downward finish must clear both:

- the proportional cap, `maxReductionBps` (which protects small totals); and
- an absolute cap, `MAX_REDUCTION_CENTS = $10` (which protects large ones).

The charm target is the "…9.00" price on a **fixed $10 grid**, not a grid that widens with
magnitude. Owner rule, 2026-07-26: *round to the nearest $10 and never give away more than $10.*

For discounts this is strictly good news — the giveaway below the discounted subtotal is
bounded by construction at $10 regardless of quote size — but three consequences must be built
and tested deliberately:

- Both limits are computed from the **discounted** subtotal, not the gross. A discount that
  moves the subtotal across a $10 grid boundary changes which charm candidate finishing picks;
  that is expected, and the golden fixtures must pin it rather than treat it as drift.
- For an explicit discount, finishing's downward minimum is estimated cost rather than the
  ordinary sell-price fare floor, because the founder may intentionally cross the sell floor.
  This is unchanged, and is passed as `minimumAllowedCents`.
- Finishing may round upward. It may never reduce the final total below estimated cost; at cost
  it returns unchanged.

Any M18.1 fixture asserting the old 2.5%-only behaviour, or a magnitude-widening charm
interval, is asserting behaviour that no longer exists.

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
  **Delivered** — the unique constraint shipped with SH5 (§11.4).
- **There is a second conversion path (added 2026-08-09).** `api/src/routes/quotePay.ts`
  converts an Ops quote to a booking through a pay link, independently of
  `POST /bookings/from-quote-v2`. It charges `soldCents ?? totalCents` and does not consult a
  discount snapshot. Every guarantee in this section — frozen snapshot adoption, the
  `promotion_exhausted` budget re-check under the family advisory lock, one idempotent
  transaction, unique conversion link — must hold on **both** paths or the pay-link path must
  refuse discounted quotes outright. Until §18.1 is decided, it refuses: minting a pay link
  from a quote with an active `quote_discounts` row fails closed. Silently charging a
  discounted quote its undiscounted total, or its discounted total without consuming budget,
  are both unacceptable outcomes and both are reachable if this is left implicit.
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
| `route_from_canon_key`, `route_to_canon_key` | nullable `canonPlace()` keys; required for route. **Renamed 2026-08-09** from `route_from_place_id`/`route_to_place_id` — no place-ID concept exists (§5.1) |
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

**Amended 2026-08-09 — every schema change in this subsection has already shipped**, built by
other features between 2026-07-27 and 2026-08-08. M19.2 must be re-cut to what actually
remains: `quote_discounts` (§11.2) and the discount-aware projections. Do not re-propose the
columns below.

Add to `quotes`:

- ~~`revision integer not null default 1` for optimistic concurrency.~~ **Delivered** —
  `api/src/db/schema.ts`, shipped by quote version history (`2026-08-05-quote-history-design.md`,
  PRs #308/#311). Verify it is actually enforced as an optimistic-concurrency token on the Ops
  save path before M20.2 depends on it; the history feature needed a counter, which is a weaker
  requirement than a 409-on-stale gate.
- ~~A unique index on nullable `converted_booking_id`.~~ **Delivered** —
  `quotes_converted_booking_id_unique`, shipped by SH5.

`quotes` also gained, from features this spec did not anticipate: `pay_link_selection`,
`sold_cents`, `pay_link_seq` (partial-leg links — §18.1); `customer_total_cents`,
`customer_total_at`, `customer_total_via` (price-drift indicator); `offer_valid_until`; and
`access_token_digest`. The price-drift columns record *the total the customer was last quoted*
— once discounts exist, that figure is a discounted total, and the drift indicator will compare
a discounted total against a fresh undiscounted one unless it is made discount-aware. Add that
to M22.

A sibling table `quote_revisions` now stores one row per superseded quote state. `discount_events`
(§11.3) must be reconciled against it rather than duplicating the quote-side audit trail.

Canonical intent/fingerprint, promotion snapshot, locked FX, and server engine I/O stay
inside the existing request/result snapshots unless query requirements later justify a
column. The web edit credential is signed and is never stored in plaintext.

Add nullable, legacy-compatible fields to `bookings`:

- ~~`subtotal integer`.~~ **Delivered** — migration `0026`, SH5.
- ~~`discount_total integer`.~~ **Delivered** — migration `0026`, SH5. Currently hard-coded to
  `0` at `api/src/db/quoteConversionRepo.ts:169` with a comment reserving it for this feature.
  That constant is the seam M19 writes to.
- ~~`pricing_snapshot_json jsonb`.~~ **Delivered** — migration `0026`, SH5.

Existing `total`, `amount_due_now`, and `currency` remain the payment contract. A null
snapshot means legacy/no-discount. Money checks are non-negative; application and
integration tests enforce the cross-field equation. The booking pricing snapshot is
immutable after creation. A `bookings` check constraint already enforces
`amount_due_now is null or (amount_due_now >= 0 and amount_due_now <= total)`; the
discount equation constraint is added alongside it, not instead of it.

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

**Amended 2026-08-09 — both endpoints already exist.** SH4 built them
(`api/src/routes/quote.ts:161` and `:199`), with the signed access token
(`digestAccessToken`, `quotes.access_token_digest`), the `revision` column, and the seven-day
expiry fixed at creation (`quote.ts:173`), behind the `QUOTE_V2_ENABLED` flag. **M21.2 is
delivered.** What remains of M21.2 is additive: accept an optional promo code on create,
evaluate candidates on each edit, and return the applied-promotion label and the discount
errors below. The build plan's note that "SH4/SH5 must be reconciled with M21.2/M21.4"
resolves in SH4's favour — extend it, do not rebuild it.

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

**Amended 2026-08-09 — the surface list above is incomplete.** Five customer-facing money
renderers shipped after this spec was written, and the "agree to the cent from one stored
snapshot" goal (§2) now spans all of them:

| Surface | File | Note |
| --- | --- | --- |
| Customer quote page `/q` | `api/src/routes/quoteView.ts`, `api/src/quote/customerQuoteView.ts` | Read-only proposal page (PR #327). Renders the quote total, or `soldCents` on a partial link |
| Quote card | `api/src/routes/quoteCard.ts` | |
| Pay card | `api/src/routes/payCard.ts` | |
| Share card (image) | `api/src/routes/shareCard.ts`, `shareCardImage.ts` | **Renders money into a PNG.** A stale or wrong figure here cannot be corrected by a reload, and it is the surface most likely to be forwarded |
| Hosted pay page | `api/src/routes/quotePay.ts` | The second conversion path — see §9.4 |

Each is added to the cross-surface golden-fixture set (§14.1). The share-card image needs its
own assertion on the rendered figure, not just on the data passed to the renderer.

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

**Amended 2026-08-09 — baseline moved; fixtures must be written against current values.**
M18.1 freezes today's behaviour, so it has to freeze *today's*, not 2026-07-15's:

- **Finishing** — the two-limit / fixed-$10-grid rule of 2026-07-26 (§7.5), not the old
  2.5%-only, magnitude-widening one.
- **Van minimum fare is $49.99**, not $50.00 (PR #349). Any floor fixture carried over from
  before 2026-08-07 is wrong by a cent, which is exactly the class of error this gate exists
  to catch.
- **Product labelling** — the chauffeur product was renamed twice in two days (PR #336
  "Chauffeur & guide" → "Chauffeur Service", then PR #346 → "Chauffeur-guide"). Settle the
  label before fixtures encode it; a fixture that pins customer copy will churn otherwise.
- **Multi-stop legs with `via_stops`**, and a leg-count/km case per §5.1's via-stop rule.
- **The five surfaces added in §13.4**, including the share-card image.
- **Partial-leg pay link at `sold_cents`** — the undiscounted baseline for §18.1, so that
  whatever is decided there can be proved cent-identical for the no-discount case.

Reconcile the leg-count definition (§7.1) against `api/src/db/checkBookingLegs.ts` rather than
deriving a second count. Booking legs shipped 2026-08-08 with an explicit note that leg
*counts* are never compared across derivations — a promotion condition that silently invents a
third counting rule will disagree with the reconciliation gate.

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

**Status check 2026-08-09: still open, and now sequenced.** `api/src/quote/rateCard.ts` has
`costPerKmCents` and `dayRateCostCents` but extras remain sell-only (`extras: { sightseeing:
1000, 'safari-wait': 1900, luggage: 500, front: 800, flex: 1200, waiting: 1000 }`). Nothing has
moved in three and a half weeks.

**Collect the cost basis *after* per-leg sightseeing attribution ships, not before.**
`2026-08-01-per-leg-sightseeing-attribution-design.md` (approved, unbuilt) restructures how
`sightseeing`, `waiting` and `safari-wait` are emitted through `collectExtras` → `priceExtras`
— three of the six extras this section needs costs for. Costing them now means costing a shape
that is about to change, and re-asking the owner is worse than asking once, late.

`luggage`, `front` and `flex` are unaffected by that refactor and can be costed at any time.
If the owner wants to unblock incrementally, those three are the safe half.

## 18. Open items (added 2026-08-09 — owner decisions required)

These arose from features that shipped after this spec was written. Each blocks a specific
milestone. None can be resolved by an implementer choosing a default.

### 18.1 Discounts and partial-leg pay links — blocks M19.3, M20.4, M22

Partial-leg pay links shipped in early August: an Ops quote can mint a link for a ticked
subset of legs, charging `sold_cents` — the sum of those legs' line prices as already quoted.
Its governing rule is *a price that has been quoted is not changed*.

A discount does not compose with that rule, because the per-leg lines sum to the **subtotal**
while the discount sits between subtotal and total, alongside finishing. Three options:

1. **Refuse.** A quote with an active discount cannot mint a partial link. Simplest, safe,
   and losing nothing that exists today. *This is the interim behaviour the spec now assumes
   (§4.2, §9.4) so that implementation can proceed without pre-empting the decision.*
2. **Pro-rate.** Allocate the discount across ticked legs by line share. Honest, but it
   invents a per-leg discount concept the whole spec is built to avoid, and it interacts with
   the cost cap per leg rather than per quote.
3. **Whole discount on the subset.** Simple to state, but a founder who discounted a four-leg
   trip by $80 did not offer $80 off two legs; on a small subset it can breach the cost floor,
   which no option may do.

Recommendation: **option 1 at launch**, revisited only if it actually bites. Options 2 and 3
are each their own design.

Related: budget accounting. If a partial link ever converts a discounted quote, does it spend
a redemption (§7.6)? Under option 1 the question does not arise, which is a further argument
for it.

### 18.2 Hot zones are half-shipped, and the halves price differently — blocks M18.1 and §2

The hot-zones design header read "No code written" until it was corrected on 2026-08-09.
Phases 1+2 merged
(PRs #116, #126): `api/src/quote/hotZones.ts`, the `pricing_zones` table, `postgresZonesRepo`,
founder admin, and an ops-visible premium chip. The engine's **cost basis is already
zone-aware** — `perRideBoost` in `engine.ts:63` and `boostedBillableKm` in `engine.ts:96`,
byte-identical at zero active zones, per owner decision D6 (the boost books into cost, not
margin).

Two consequences, and the second is the serious one.

**Good news for the cost cap.** `maximumCostSafeDiscount = subtotalCents - estimatedCostCents`
already moves correctly on a zone trip, because both sides of that subtraction are zone-aware.
No fixture rebuild is needed on the Ops path, provided M18.1 fixtures are recorded with a known
zone configuration and pin the zero-zone case explicitly.

**Bad news for §2's cross-surface promise.** Phase 3 has **not** shipped: `generate-pricing.mjs`
dumps no zones, the front-end mirror has no zone code, and per the hot-zones design only
`internalQuote.ts` composes zones — `bookings.ts` joins in Phase 3. So with any zone active,
**an Ops quote and a website quote for the same trip already price differently today.** This
spec's goal — "a qualifying website or Ops quote receives the same deterministic automatic
promotion" (§2) — cannot hold across that split: a different subtotal is a different eligible
subtotal, which can select a different winner (§7.4 picks the greatest *applied* cents) and
certainly a different applied amount for any percentage rule.

Therefore: **hot-zones Phase 3 is a prerequisite for public automatic promotions**, not an
independent track. Manual Ops discounts (M20) are unaffected and can proceed. Add Phase 3 to
the §15 rollout sequence ahead of step 7 (`PUBLIC_AUTOMATIC_PROMOTIONS_ENABLED`).

Note also the hot-zones drift-guard constraint: the guard's tolerance must stay ≥ the maximum
active `boost_pct`. A discount widens the legitimate gap between the front-end's computed
`quotedTotal` and the server's price, so whatever tolerance Phase 3 sets has to account for
discount magnitude too, or discounted website bookings will start tripping the guard.

**Deposits** (`2026-07-23-deposits-balance-payments-design.md`, approved, unbuilt) remain a
genuine sequencing decision. They break `amountDueNowCents = totalCents` (§6) — the same line
discounts rely on. Whichever ships second pays the integration cost; they must not be built
concurrently.

Decision needed: the order of hot-zones Phase 3, deposits, and M18.

### 18.3 Which clock governs an Ops quote's locked promotion — blocks M20.2

§3 says a promotion valid when a quote was locked stays valid for that quote's full lock, and
§9.3 fixes the web lock at seven days from creation. There are now **two** clocks:

- the seven-day web quote-v2 expiry (`quote.ts:173`), and
- `quotes.offer_valid_until` — approval + 7 days, stamped on the Ops → ready transition
  (`2026-08-05` D9), which the spec's §9.2 approval-freeze language predates.

An Ops quote approved on day 1 and sent on day 5 has a different promotion-durability window
depending on which clock governs. State it explicitly: the Ops-side answer is almost certainly
`offer_valid_until`, since that is what the customer was told the price is honoured until, but
it needs saying rather than inferring.

### 18.4 Automatic promotions on front-end-priced pages — blocks M22

§1 asserts the website "never calculates an authoritative discount independently." That is
achievable only on the quote-v2 path. Route and tour pages still recompute prices in the
browser from constants dumped by `tools/generate-pricing.mjs` — the codegen never calls the
engine — and `booking.js` submits a client `quotedTotal` that the server re-prices behind a
drift guard (verified in the hot-zones design, §2/C1).

So an automatic promotion cannot appear on a route or tour card until either the rule set is
dumped alongside the other pricing constants (a second implementation of the matcher in
front-end JS, with parity tests — the C1 problem again, and a bad trade for this feature), or
promotions are shown **only after a v2 lock**, on the booking summary.

Recommendation: the latter. §13.1 already scopes the promo-code input to booking summaries;
extend the same restriction to automatic promotion display, and say so, so nobody later reads
"sitewide promotion" as "shows on every route card."

### 18.5 Where the discount line item goes — blocks M18.2

§6's line-item ordering (core, extras, **discount**, finishing) is incompatible with
`api/src/quote/paySelection.ts`, which reads `result.lineItems` positionally and treats
everything after the legs as an extra unless it is the `price_adjustment`. See the warning box
in §6 for the failure modes. Three ways out:

1. **Tag it and filter it.** Emit the discount with `meta.kind = 'discount'` and extend
   `paySelection.ts` to exclude it exactly as it excludes `price_adjustment`. Smallest change,
   keeps §6's customer-facing ordering, and is the only option that leaves the rendered order
   as the spec intended. Requires touching a shipped money module — one test, red→green.
2. **Move it last.** Emit the discount after the finishing item. Avoids editing
   `paySelection.ts` at all, but the filter still has to skip it, so it does not actually avoid
   the change — and it puts the internal finishing line above the customer-facing discount
   line, which every renderer then has to reorder.
3. **Keep it out of `lineItems` entirely.** Carry the discount only in the structured
   `discountCents` / `AppliedDiscountSnapshot` fields (§6) and let renderers compose the row.
   Cleanest separation and zero risk to the positional contract, but it breaks the "complete
   line-item sum equals `totalCents`" invariant, which several surfaces rely on to self-check.

Recommendation: **option 1.** It is the only one that preserves both the sum invariant and the
customer-facing order, and the change to `paySelection.ts` is two lines plus a test.

Note this is *not* resolved by choosing §18.1 option 1 (refusing partial links on discounted
quotes). `payLines()` is also called on the full-link path and by the Ops line display, so a
discounted quote is mis-parsed whether or not a partial selection exists.

### 18.6 A discount edit silently kills outstanding pay links — blocks M20.2

`internalQuote.ts:1064` signs a pay-link capability over `{quoteId, revision}`:
`signQuotePayToken(quote.id, quote.revision, deps.linkSecret, seq)`. §9.2 requires every
discount mutation to reprice and save the quote, which bumps `revision` — so **applying,
replacing, or removing a discount invalidates every live pay link for that quote.**

That is arguably correct behaviour: a link minted at the old price should not keep charging it.
But it is currently silent, and a founder discounting a quote to close a deal has no idea the
link they already sent has just died. M20.4 must warn at the point of applying a discount when
an outstanding link exists, and say what will happen to it.

Note also that `quotes.revision` is **not** an optimistic-concurrency token today. Despite the
column existing (§11.4), `internalQuote.ts` returns no `quote_conflict` — its 409s are
`not_editable`, `quote_deleted`, `not_bookable`, and `not_linkable`. M20.2's stale-edit 409 is
unbuilt work, not a wiring-up of something already there.
