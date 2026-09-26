# Booking transitions and customer communications — durable tracking

**Date:** 2026-09-26 · **Status:** approved by the owner in chat · **Rollout:** Phase A tracks
existing behaviour; Phase B may change delivery reliability later · **Read from:** `origin/main`
at `63e738c1`.

## 1. Problem

Payment processing now has enough evidence to answer where a checkout stopped. The rest of a
booking does not. Most status changes overwrite `bookings.status`, and `notification_log` records
only the first attempted send for a subset of email kinds. It cannot reliably answer:

- what moved a booking from one status to another, who did it, and which request or job caused it;
- whether an email was planned, suppressed, rejected by Resend, accepted by Resend, delivered,
  delayed, bounced, or reported as spam;
- whether an email failure happened before or after a payment or booking transition;
- whether missing history means nothing happened or the system did not record it.

The current Ops activity list reconstructs a story from current booking, payment, refund and note
rows. That is useful, but it is not durable history.

## 2. Owner decisions

1. Build end-to-end tracking for **booking state transitions** and **booking-related customer
   emails**.
2. Phase A must not change recipients, email content, eligibility, retry policy or deduplication.
   `notification_log` remains the sole authority for sends it currently governs.
3. Track facts in append-only ledgers. Do not manufacture historical transitions.
4. Provider acceptance and delivery are different facts. A successful Resend API response is
   `provider_accepted`; only a signed provider webhook may record `delivered`.
5. Payment settlement must never wait for a provider delivery webhook. Email/tracking failure must
   not undo captured money.
6. Initial scope requires a real `booking_id`. Ride Board, quote-only emails, team emails and
   manually sent WhatsApp are separate later slices.
7. Phase B's outbox/retry design is not part of Phase A.

## 3. Scope

### 3.1 In Phase A

- Correlation IDs for HTTP requests and scheduled runs.
- Immutable, applied booking transition events for every status-writing path.
- Communication and communication-event ledgers for the existing booking customer emails.
- Resend provider ID capture and signed delivery-event persistence.
- Reconciliation checks and a read-only Ops timeline.
- Clear history-availability metadata for rows created before tracking began.

### 3.2 Excluded

- Any new send, retry, queue, outbox, resend button or change to notification eligibility.
- Ride Board, ops/team notifications, customer quotes and automated or manually logged WhatsApp.
- Email-open and link-click tracking.
- Raw card data, PayHere payloads, full email HTML/text, manage tokens or pay-link tokens.
- Backfilled events that claim an unobserved historical transition or delivery.

## 4. Frozen vocabulary

The executable copy lives in `api/src/domain/trackingContract.ts`.

### 4.1 Booking email kinds

`confirmation`, `details_needed`, `booking_confirmed`, `cancellation`, `refund`,
`no_show_notice`, `trip_reminder`, `review_request`, `payment_recovery`, `payment_failed`, and
`deposit_received`.

`payment_recovery` is the durable name for the current `sendPaymentIncomplete` path.

### 4.2 Communication events

- Application decision: `planned`, `suppressed`.
- Application attempt: `send_attempted`, `send_failed`.
- Provider response: `provider_accepted`.
- Signed provider webhook: `provider_sent`, `delivered`, `delayed`, `provider_failed`, `bounced`,
  `complained`.

Events may arrive more than once or out of order. The ledger preserves provider facts; it does not
rewrite history into a single imagined sequence.

### 4.3 Booking transition provenance

- Sources: `website`, `ops`, `payment_webhook`, `quote_conversion`, `refund`, `scheduled_job`,
  `migration`, `system`.
- Actor types: `customer`, `staff`, `provider`, `scheduler`, `migration`, `system`.
- Related entities: `payment`, `refund`, `quote`, `fulfilment`.

`actor_id`, `reason`, `request_id`, `run_id`, and related-entity fields are nullable only when the
fact genuinely has no value or predates the caller's correlation support. New call sites must pass
all available provenance.

## 5. Data model

### 5.1 `booking_status_events`

Append-only applied facts:

```text
id uuid primary key
booking_id uuid not null references bookings(id)
from_status text not null
to_status text not null
source text not null
actor_type text not null
actor_id text null
reason text null
request_id uuid null
run_id uuid null
related_entity_type text null
related_entity_id text null
occurred_at timestamptz not null
```

The booking update and its event insert share one database transaction. Only a successful compare-
and-set writes an event. Rejected, illegal and no-op attempts go to structured operational logging,
not the business ledger.

There is no fake baseline row. Reads return `history_available_since`, and the Ops UI states that
earlier history was not recorded.

### 5.2 `customer_communications`

One logical booking email:

