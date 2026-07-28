# Money & Checkout Security Hardening — Build Plan

**Design:** [`../specs/2026-07-27-money-checkout-security-hardening-design.md`](../specs/2026-07-27-money-checkout-security-hardening-design.md)  
**Delivery:** nine steps; each step is one branch, one PR, tests first  
**Priority:** mandatory security gate before broader live-payment traffic, promotions, or deposits

## Global rules

- Follow the repository red→green discipline and paste evidence into every PR.
- New backend code stays in `api/`; frontend changes are limited to the named checkout/quote
  surfaces and require `npm run test:all`.
- No test calls PayHere, Google, email, or another real external service.
- Schema changes are additive and forward-only.
- `cd api && npm run check` and `npm run smoke` are required for every backend PR.
- The design's behavior-change budget is binding. Existing parity fixtures are never edited
  merely to make a security PR pass.
- Every PR includes green→green evidence for its named unaffected behavior as well as
  red→green evidence for the security change.
- Any step that discovers an incompatible production row, PayHere contract ambiguity, or
  required interface outside its stated scope stops and asks.

## Dependency map

```text
SH1 strict provider event contract
 └─ SH2 payment evidence persistence
     ├─ SH3 atomic settlement
     └─ SH8 refund ledger API
         └─ SH9 refund Ops workflow

SH4 canonical quote-v2 lock
 └─ SH5 strict quote conversion

SH6 checkout capability

SH3 + SH5 + SH6
 └─ SH7 database constraints and complete payment smoke
```

SH4/SH5 must be reconciled with M21.2/M21.4. They are the security foundation of those
steps, not a parallel quote system.

## SH1 — Strict PayHere provider-event contract

**Goal:** malformed, wrong-merchant, or ambiguous PayHere bodies never reach money logic.

**Build**

- Replace `WebhookEvent` with the design's normalized verified-event type.
- Harden `PayHerePaymentAdapter.parseWebhook` with body/field bounds, exact amount parsing,
  merchant equality, explicit status mapping, safe signature comparison, sanitized payload,
  and payload digest.
- Update the fake adapter to emit the same normalized contract.
- Keep checkout hash behavior byte-compatible.

**Tests first**

- Valid pinned sandbox-style notification.
- Wrong merchant, signature, currency, missing transaction ID, duplicate critical field,
  unknown status, malformed/zero/oversized amount, and oversized body all fail closed.
- PayHere `2`, `0`, `-1`, `-2`, and `-3` map to the intended statuses.
- Checkout fields/hash fixture remains unchanged.
- Existing valid-success and ordinary-failure route response fixtures remain unchanged.

**Checkpoint**

- Existing captured/pinned notification parses.
- `npm run check` and smoke pass without network.

**Done when:** the adapter produces only a fully verified normalized event; no persistence
changes yet.

## SH2 — Payment evidence migration and repositories

**Depends on:** SH1

**Goal:** every accepted provider event has immutable, queryable evidence.

**Build**

- Add `gateway_payment_id`, `settled_at`, and `updated_at` to payments.
- Add `settlement_source`; backfill historical succeeded rows exactly as specified in the
  design so the later constraint is compatible and the timestamp's provenance is honest.
- Add `payment_events` with the constraints and indexes from the design.
- Add in-memory and Postgres event repositories.
- Add an internal reconciliation projection; do not expose payloads publicly.
- Document migration preflight and forward-fix rollback.

**Tests first**

- Insert/select round trip.
- Exact payload digest is idempotent.
- Same provider transaction can carry a later distinct reversal event.
- Missing/invalid money/status fields fail DB constraints.
- Public booking and Ops list projections do not leak sanitized payloads.

**Checkpoint**

- Migration applies to the test DB.
- Existing historical payment rows remain readable with nullable evidence fields.

**Done when:** evidence can be stored without changing webhook route behavior.

## SH3 — Atomic event acceptance and settlement

**Depends on:** SH2

**Goal:** payment and booking state cannot split across a crash, retry, or race.

**Build**

- Add the `PaymentSettlementRepo` transaction interface and in-memory implementation.
- Implement Postgres row locking and one-transaction event/payment/booking writes.
- Route success, failure, pending, cancellation, and chargeback through the transaction.
- Run email/tasks/alerts only from the committed outcome.
- Duplicate success verifies and returns the committed payment plus booking.
- Preserve the valid full-payment HTTP response, confirmation recipient/category, one-send
  behavior, and concierge-task behavior.

**Tests first**

- Inject failure after event insert, payment update, and booking update; every case rolls
  back all financial writes.
