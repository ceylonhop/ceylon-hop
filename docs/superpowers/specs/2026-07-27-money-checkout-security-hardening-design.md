# Money & Checkout Security Hardening — Design Spec

**Date:** 2026-07-27  
**Status:** Proposed; implementation not started  
**Scope:** Pricing locks, checkout authorization, PayHere acceptance, payment evidence,
database money invariants, and manual refunds

## 1. Outcome

Ceylon Hop must be able to prove, for every booking:

1. which server-generated price the customer accepted;
2. why checkout was authorized;
3. exactly how much PayHere was asked to collect;
4. which authenticated PayHere event settled that amount;
5. that payment and booking state cannot disagree after a retry or crash; and
6. whether a promised refund was actually completed.

This work hardens the existing full-payment path. It does not introduce deposits, balance
payments, promotions, or automated refunds.

## 2. Existing strengths that remain unchanged

- Money remains integer USD cents.
- The booking engine, not `quotedTotal`, is authoritative whenever it can price.
- Checkout accepts no client-supplied amount.
- Checkout charges the persisted payment row.
- PayHere webhook amount and currency remain reconciled against that payment row.
- PayHere remains hosted checkout; Ceylon Hop never handles card details.
- Ops money actions remain human-session and `payments:act` gated.
- Tests and development continue to use payment fakes; no test calls PayHere.

## 3. Behavior-change budget

This is not a claim that every observable behavior remains identical. Four security fixes
deliberately change behavior; everything else is a parity requirement.

| Surface | Required behavior after the work |
|---|---|
| Pricing arithmetic, rates, floors, finishing, extras, vehicle upgrades | **No change.** Identical server intent must produce identical cents and line items. |
| Existing `/bookings/single`, `/trip`, `/shared` validation and stored amounts | **No change**, except an additive checkout token in successful responses. |
| Valid checkout | **No commercial change.** Same PayHere URL, order, amount, currency, customer fields, and booking transition. |
| Checkout without a valid capability | **Intentional change:** accepted today; rejected after SH6 enforcement. |
| Valid PayHere success | **No customer change.** Same paid state, confirmation, and concierge task; implementation becomes atomic and auditable. |
| Invalid/non-success PayHere events | **Intentional hardening:** malformed/unknown events fail closed and known pending/cancel/failure/chargeback states are distinguished. |
| Legacy `/quote` and `/quote/lock` | **No change while compatibility remains.** Quote v2 is additive and default-off until its staged cutover. |
| Quote-v2 conversion | **Intentional change:** exact stored server price is adopted instead of re-running Maps/money. |
| Shared inventory, schedule, seat price, and checkout | **No change.** |
| Customer booking view and permanent view links | **No change.** View tokens remain view-only and non-expiring. |
| Booking confirmation, reminder, and failure-email content/timing | **No change** for the full-payment happy path. |
| Existing refund button/status/email | **Intentional change only at SH9 cutover:** request and completion become separate; completion email waits for PayHere evidence and uses the actual amount. |
| Deposits, balances, promotions, automated refunds | **No behavior introduced.** |

No implementation PR may spend outside this behavior-change budget. A newly discovered
behavioral dependency stops the step for owner review.

## 4. Delivery grouping

The seven review findings become five cohesive workstreams:

| Workstream | Findings covered | Why combined |
|---|---|---|
| A. Payment acceptance | Atomic settlement, provider evidence, PayHere parser hardening | They share one webhook event contract and one transaction boundary. |
| B. Exact quote lock | Bind quote to itinerary and stored total | Lock creation and strict conversion share one canonical intent contract, but ship as two PRs. |
| C. Checkout capability | Protect checkout | Independent authorization boundary with one backend/frontend contract. |
| D. Database invariants | Money/status constraints | One forward-only migration after application paths are compatible. |
| E. Refund ledger | Truthful, auditable manual refunds | Reuses provider evidence and anticipates the approved deposits/refunds design without calling a new external API. |

Workstream A is the immediate live-payment blocker. Workstream B supersedes the legacy
`/quote/lock` behavior for new website flows and aligns with M21 quote v2. Workstream E
implements only the manual portion of the approved deposits/refunds design.