```text
id uuid primary key
booking_id uuid not null references bookings(id)
kind text not null
channel text not null check channel = 'email'
template_key text not null
template_version text not null
recipient text not null
source text not null
actor_type text not null
actor_id text null
request_id uuid null
run_id uuid null
tracking_key text not null unique
payload_sha256 text not null
provider text null
provider_message_id text null
created_at timestamptz not null
updated_at timestamptz not null
```

The ledger stores no full email body and no customer-action token. `tracking_key` identifies an
observed logical send but does not authorize delivery during Phase A.

### 5.3 `customer_communication_events`

Append-only facts for one logical email:

```text
id uuid primary key
communication_id uuid null references customer_communications(id)
event_type text not null
provider_event_id text null
provider_message_id text null
reason_code text null
detail_json jsonb null
occurred_at timestamptz not null
recorded_at timestamptz not null
```

Provider events are idempotent on provider event ID. When Resend supplies no reusable event ID,
the repository uses a documented provider-message/type/timestamp fingerprint. Unknown provider
message IDs are stored with a null `communication_id` as orphan webhook evidence for
reconciliation; they are not silently dropped. A database check requires at least one of
`communication_id` or `provider_message_id`.

`detail_json` is an allowlisted diagnostic projection. It must not contain message bodies,
authorization headers or customer-action URLs.

## 6. Transaction and failure semantics

### 6.1 Booking transitions

The status row and transition event form one invariant. If either write fails, the whole
transition fails. Postgres payment settlement and refund confirmation must write their event inside
the same transaction that writes payment/refund and booking state.

In-memory repositories implement the same contract so unit and smoke tests do not hide a
production-only path.

### 6.2 Communications

Phase A observes existing sends:

```text
existing eligibility/dedupe decision
  -> communication planned or suppressed
  -> send attempted
  -> provider accepted or send failed
  -> signed provider webhook events
```

Tracking must not introduce a second send authority. A database tracking failure is reported and
reconciled, but may not roll back a captured payment. Existing synchronous payment-webhook email
calls are not made more synchronous by this work.

The adapter's current `{ delivered: true }` means only that the send path returned successfully.
During migration it is mapped to `provider_accepted`, never `delivered`.

## 7. Correlation

- Every API request receives a server-generated UUID request ID. A syntactically valid incoming
  ID may be retained only as a separate parent/caller value; callers cannot choose the system's
  primary ID.
- The response carries `X-Request-Id`.
- Every scheduled invocation receives one UUID run ID, reused for every decision in that run.
- Request/run context is passed explicitly through service inputs. No global mutable context.
- Provider callbacks carry their own provider event/message IDs and may also link to the original
  communication through the stored provider message ID.

## 8. Privacy, access and retention

- The tracking API is read-only and requires the existing booking-read capability; raw diagnostic
  metadata requires the stricter payments/incident capability.
- Recipient addresses are PII. List views mask them; booking detail may show the address already
  visible to that role.
- No email bodies, access tokens, checkout capabilities, payment card data or unfiltered provider
  payloads are stored.
- Customer deletion/anonymisation must cover the new recipient and diagnostic fields. Exact
  retention duration remains a deployment policy; until agreed, these tables follow the booking's
  retention and deletion lifecycle.

## 9. Reconciliation and alerts

Phase A adds queries for:

- current booking status differs from the latest applied transition;
- send attempt without provider acceptance or failure after the adapter timeout window;
- provider webhook with no matching communication;
- explicit provider `failed`, `bounced` or `complained` events;
- captured payment whose booking transition event is missing.

Do not alert merely because `delivered` has not appeared. First measure real webhook latency and
coverage.

## 10. Acceptance criteria

1. Every booking status-writing path commits exactly one matching applied event, atomically.
2. Illegal/no-op transitions commit neither status nor event.
3. Existing booking status, notification eligibility, recipients, content, dedupe and retry
   behaviour are unchanged.
4. Every in-scope email records the decision and attempt outcome, including allowlist/kill-switch
   suppression and missing addresses.
5. Resend acceptance records its provider message ID; duplicate/out-of-order signed webhooks are
   harmless and queryable.
6. Payment settlement succeeds even if customer email delivery fails; the failure is visible and
   recoverable through reconciliation.
7. Legacy bookings are labelled as partial history, never presented as having no activity.
8. One read API can return booking transitions and communication events in chronological order,
   with unavailable sources named rather than silently empty.

## 11. Phase B boundary

Only after Phase A data proves the current system should a separate design choose an outbox,
projector recovery, retry ownership, provider idempotency beyond its retention window, and immutable
payload/version policy. None of those behaviours is implied by the Phase A tables.