- Retry after each injected failure settles successfully.
- Two concurrent success notifications produce one event, one settlement, one paid
  transition, and no 500.
- Amount/currency mismatch writes no event or state.
- Success for a booking cancelled while the customer was on PayHere records the captured
  payment/event, preserves the cancelled booking, and raises the reconciliation outcome.
- Settled-payment/pending-booking legacy fixture is explicitly reconciled or alerted by a
  one-time repair path; normal operation can no longer create it.
- Reversal after success is recorded and alerted without silently changing booking history.

**Checkpoint**

- Fake full-payment smoke is green.
- Sandbox payment plus replay results in one paid booking and one accepted success event.

**Done when:** there is no route-level sequence of independent `markSucceeded` then
`setStatus` calls.

## SH4 — Canonical quote-v2 lock

**Goal:** a public locked quote is derived entirely from server-resolved intent and has a
fixed, authenticated lifetime.

**Build**

- Implement canonical intent schema/serializer/fingerprint.
- Add the v2 lock fields required by the design.
- Create signed/revisioned quote-v2 create/update endpoints using server Maps and the
  authoritative engine.
- Enforce a fixed seven-day expiry and non-sliding updates.
- Keep legacy `/quote/lock` unchanged and clearly deprecated for new site wiring.
- Keep v2 creation/update flags default-off; no existing website caller changes in this PR.

**Tests first**

- Stable serialization and fingerprint fixtures.
- Object-key order does not change the fingerprint; route/vehicle/extras/passenger changes
  do.
- Client distance, seat price, total, currency, and rate card are rejected/ignored as
  specified.
- Missing, forged, wrong, or expired access token; stale revision; Maps/unpriced failure.
- Updates never extend expiry.

**Checkpoint**

- Create and reopen a staging v2 quote.
- Changing a price-bearing field creates a new revision/result while preserving original
  expiry.

**Done when:** a v2 quote contains one replayable server intent and exact stored result.

## SH5 — Strict atomic quote conversion

**Depends on:** SH4

**Goal:** a valid lock creates exactly one booking at exactly the stored amount.

**Build**

- Add the strict conversion transaction described in the design.
- Require quote ID, token, revision, expiry, and exact intent.
- Adopt the stored result/currency; do not call Maps or recompute money.
- Store immutable booking pricing snapshot and unique quote back-link.
- Wire eligible website booking creation to v2 behind a feature flag.
- Update M21.2/M21.4 documentation to reference this implementation rather than duplicate it.

**Tests first**

- Maps/rate-card change after locking does not change converted amount.
- Route, traveller, vehicle, date, service, and extras mismatches return the stable conflict.
- Expired/forged/stale attempts fail without mutation.
- Failure injection rolls back quote and booking.
- Concurrent/replayed conversion returns one booking.
- Checkout amount, payment row, and webhook amount equal the stored quote result.
- Legacy/no-flag booking, quote, and checkout characterization fixtures remain unchanged.
- Shadow parity corpus proves identical server engine intent produces identical stored
  result cents/line items before the flag can be enabled.

**Checkpoint**

- Lock a staging quote, change a test rate/Maps fixture, convert, and observe the original
  amount through fake checkout.

**Done when:** new website quote conversion has no money recomputation path.

## SH6 — Signed checkout capability

**Goal:** a raw booking UUID is insufficient to start checkout or retrieve PayHere customer
fields.

**Build**

- Extend booking-token helpers with version, purpose, and expiry.
- Issue a 30-minute checkout token at public booking creation and strict quote conversion.
- Issue a fresh token when an idempotent booking-create retry returns the existing booking;
  do not persist tokens or change the route's existing 200/201 semantics.
- Require `Authorization: Bearer` on checkout and bind token booking ID to the route ID.
- Add `authorization` to CORS allowed headers while preserving the exact origin allow-list,
  methods, and credentials behavior.
- Add a chargeable-state manage-link exchange for a fresh checkout token.
- Wire `booking.js` and relevant E2E fixtures.
- Add a staging-only compatibility flag; production config rejects it.

**Tests first**

- Missing, malformed, expired, view-purpose, wrong-booking, wrong-secret, and modified tokens
  are rejected.
- Valid token starts exactly the existing persisted-amount checkout.
- First creation and idempotent retry both return usable tokens for the same booking.
- Token is absent from logs, analytics payloads, and customer-safe booking projection.
- CORS accepts the authorization header from existing allowed origins and still refuses
  unknown origins.
- Website desktop/mobile success and retry flows.
- With compatibility enabled during staging rollout, existing checkout behavior remains
  green; enforcement is enabled only after all callers send the capability.