## 5. Security invariants

### 5.1 Price and checkout

- A public locked quote is created only from a server-resolved pricing intent.
- The locked record contains the canonical intent, its SHA-256 fingerprint, the exact
  engine result, currency, rate-card snapshot, revision, and fixed expiry.
- Strict booking conversion requires the lock ID, access token, current revision, and an
  exact intent fingerprint match.
- Conversion adopts the stored result. It does not call Maps or recompute money.
- A quote can create at most one booking.
- Checkout requires a signed, short-lived, single-purpose capability for that booking.
- The capability authorizes starting checkout, never changing the amount.

### 5.2 Payment acceptance

- A webhook is parsed only when merchant, signature, order, amount, currency, status, and
  provider transaction ID are structurally valid.
- The configured merchant ID must equal the posted merchant ID.
- A successful event is accepted only when order, amount, and currency match a stored
  payment.
- Recording the provider event, settling the payment, and transitioning the booking happen
  in one Postgres transaction.
- Retrying any accepted event returns the already-committed outcome and repairs no state
  outside that transaction because no partial financial state is possible.
- A reversal/chargeback is recorded and alerted, but does not silently rewrite booking
  history.

### 5.3 Refunds

- `refunded` means a refund was recorded as completed, not merely requested.
- A refund request and a refund completion are separate events.
- Completed cumulative refunds cannot exceed captured succeeded payments.
- Completion requires an actor, amount, currency, PayHere reference, and completion time.
- The customer receives a refund-complete email only after the completion transaction
  commits.

## 6. Workstream A — payment acceptance

### 6.1 Strict PayHere event contract

Replace the webhook's binary `succeeded|failed` interpretation with:

```ts
type ProviderPaymentStatus =
  | 'succeeded'
  | 'pending'
  | 'cancelled'
  | 'failed'
  | 'charged_back';

interface VerifiedPaymentEvent {
  provider: 'payhere';
  merchantId: string;
  orderId: string;
  providerTxnId: string;
  amountCents: number;
  currency: 'USD';
  status: ProviderPaymentStatus;
  providerStatusCode: string;
  receivedAt: Date;
  payloadSha256: string;
  sanitizedPayload: Record<string, string>;
}
```

Parsing rules:

- Accept `application/x-www-form-urlencoded` only for the PayHere adapter.
- Apply a small body limit before parsing.
- Reject duplicate security-critical fields.
- Require posted `merchant_id === configured merchantId`.
- Require `payhere_amount` to match `^[0-9]{1,9}\.[0-9]{2}$`, be positive, and convert
  exactly to safe integer cents.
- Require currency `USD`.
- Require non-empty bounded `order_id`, `payment_id`, `status_code`, and `md5sig`.
- Compare signatures with a length guard and `timingSafeEqual`.
- Map PayHere status codes explicitly. Unknown codes fail closed.
- Remove `md5sig` before retaining a sanitized payload. Store a SHA-256 digest of the raw
  body for forensic correlation.

Checkout hash generation remains PayHere-compatible MD5. This change does not replace a
gateway-mandated algorithm; it hardens validation around it.

### 6.2 Payment evidence

Extend `payments` additively:

- `gateway_payment_id text null`
- `settled_at timestamptz null`
- `settlement_source text null` (`webhook|legacy_backfill`)
- `updated_at timestamptz not null`

Add append-only `payment_events`:

- `id uuid pk`
- `payment_id uuid not null fk payments`
- `provider text not null`
- `provider_txn_id text not null`
- `provider_status_code text not null`
- `normalized_status text not null`
- `amount integer not null`
- `currency text not null`
- `payload_sha256 text not null`
- `sanitized_payload jsonb not null`
- `received_at timestamptz not null`

Event identity is unique on
`(provider, provider_txn_id, provider_status_code)`, which makes retries idempotent even if
form-field order changes. `payload_sha256` remains indexed forensic evidence. A later
chargeback can legitimately reference the original transaction because it carries a different
status code. Non-null payment `gateway_payment_id` values are unique within a provider.

