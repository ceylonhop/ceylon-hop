# Booking transitions and customer communications tracking — Phase A plan

**Goal:** durable, correlated forensic history for booking state changes and booking customer
emails, without changing live send behaviour.

**Design:**
[`2026-09-26-booking-communications-tracking-design.md`](../specs/2026-09-26-booking-communications-tracking-design.md)

Each task below is one branch and one PR. Every behavioural task starts with a failing test and
ends with `cd api && npm run check` plus the standing smoke test. Schema changes are additive and
forward-only.

## Global constraints

- `notification_log` remains the only existing send/dedupe authority throughout Phase A.
- No recipient, content, eligibility, scheduling or retry changes.
- No new queue, outbox, worker, external service or dependency.
- No Ride Board, quote-only, staff/team or WhatsApp communication tracking.
- No synthetic historical transition or delivery events.
- No raw bodies, tokens, card data or unfiltered provider payloads.
- Payment/refund settlement transactions remain atomic and never depend on email delivery.

## Step 23.1 — Freeze contract and execution plan

**Build:**

- Add the approved design and this implementation plan.
- Add `domain/trackingContract.ts` with the frozen Phase A vocabulary and provenance context types.
- Update the canonical build plan and mark the older notification-safety design's implementation
  status accurately.

**Tests:** exact vocabulary tests. This makes an accidental rename/addition a deliberate contract
change rather than an unreviewed schema/API drift.

**Checkpoint:** no production path imports the new module; the focused test and full API check pass.

## Step 23.2 — Request and job correlation

**Build:**

- Add server-generated request IDs and `X-Request-Id` responses.
- Add a small explicit request/job correlation type and create one run ID per scheduler/watchdog
  invocation.
- Pass context only as far as the later tracking seams require; do not persist it yet.

**Tests:** malformed/caller-supplied IDs cannot replace the server ID; one request keeps one ID;
one job run keeps one run ID; separate invocations differ; existing responses are unchanged apart
from the new header.

**Checkpoint:** a local booking request and notification dry run expose different valid IDs.

## Step 23.3 — Booking transition ledger and atomic writer

**Build:**

- Add `booking_status_events` migration/schema/repositories.
- Add `BOOKING_TRANSITION_TRACKING_ENABLED`, default off, so the additive migration can deploy
  before the invariant is enabled.
- Expand the transition context from Step 23.1 into the booking repository contract.
- Make the normal in-memory and Postgres `setStatus` paths write only applied transitions.
- Status compare-and-set and event insert share one Postgres transaction.
- Expose read/reconciliation methods, but no Ops UI.

**Tests:** legal transition writes one event; illegal and concurrent losing transitions write none;
injected failure rolls back both writes; order is stable; no backfill is created for legacy rows.

**Checkpoint:** transition a disposable booking and verify one matching event row.

## Step 23.4 — Cover every booking status writer

**Build:** migrate direct writers to the Step 23.3 transaction-aware seam:

- payment settlement;
- refund confirmation;
- website checkout;
- quote/pay-link conversion;
- manual mark-paid;
- Ops fulfilment mirror and cancellation/no-show actions;
- scheduled cancellation/cleanup paths.

Add an architectural test that fails on a direct `bookings.status` update outside the approved
writer/migration list.

**Tests:** one focused test per path, including injected rollback for payment/refund transactions;
no double event on duplicate webhook/retry; existing smoke test stays green.

**Checkpoint:** controlled checkout → paid → confirmed → cancelled/refunded history is complete and
ordered.

## Step 23.5 — Communication ledger and observing adapter

**Build:**

- Add `customer_communications` and `customer_communication_events` schema/repositories.
- Add `CUSTOMER_COMMUNICATION_TRACKING_ENABLED`, default off, independently from transition
  tracking.
- Extend `EmailMessage` with required tracking metadata for in-scope booking emails.
- Change the real adapter result to return provider acceptance and provider message ID; fake
  adapters return deterministic IDs.
- Add one observing wrapper/choke point that records planned/suppressed/attempted/accepted/failed.
- Keep `notification_log` as the send authority; the new tables never trigger a send.

**Tests:** all eleven in-scope kinds carry valid metadata; missing address, kill switch and
allowlist record suppression; provider 4xx/5xx/timeout records failure; accepted records provider
  ID; no duplicate send is introduced; no token or raw body fields are persisted (the one-way hash
  may cover the exact outbound representation).

**Checkpoint:** send controlled fake confirmations and failures; compare email count before/after
and verify it is identical while the event ledger differs.

## Step 23.6 — Signed Resend delivery events

**Build:**

- Extend the existing signed Resend webhook for sent/delivered/delayed/failed/bounced/complained.
- Correlate on stored provider message ID.
- Deduplicate provider deliveries and store unknown-message events for reconciliation.
- Keep existing bounce/complaint alerts; add explicit failed alerting, not missing-delivery timers.

**Tests:** valid signature; invalid/stale signature; duplicate and out-of-order events; unknown
message ID; sanitized metadata; each provider event mapping.

**Checkpoint:** controlled Resend test email shows acceptance and signed delivery/bounce evidence.

## Step 23.7 — Reconciliation and read-only Ops timeline

**Build:**

- Add reconciliation queries from design §9 and watchdog alerts for explicit failures/invariants.
- Add a paginated, capability-gated booking tracking endpoint.
- Merge booking transition and communication events into the existing booking activity view.
- Display `history_available_since` and unavailable sources explicitly.

**Tests:** RBAC; pagination; ordering at equal timestamps; partial/legacy history; source failure;
masked PII; each reconciliation finding; no actions or resend capability.

**Checkpoint:** exercise successful, suppressed, failed, bounced, cancellation and refund scenarios
and diagnose each using only the Ops booking timeline.

## Phase A release gate

- Run the full API check, smoke test and relevant Ops browser tests.
- Run controlled scenarios for all acceptance criteria in the design.
- Deploy schema with reads/writes disabled, then enable transition writes, communication observation,
  provider webhooks and Ops reads in that order.
- Promotion depends on scenario coverage and a minimum observed sample, not elapsed time alone.
- Rollback disables new writes/reads; additive tables stay in place. It never rolls back booking or
  payment state.