**Checkpoint**

- Staging checkout succeeds with a token and returns 401 without it.
- Compatibility flag is off in the production configuration check.

**Done when:** every public checkout caller supplies a scoped capability and
`npm run test:all` is green.

## SH7 — Database money and state constraints

**Depends on:** SH3, SH5, SH6

**Goal:** Postgres rejects impossible financial state even if application validation fails.

**Build**

- Add named checks for booking money/currency/mode/status, payment
  amount/currency/provider/status/settlement evidence, and shared pricing/inventory.
- Add a read-only preflight command that reports every incompatible row without printing PII.
- Backfill legacy settlement timestamps with `settlement_source='legacy_backfill'`; never
  imply that `created_at` came from PayHere.
- Apply constraints using the design's safe validation sequence.
- Add the constraint names and forward-fix rollback commands to the runbook.

**Tests first**

- One rejection test per constraint plus valid boundary cases.
- Legacy nullable `amount_due_now` remains valid.
- `amount_due_now > total`, succeeded-without-settlement, negative inventory, and unsupported
  currency are rejected.
- Normal quote → booking → checkout → settlement and shared-seat smoke remain green.

**Checkpoint**

- Production/staging preflight reports zero invalid rows before migration approval.
- Migration applies on a production-shaped database snapshot.

**Done when:** all constraints are validated and the complete smoke suite is green.

## SH8 — Manual refund ledger and API

**Depends on:** SH2

**Goal:** refund requests are distinct from completed refunds and cannot exceed captured money.

**Build**

- Add the manual-compatible `refunds` table and repositories.
- Add request, confirm, cancel, and list routes under human `payments:act`.
- Stamp requester/confirmer identity.
- Confirm in one transaction with captured-minus-refunded validation.
- Send actual-amount refund email only after committed confirmation.
- Keep the existing endpoint/UI behavior available during this additive backend PR; SH9
  performs the atomic UI/endpoint cutover.

**Tests first**

- Founder/finance allowed; Ops/system/customer denied.
- Positive amount and matching currency required.
- Pending request does not change booking to refunded or send completion email.
- Confirmation requires unique PayHere reference.
- Duplicate, concurrent, and excessive refunds fail safely.
- Partial confirmation does not claim the whole booking was refunded.
- Fully satisfied refund plan transitions booking once and sends one email.

**Checkpoint**

- Against a sandbox-paid booking, record a manual pending refund, enter the dashboard
  reference, confirm it, and verify history plus customer email.

**Done when:** the ledger API is complete and tested without changing the current Ops UI or
removing its existing endpoint.

## SH9 — Refund Ops workflow and future-design reconciliation

**Depends on:** SH8

**Goal:** finance can execute the truthful manual workflow without direct database editing.

**Build**

- Replace the existing refund action with request and confirmation UI.
- Remove/disable the old direct status-flip endpoint in this same PR, after the new UI/API
  path is wired.
- Display captured, previously refunded, refundable remaining, pending amount, actor, and
  PayHere reference.
- Make pending/completed states visually distinct.
- Add confirmation copy warning staff to complete the PayHere dashboard action first.
- Update the deposits/balance/refunds design to reuse this ledger when automated refunds are
  later introduced.

**Tests first**

- Finance/founder UI capability matrix.
- Request → pending → confirm and pending → cancel flows.
- Double-submit/reload idempotency.
- Actual refunded amount appears in email and Ops history.
- Mobile and desktop Playwright; unrelated Ops workflows remain green.
- Before cutover, the existing refund characterization passes; after cutover, only the
  explicitly approved request/confirm/email deltas change.

**Checkpoint**

- Founder and finance complete the sandbox manual-refund rehearsal.
- Ops-role user can view only what existing capability policy permits and cannot act.

**Done when:** finance no longer needs Supabase edits to keep refund truth aligned.

## Final release gate

- [ ] SH1–SH9 merged with CI and independent review.
- [ ] `cd api && npm run check` green.
- [ ] `cd api && npm run smoke` green.
- [ ] `npm run test:all` green.
- [ ] Sandbox payment, replay, forced-settlement failure/retry, locked-price conversion,
  token refusal, and manual-refund rehearsal signed off.
- [ ] Production preflight reports zero invalid money/state rows.
- [ ] Go-live checklist documents required secrets, flags, monitoring, reconciliation, and
  rollback.
- [ ] Reviewed parity matrix confirms no pricing cents, PayHere checkout fields, valid-payment
  customer journey, shared inventory, view links, or unrelated Ops behavior drifted.