Raw signatures, merchant secrets, card data, and unbounded request bodies are never stored.
Payment evidence is internal-only and excluded from ordinary booking/customer projections.

Historical succeeded payments have no provider timestamp. The migration backfills
`settled_at = created_at` and `settlement_source = 'legacy_backfill'`; new accepted successes
write the actual receipt time and `settlement_source = 'webhook'`. This preserves historical
rows without presenting an estimated timestamp as gateway evidence.

### 6.3 Atomic settlement transaction

Introduce a dedicated transaction interface rather than attempting to coordinate
`PaymentRepo` and `BookingRepo` calls in the route:

```ts
interface PaymentSettlementRepo {
  acceptVerifiedEvent(
    event: VerifiedPaymentEvent,
  ): Promise<
    | { kind: 'settled'; payment: Payment; booking: Booking }
    | { kind: 'duplicate'; payment: Payment; booking: Booking }
    | { kind: 'failed'; payment: Payment; booking: Booking }
    | { kind: 'reversal'; payment: Payment; booking: Booking }
    | { kind: 'unexpected_booking_state'; payment: Payment; booking: Booking }
  >;
}
```

The Postgres implementation performs one transaction:

1. lock payment by order ID;
2. reject unknown order or amount/currency mismatch;
3. insert the immutable event, returning `duplicate` on its unique conflict;
4. for success, lock the booking and inspect its state;
5. update payment to `succeeded`, gateway ID, and settlement time because captured money
   must always be recorded;
6. compare-and-set a `payment_pending` booking to `paid`, or preserve a cancelled/otherwise
   progressed booking and return `unexpected_booking_state` for critical reconciliation;
7. commit and return the committed projection.

If any step fails, every write rolls back. The in-memory implementation exposes the same
interface and semantics for route tests.

Email, concierge tasks, and alerts remain post-commit best-effort side effects. Existing
notification-log/watchdog behavior handles a side-effect failure without corrupting money
state.

## 7. Workstream B — exact quote lock

The legacy `/quote/lock` contract locks a rate card, not an exact payable result. It remains
temporarily compatible but must not gain promotions or become the final strict conversion
path.

### 7.1 Canonical intent

Quote v2 accepts customer intent, not client pricing inputs:

- product/service;
- canonical route or tour identity;
- exact pickup/drop-off text retained separately;
- vehicle, passenger and bag counts;
- ordered stops/travel dates;
- selected extras.

The server resolves Maps distances and builds the engine request. A stable serializer sorts
object keys, preserves array order, normalizes optional fields, and produces:

```ts
intentFingerprint = sha256(canonicalJson(intent))
```

Client-supplied `distanceKm`, `seatPriceCents`, rate cards, totals, or discounts are not part
of the accepted v2 request.

### 7.2 Lock record and access

The v2 lock stores:

- canonical intent and fingerprint;
- server engine request and result;
- subtotal/discount/total/due-now snapshot when those fields exist;
- currency and rate-card snapshot/version;
- `revision`;
- fixed `expiresAt` seven days after initial creation;
- a random or signed browser-session edit/access token digest;
- nullable unique `convertedBookingId`.

Updates require the access token and current revision. Updates do not slide the expiry.

### 7.3 Strict conversion

Conversion requires `{ quoteId, accessToken, revision, bookingDetails }`.

The service:

1. locks the quote row;
2. verifies web channel, token, revision, expiry, and unconverted state;
3. reconstructs the canonical booking intent;
4. verifies the fingerprint exactly;
5. creates the booking using the stored result/currency;
6. stores the immutable booking pricing snapshot;
7. sets `convertedBookingId`;
8. commits atomically.

A retry returns the same booking. A changed trip returns `409 quote_intent_mismatch`; an
expired quote returns `409 quote_expired`; a stale revision returns `409 stale_quote`.

This is the security core already anticipated by M21.2 and M21.4. Those steps must use this
contract rather than creating a second quote-conversion design.

## 8. Workstream C — checkout capability

The existing permanent view token remains valid for the allow-listed customer view. Checkout
gets a separate versioned payload:

```ts
type CheckoutTokenPayload = {
  v: 1;
  purpose: 'checkout';
  bookingId: string;
  exp: number;
};
```

- Sign with the dedicated booking-link secret using HMAC-SHA256.
- Default lifetime: 30 minutes.
- Verify purpose, version, expiry, signature, and route booking ID.
- Return the token from successful booking creation and strict quote conversion.
- Idempotent booking-create retries issue a fresh token for the same booking; tokens are not
  persisted and the existing 200/201 idempotency semantics remain unchanged.
- Require it as `Authorization: Bearer <token>` on
  `POST /bookings/:id/checkout`.
- Add `authorization` to the existing CORS allow-header list without changing the origin
  allow-list or credential policy.
- Do not put the checkout token in logs or analytics.
- The customer manage-link flow may exchange a valid view token for a fresh checkout token
  only while the booking is chargeable.

Rollout:

1. deploy backend accepting token and, behind an explicit temporary compatibility flag,
   legacy no-token checkout;
2. deploy the website sending the token;
3. prove staging E2E;
4. disable/remove compatibility before live release.

Production must fail closed if the compatibility flag is enabled.

## 9. Workstream D — database invariants

Add database checks after a preflight query proves current rows are compatible:

### Bookings

- `total >= 0`
- `amount_due_now is null or amount_due_now between 0 and total`
- currency in the supported currency set (`USD` today)
- mode in `single|trip|shared`
- status in the application status set

### Payments

- `amount > 0`
- currency in the supported set
- provider in the supported provider set
- status in the payment status set
- succeeded rows require `settled_at`
- succeeded rows require `settlement_source`

### Shared inventory and pricing

- corridor seat price and capacity are positive
- booked seats are non-negative and do not exceed total seats

Use named constraints. Apply them `NOT VALID` where appropriate, validate after preflight,
and document a forward-fix rollback: drop only the new constraint if production reveals a
legacy incompatibility; never roll back data migrations destructively.

Application validation remains in place for readable API errors. Database constraints are
the final line of defense.

Every future feature that adds a booking/payment/provider/currency status—such as
`deposit_paid`—must update the named constraint in that feature's own migration. The
constraint is not silently loosened to accommodate hypothetical future values.

The initial provider constraint includes `payhere|fake`: `fake` remains necessary for the
existing test/development contract, while production configuration continues to forbid it
unless explicitly operating a non-money staging environment.

## 10. Workstream E — truthful manual refunds

This is a minimal, manual-only implementation compatible with the broader approved
deposits/refunds design.

### 10.1 Refund ledger

Add `refunds`:

- `id`, `bookingId`, `paymentId`
- `amountCents`, `currency`
- `status: manual_pending|manual_confirmed|cancelled`
- `reason`
- `gatewayRef`
- `requestedBy`, `requestedAt`
- `confirmedBy`, `confirmedAt`
- `createdAt`, `updatedAt`

Rules:

- A request amount must be positive.
- Currency must match the captured payment.
- Requested plus confirmed, non-cancelled refunds cannot exceed succeeded captured money.
- `gatewayRef` is required and unique within provider scope at confirmation.
- A requester may also confirm only if the existing RBAC policy permits it; both actions
  remain `payments:act` gated and actor-stamped.

### 10.2 Workflow

Replace the current status-flip refund endpoint with:

- `POST /admin/bookings/:id/refunds` — create `manual_pending`;
- `POST /admin/bookings/:id/refunds/:refundId/confirm` — require PayHere reference and
  atomically mark confirmed;
- `POST /admin/bookings/:id/refunds/:refundId/cancel` — cancel an unconfirmed request;
- `GET /admin/bookings/:id/refunds` — finance/founder history.

The booking becomes `refunded` only when the confirmed refund plan says the booking is fully
refunded. A partial refund remains a ledger fact without falsely implying the whole fare was
returned.

Customer email is sent after confirmation and states the actual refunded amount. No route
calls the PayHere refund API in this milestone.

The future deposits/refunds milestone may extend the same table with automated
`pending|succeeded|failed` states and a refund adapter; it must not create a parallel ledger.

SH8 is additive: it introduces the ledger and new API while the current refund action remains
available to the existing UI. SH9 ships the replacement UI and removes the old direct
status-flip endpoint in the same deployable PR, so no intermediate release strands finance.

## 11. API error model

Money-sensitive errors are stable machine codes:

- `invalid_signature`
- `invalid_payment_event`
- `wrong_merchant`
- `unknown_order`
- `amount_mismatch`
- `currency_mismatch`
- `payment_state_conflict`
- `checkout_token_required`
- `invalid_checkout_token`
- `checkout_token_expired`
- `quote_intent_mismatch`
- `quote_expired`
- `stale_quote`
- `refund_exceeds_captured`
- `refund_already_confirmed`

Public responses contain no secrets, raw provider payloads, stack traces, margins, or costs.

## 12. Drift-control contract

Before implementation begins, freeze reviewed characterization fixtures for:

1. private, chauffeur, and shared engine request/result cents and line items;
2. all three booking-create response/status/DB projections;
3. checkout params including PayHere field names and formatted amount;
4. valid success, duplicate success, and ordinary failure webhook outcomes;
5. confirmation email recipient, subject category, and one-send behavior;
6. customer view projection;
7. Ops booking/payment projections and role matrix; and
8. current full-payment smoke from booking through confirmation/task.

Each implementation PR must:

- name its allowed files and reject unrelated changes;
- run the relevant characterization fixtures unchanged;
- add negative tests proving the intended security delta;
- keep new quote-v2 or migration behavior default-off until its cutover step;
- include an API/schema before-and-after table in the PR;
- show red→green evidence for new behavior and green→green evidence for parity fixtures;
- pass independent review against this behavior-change budget; and
- provide a forward-fix rollback that does not delete financial history.

For quote v2, run a shadow parity corpus before enabling it: feed identical
server-resolved engine requests through the current engine and stored-result path and require
exact total/line-item equality. Differences block rollout; they are not “close enough.”

## 13. Testing and release gates

### Automated

- Unit tests for strict amount parsing, merchant matching, status mapping, token
  purpose/expiry, and canonical intent serialization.
- Repository integration tests against Postgres for transaction rollback, duplicate events,
  simultaneous success events, constraints, unique conversion, and refund overage.
- Route tests for every stable error code and unchanged successful response.
- Characterization/golden tests from §12 remain unchanged and green in every PR.
- CORS tests prove the existing origin allow-list is unchanged and only the
  `authorization` request header is added.
- E2E for quote lock → booking → authorized checkout → fake PayHere success → paid customer
  view, plus expired/wrong token paths.
- Existing `npm run check`, `npm run smoke`, and `npm run test:all` gates remain mandatory.

### Human checkpoints

- PayHere sandbox payment settles exactly one payment and one booking.
- Replaying the captured sandbox notification is idempotent.
- A forced failure inside settlement leaves both rows unchanged, then succeeds on retry.
- A locked quote pays the displayed amount after a controlled rate/Maps change.
- Checkout without its capability is refused.
- Finance records a sandbox-dashboard refund reference; only confirmation sends the email.

## 14. Rollout and compatibility

1. Ship payment evidence and atomic settlement before taking or expanding live traffic.
2. Deploy constraints only after production preflight reports zero invalid rows.
3. Introduce quote v2 behind a flag; legacy locks remain readable but cannot receive new
   promotions.
4. Deploy checkout capability with a short staging-only compatibility window, then fail
   closed.
5. Replace refund status flip only after the ledger UI is available to finance.

Rollback disables new route creation while preserving already-created evidence, locks, and
refund records. Migrations are forward-only; no rollback deletes financial history.

## 15. Out of scope

- Deposits and balance collection.
- Promotion evaluation and management.
- Automated PayHere Merchant API refunds.
- Chargeback-driven automatic booking cancellation.
- Multiple settlement currencies.
- Customer accounts.
