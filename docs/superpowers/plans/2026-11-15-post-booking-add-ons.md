# Add-ons after booking, per leg, paid online — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. One task = one branch = one PR. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ops can add rate-card add-ons to a leg of a private booking after it is booked; the
customer pays for them online from the manage page; the original sale is never rewritten.

**Architecture:** Add-ons added after booking are their own records (`booking_add_on_requests`
with lines in `booking_add_ons`, each line tied to a `booking_legs.id`). One request is one
PayHere payment with `purpose = 'add_on'` and order id `REF-A<seq>`. Every rule about the
**trip's** money ignores `add_on` payment rows through one helper, `tripPayments`.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Vitest · Drizzle + Postgres · ops UI is
plain JS in `api/src/routes/ops-ui.html` · customer page `manage.html` · web-tests (vitest +
Playwright).

**Spec (the source of truth):** `docs/superpowers/specs/2026-11-14-post-booking-add-ons-design.md`.
Where this plan and the spec disagree, the spec wins; stop and report the disagreement.

**UX (approved by the owner 2026-11-14):** https://claude.ai/artifact/4AJdzKMkAUJN3qcS9BgirK —
screens 1, 2b, 2c, 3 (ops) and 4, 5, 6, 7 (customer and team). The copy quoted in Tasks 3–6 is
taken from those screens.

## Global Constraints

- Build ONLY what the task lists. No refactors, no renames, no "while I'm here" fixes. An
  adjacent problem goes in the PR description as a one-line note.
- Tests first: write the test, run it, see it FAIL for the right reason, then implement. Paste
  the red and the green runner summary lines into the PR body.
- Money = integer minor units + ISO currency (`USD`). IDs = uuid.
- Never write `bookings.total`, `subtotal`, `pricing_snapshot_json`, `amountDueNow` or
  `bookings.status` from any add-on code path.
- Never touch `api/src/quote/rateCard.ts`, `departureRepo.ts`, `config.ts`, env, or any
  `@generated:` block. Reading `liveRateCard` is allowed.
- No new dependency, no new env var, no new external service. Email and PayHere only through the
  existing adapters and their fakes.
- Private bookings only: `mode === 'single'`, or `mode === 'trip'` with
  `serviceType === 'private'`.
- Add-on codes: `EXTRA_CODES` from `quote/rateCard.ts`. Prices: `liveRateCard(...).extras[code]`.
  Labels: `EXTRA_LABELS` from `quote/extrasDeposit.ts`.
- Team email subject must NOT start with `Paid:` (a Gmail filter anchor).
- Gate before every commit, from the task's own worktree:
  - `cd api && DATABASE_URL_TEST=<the task's own throwaway DB> npm run check`
  - `npm --prefix web-tests run test:all` (vitest, then Playwright)
  - after editing any root asset (`manage.html`, `*.js`, `site.css`, `ticket.css`): `npm run stamp`
    at the repo root, and commit what it restamps.
- NEVER run `npm run migrate` (it targets `api/.env`'s `DATABASE_URL`, which is production). Only
  `npm run migrate:test` with `DATABASE_URL_TEST` set to a local throwaway database.
- Stage files by path. Never `git add -A`. Never rebase a pushed branch; use
  `gh pr update-branch`.
- Run every suite in the FOREGROUND with an explicit 600000 ms timeout.
- A new Postgres contract hookup uses `migratedDbPerDescribe()` in `postgres.test.ts`, never
  `createDb()` inside `make()` or an `it()`.

## Names fixed across tasks (do not rename)

```ts
// api/src/db/paymentRepo.ts
export type PaymentPurpose = 'full' | 'deposit' | 'balance' | 'add_on';

// api/src/domain/balance.ts  (Task 2)
export function tripPayments<T extends { purpose: string }>(rows: T[]): T[]; // drops purpose === 'add_on'

// api/src/domain/addOns.ts  (Task 1) — pure, no I/O
export type AddOnRequestStatus = 'open' | 'paid' | 'cancelled';
export type AddOnRequestState =
  | 'awaiting_payment' | 'expired' | 'cancelled_with_booking'
  | 'paid' | 'part_refunded' | 'refunded' | 'cancelled';
export type AddOnCreateError =
  | 'not_private' | 'booking_not_eligible' | 'awaiting_price' | 'legs_missing'
  | 'leg_not_found' | 'leg_not_driven' | 'leg_passed'
  | 'unknown_add_on' | 'duplicate_add_on' | 'already_bought_at_booking';
export function isPrivateBooking(b: { mode: string; serviceType?: string | null }): boolean;
export function bookingAddOnEligibility(b, legs: StoredLeg[]): AddOnCreateError | null;
export function legAddOnEligibility(leg: StoredLeg | undefined, today: string): AddOnCreateError | null;
export function isAddOnRequestPayable(req, booking, legs: StoredLeg[], today: string): boolean;
export function addOnRequestState(req, booking, legs: StoredLeg[], today: string, refundedCents: number): AddOnRequestState;
export function addOnOrderId(reference: string, seq: number): string;          // `${reference}-A${seq}`
export function addOnIdempotencyKey(bookingId: string, requestId: string): string; // `checkout:${bookingId}:addon:${requestId}`
export function addOnLineLabel(code: string, from: string, to: string): string; // `${EXTRA_LABELS[code]} — ${from} → ${to}`
export function addOnCatalogue(extras: Record<string, number>): Array<{ code: string; label: string; priceCents: number }>;

// api/src/db/addOnRepo.ts  (Task 1) — interface + InMemoryAddOnRepo; postgresAddOnRepo.ts
export interface StoredLeg { id: string; seq: number; kind: string; from: string; to: string; viaStops: string[]; travelDate: string | null }
export interface AddOnLine { id: string; requestId: string; bookingId: string; legId: string; code: string; label: string; amountCents: number }
export interface AddOnRequest {
  id: string; bookingId: string; seq: number; status: AddOnRequestStatus;
  totalCents: number; currency: string; rateCardVersion: string; paymentId: string | null;
  createdBy: string; createdAt: Date; paidAt: Date | null;
  cancelledBy: string | null; cancelledAt: Date | null; cancelReason: string | null;
  lines: AddOnLine[];
}
export class AddOnError extends Error {
  code: 'booking_not_found' | 'request_not_found' | 'duplicate_add_on' | 'already_paid' | 'not_open' | 'payment_in_flight';
}
export interface AddOnRepo {
  /** Stored, not-removed legs in seq order. */
  listLegs(bookingId: string): Promise<StoredLeg[]>;
  /** Assigns seq under the booking row lock and refuses a duplicate (same code on the same leg in
   *  a request that is `open`, or `paid` and not in `fullyRefundedPaymentIds`). */
  createRequest(input: {
    bookingId: string;
    lines: Array<{ legId: string; code: string; label: string; amountCents: number }>;
    currency: string; rateCardVersion: string; createdBy: string; now: Date;
    fullyRefundedPaymentIds: string[];
  }): Promise<AddOnRequest>;
  get(requestId: string): Promise<AddOnRequest | null>;
  listByBooking(bookingId: string): Promise<AddOnRequest[]>;            // seq order, with lines
  listByBookingIds(bookingIds: string[]): Promise<Map<string, AddOnRequest[]>>;
  /** Refuses `already_paid`, `not_open`, and `payment_in_flight` (its payment row is `pending`
   *  and `lastAttemptAt` is after `inFlightAfter`). */
  cancel(requestId: string, input: { by: string; reason: string; now: Date; inFlightAfter: Date }): Promise<AddOnRequest>;
  /** Sets payment_id once; a second call with the same id is a no-op. */
  attachPayment(requestId: string, paymentId: string): Promise<void>;
}

// api/src/db/paymentSettlementRepo.ts  (Task 4) — two new outcome kinds
| { kind: 'add_on_settled'; payment: Payment; booking: Booking; request: AddOnRequest }
| { kind: 'add_on_orphaned'; payment: Payment; booking: Booking; request: AddOnRequest | null }
```

JSON the ops API returns (Task 3) and the ops pane reads (Task 6):

```
legs:            [{ id, seq, kind, from, to, viaStops, travelDate }]
addOnCatalogue:  [{ code, label, priceCents }]            // only when a request can be created
addOnRequests:   [{ id, seq, name /* "A1" */, status, state, totalCents, currency, orderId,
                    payable, payLink /* string | null */, inFlightUntil /* ISO | null */,
                    refundedCents, createdBy, createdAt, paidAt,
                    cancelledBy, cancelledAt, cancelReason,
                    lines: [{ id, legId, code, label, amountCents }] }]
```

JSON the customer view returns (Task 5), cancelled requests left out:

```
addOnRequests: [{ id, state, totalCents, currency, payable, payBy /* YYYY-MM-DD | null */,
                  lines: [{ label, amountCents }] }]
```

## Verified facts this plan rests on (origin/main 8e00d258)

| Fact | Where |
|---|---|
| `PaymentPurpose = 'full' \| 'deposit' \| 'balance'` | `api/src/db/paymentRepo.ts:6` |
| `payments_purpose_valid` CHECK lists the same three | `api/src/db/schema.ts:176` |
| `customer_communications_kind_valid` list (16 kinds, as of 0077) | `api/src/db/schema.ts:681` |
| Latest migration is `0078_trip_request_through`, journal `idx` 78, `when` 1792540800000; no remote branch holds a 0079 | `api/drizzle/meta/_journal.json`, `git ls-tree` over `origin/*` on 2026-11-15 |
| New tables need `ENABLE ROW LEVEL SECURITY` or `rlsEnabled.test.ts` fails | `api/src/db/rlsEnabled.test.ts`, example `api/drizzle/0072_booking_schedule_events.sql:23` |
| Settlement outcomes and the shared helpers `isBalanceAfterDeposit`, `captureKindWithOthers` | `api/src/db/paymentSettlementRepo.ts` |
| `SECURED_STATUSES` = paid, confirmed, in_progress; `balanceDueCents`, `isBalanceOpen`, `paidCents` | `api/src/domain/balance.ts` |
| Repos are wired in `api/src/app.ts` (deps, in-memory defaults) and `api/src/server.ts` (Postgres) | `app.ts:78-230`, `server.ts:161-227` |
| Ops date-change route is the precedent for a CSRF + `bookings:operate` write | `api/src/routes/ops.ts:472` |
| `BookingRepo` exposes no read of stored legs | `api/src/db/bookingRepo.ts` (no `legs` method) |

---

### Task 1: Tables, migration, repos, rules

**Branch:** `feat/addons-1-schema-rules` · **Spec:** §4, §5

**Files:**
- Create: `api/drizzle/0079_booking_add_ons.sql`; journal entry `idx` 79, `when` 1792627200000
  (re-check at build time: next free number, and a `when` above every other branch's).
- Modify: `api/drizzle/meta/_journal.json`, `api/src/db/schema.ts`, `api/src/db/paymentRepo.ts`
  (the `PaymentPurpose` union only), `api/src/app.ts` and `api/src/server.ts` (wire `addOns`).
- Create: `api/src/domain/addOns.ts`, `api/src/domain/addOns.test.ts`,
  `api/src/db/addOnRepo.ts`, `api/src/db/postgresAddOnRepo.ts`, `api/src/db/addOnRepo.test.ts`
  (a shared contract run against the in-memory repo; hooked into `postgres.test.ts` for Postgres),
  `api/src/db/bookingAddOnsMigration.test.ts`.

**Migration content** (hand-written, additive, idempotent in the style of 0077; header comment
states purpose, release and rollback):
- `booking_add_on_requests` and `booking_add_ons` exactly as spec §5.1 and §5.2, with the FKs,
  `UNIQUE (booking_id, seq)`, `UNIQUE (payment_id)`, the status CHECK and both `> 0` CHECKs,
  an index on `booking_add_ons (booking_id)` and on `booking_add_ons (request_id)`.
- `ENABLE ROW LEVEL SECURITY` on both tables.
- `payments_purpose_valid` re-created with `'add_on'` added.
- `customer_communications_kind_valid` re-created with `'add_on_request'`, `'add_on_paid'` added,
  every existing kind kept verbatim.

**Tests (write first):**
- `bookingAddOnsMigration.test.ts`: both tables exist with the listed columns; the three CHECKs
  reject a bad status, a zero total and a zero line amount; `(booking_id, seq)` and `payment_id`
  are unique; a `payments` row with `purpose = 'add_on'` inserts; `customer_communications`
  accepts both new kinds and still accepts every old kind; the journal entry is looked up by tag.
- `addOns.test.ts`, one test per rule in spec §4.1, §4.4 and the helpers above. At minimum:
  private single / private trip accepted; shared and chauffeur → `not_private`; draft,
  payment_pending, completed, cancelled → `booking_not_eligible`; `needsPricing` →
  `awaiting_price`; no legs → `legs_missing`; unknown leg → `leg_not_found`; gap or day leg →
  `leg_not_driven`; yesterday → `leg_passed`; today and undated accepted; payable matrix (open ×
  booking status × leg date, including "completed booking, leg dated today" = payable and
  "completed booking, undated leg" = not payable); every `AddOnRequestState` value reachable,
  including `part_refunded` and `refunded` from `refundedCents`; order id, idempotency key and
  label formats; catalogue excludes `hotel-pickup` / `hotel-dropoff`.
- `addOnRepo.test.ts` contract (in-memory and Postgres): seq is 1 then 2 per booking and
  independent across bookings; `totalCents` is the sum of the lines; a duplicate code on the
  same leg is refused while the first is `open`, refused while it is `paid`, allowed once that
  payment id is in `fullyRefundedPaymentIds`, allowed after the first is `cancelled`; the same
  code on a different leg is allowed; two concurrent creates of the same line yield exactly one
  request (Postgres); `cancel` sets by / at / reason; `cancel` refuses `already_paid`,
  `not_open` (already cancelled) and `payment_in_flight`; `cancel` is allowed when the pending
  payment's `lastAttemptAt` is older than `inFlightAfter`; `attachPayment` is idempotent;
  `listLegs` returns stored legs in seq order without removed ones; `listByBookingIds` groups
  correctly and returns an empty array for a booking with none.

**Notes for the implementer:**
- `listLegs` reads `booking_legs`. Find how the in-memory `InMemoryBookingRepo` holds legs and
  follow it. If it holds none, STOP and report rather than inventing ids.
- `InMemoryAddOnRepo` takes the in-memory booking and payment repos in its constructor, as
  `InMemoryRefundRepo` does.
- Nothing calls the repo yet. This PR changes no behaviour.

- [ ] Write the three test files; run them; confirm they fail.
- [ ] Write the migration, schema, rules and repos until green.
- [ ] `npm run migrate:test` on the throwaway DB; full API gate; web gate.
- [ ] Commit; open the PR with the migration flagged in the first line of the body.

---

### Task 2: Trip money ignores add-on payments

**Branch:** `feat/addons-2-trip-money` · **Spec:** §6.1 · **Depends on:** Task 1 merged

**Files (modify):** `api/src/domain/balance.ts`, `api/src/db/paymentSettlementRepo.ts`,
`api/src/db/postgresPaymentSettlementRepo.ts`, `api/src/routes/admin.ts` (mark-paid's `settled`
guard only), `api/src/routes/bookings.ts` (`projectBooking`'s paid figure only),
`api/src/services/opsView.ts` (paid / balance only), `api/src/routes/quotePay.ts` (the `paid`,
`payment_due`, `pay_on_day`, `balance` state inputs only), `api/src/db/postgresBookingRepo.ts`
(`succeededPayment()`), its in-memory twin (`promoUseState`), `api/src/services/bookingTracking.ts`
(the `purpose !== 'balance'` filter), and the test files beside each.

**Deliberately NOT changed** (spec §6.1): `supersededPayLink.ts`, `duplicateBookings.ts`, the
re-book guard in `internalQuote.ts`, `postgresRefundRepo.ts`, `analytics/business.ts`, the
details-reminder `paidAt`. The PR body lists each with the reason from the spec.

**Tests (write first), each with an `add_on` payment row present:**
- `balance.test.ts`: `tripPayments` drops only `add_on`; a deposit booking with a succeeded
  add-on payment still owes `total − deposit`; `isBalanceOpen` unchanged by an add-on row; a
  pay-on-the-day booking with only an add-on payment still owes the full total.
- Settlement contract (in-memory and Postgres): deposit, then add-on row succeeded, then balance
  → `balance_settled` (red today: `double_capture`); a first trip payment on a `payment_pending`
  booking that already has a succeeded add-on row → `settled` (red today: `double_capture`).
- Mark paid: a pay-on-the-day `confirmed` booking with a succeeded add-on payment can still be
  marked paid in cash (red today: refused as already settled).
- Customer view and ops view: paid and balance figures exclude the add-on amount.
- Quote pay page: a deposit booking with a succeeded add-on row still renders the `balance`
  state with the full balance.
- Promo use: an add-on payment on an unpaid pay-on-the-day booking does not count as the use.
- Tracking check: a succeeded add-on payment on a `confirmed` booking is not a finding.
- One guard test proving the "deliberately not changed" readers still count add-on money where
  they should: the refund ceiling includes a succeeded add-on payment.

- [ ] Write the tests; run; confirm each new one fails for the stated reason.
- [ ] Add `tripPayments`; apply it at each listed place; green.
- [ ] Full gates; commit; PR.

---

### Task 3: Ops API and the request email

**Branch:** `feat/addons-3-ops-api` · **Spec:** §4, §7.1, §7.5 (first row) · **Depends on:** Task 1

**Files:**
- Create: `api/src/services/addOns.ts` (+ test): `createAddOnRequest`, `cancelAddOnRequest`,
  `addOnRequestViews` (the JSON above, computing `state`, `payable`, `payLink`,
  `inFlightUntil`, `refundedCents`). Routes stay thin.
- Modify: `api/src/routes/ops.ts` (GET detail additions; the two POST routes),
  `api/src/services/notifications.ts` (`sendAddOnRequest`), the customer-communication kind
  types, and the tests beside each.

**Behaviour:**
- `GET /admin/ops/bookings/:id` adds `legs`, `addOnRequests`, `addOnCatalogue` exactly as the
  JSON above. `addOnCatalogue` is present only when `bookingAddOnEligibility` returns null.
  The existing `payLink` field is unchanged.
- `POST /admin/ops/bookings/:id/add-ons` — CSRF, `bookings:operate`. Zod body
  `{ lines: [{ legId: uuid, code: string }] (1..24), notifyCustomer: boolean }`. Prices and
  labels come from the server, never the body. Returns `{ request, emailed }`.
- `already_bought_at_booking`: only on a booking with exactly one driven leg whose booking-time
  `addOns` include that code's label (spec §4.3).
- `POST /admin/ops/bookings/:id/add-ons/:requestId/cancel` — CSRF, `bookings:operate`. Body
  `{ reason: string (1..300) }`. `inFlightAfter = now − CHECKOUT_TOKEN_TTL_MS`.
- A request id that belongs to another booking is `request_not_found` (404).
- Error codes map to HTTP statuses the way the schedule route maps its own (404 for not found,
  409 for state conflicts, 400 for a bad body).
- `payLink` = `manageUrl(booking)` + `#add-ons`, only while `payable`.
- Email `add_on_request`: subject `An add-on for your trip: pay $X to confirm · REF`; body lists
  each line with its leg date and amount, the total, a "Pay $X online" button to the pay link,
  "Please pay by the end of <date>. If it isn't paid by then, the add-on simply isn't added and
  nothing is charged." and "Your trip itself is already paid and confirmed. This only covers the
  add-on." (for a pay-on-the-day booking the last sentence reads "This only covers the add-on.").
  Best-effort like `sendScheduleSet`; ledger key `${booking.id}:add_on_request:${request.id}`.
  When a leg has no date, the pay-by sentence is left out.

**Tests (write first):** one route test per error code in spec §7.1 (ten create errors, three
cancel errors); happy path single line and multi-leg multi-line (total is the sum, one request);
the price is the live card's, including a Rates-page revision; finance role gets 403 on both
POSTs and sees the requests on GET; ops role succeeds; missing CSRF refused; `notifyCustomer:
false` sends nothing and returns `emailed: false`; a throwing email adapter still saves and
returns `emailed: false`; GET returns `payLink` only while payable and `inFlightUntil` only
while in flight; the email snapshot contains every line and the pay link; two requests on one
booking produce two ledger rows.

- [ ] Tests red → implement → green; full gates; commit; PR.

---

### Task 4: Online payment

**Branch:** `feat/addons-4-payment` · **Spec:** §6.2, §6.3, §6.4, §7.3, §7.5 (rows 2–3), §7.8
**Depends on:** Tasks 1, 2, 3

**Files (modify):** `api/src/routes/bookings.ts` (checkout lane; checkout-token),
`api/src/db/paymentSettlementRepo.ts`, `api/src/db/postgresPaymentSettlementRepo.ts`,
`api/src/db/addOnRepo.ts` / `postgresAddOnRepo.ts` (settlement-only helpers),
`api/src/routes/webhooks.ts`, `api/src/services/notifications.ts`,
`api/src/services/opsNotifications.ts`, `api/src/domain/paymentCase.ts`,
`api/src/services/paymentCase.ts`, `api/src/services/analytics/ga4Hits.ts`, and tests.

**Behaviour:** exactly spec §6.2–§6.4. Points that are easy to get wrong:
- The add-on lane never moves the booking's status, never re-holds a promo, never sets
  `amountDueNow`.
- A request that is not payable returns `add_on_not_payable` (409); a succeeded row returns the
  lane's existing `already_paid` shape.
- Settlement: the `add_on` branch sits after the lock, amount check, event dedupe, failure
  handling and the same-order `double_capture` check, and BEFORE the `otherCaptures` /
  `payment_pending` logic, which it must not reach.
- `add_on_orphaned` still marks the payment `succeeded`.
- Webhook `failed` on an `add_on` payment: no customer email, no team rescue alert.
- Customer receipt kind `add_on_paid`, ledger key per request. Subject
  `Add-on confirmed: <first line label> · REF` (for several lines: `Add-ons confirmed · REF`).
- Team email subject `Add-on paid, tell the driver: REF`; body: customer name, each line with
  leg, date and pickup time when known, amount, order id, who requested it, a link to the
  booking in ops, and the sentence "Tell the driver for this leg. Nothing was sent to the driver
  automatically."
- `add_on_orphaned` raises a critical alert naming the order id and amount, saying to refund it.
- `normaliseCaseRef` strips `-A<digits>` as well as `-MANUAL`, `-D`, `-B`.
- GA4: `payment_type: 'add_on'`, `transaction_id` = the add-on order id.

**Tests (write first):** checkout lane — payable request creates one row with the right order
id, amount, purpose and idempotency key; a second call resumes the same row and bumps the
attempt count; expired, cancelled, booking-cancelled → `add_on_not_payable`; paid →
`already_paid`; a request id from another booking → 404; booking status unchanged after
checkout. Checkout token — issued for a payable request on a `paid` booking; refused for a
non-payable one; unchanged behaviour without `addOnRequestId`. Settlement contract (both repos)
— `add_on_settled` on paid / confirmed / in_progress / completed bookings; booking status and
`amountDueNow` unchanged; request `paid` with `paid_at`; duplicate notify → `duplicate`; second
capture on the same order → `double_capture`; cancelled request → `add_on_orphaned` with the
payment succeeded; cancelled booking → `add_on_orphaned`; failed → `failed` and the request
stays `open`; amount mismatch still throws; deposit → add-on → balance still `balance_settled`;
the settlement failure-hook rollback restores the request. Webhook — settled sends the receipt
and the team email once, calls `reportPayment`; orphaned raises the alert and sends no receipt;
failed sends nothing. Payment lookup — `CH-XXXXX-A1` resolves to the booking; the case view
shows the add-on payment in its own group and not as a double payment. GA4 hit shape.

- [ ] Tests red → implement → green; full gates; commit; PR.

---

### Task 5: Customer manage page

**Branch:** `feat/addons-5-manage-page` · **Spec:** §7.4 · **Depends on:** Task 4

**Files (modify):** `api/src/routes/bookings.ts` (`projectBooking` adds `addOnRequests`),
`manage.html`, any stamped references `npm run stamp` updates, `web-tests/unit/*` and
`web-tests/e2e/*` for the manage page.

**Behaviour (UX screens 4 and 5):**
- For each payable request, a card with `id="add-ons"` on the first, above the ticket:
  heading "An add-on to pay"; sub-line "Our team added this to your trip, as you asked. It's
  confirmed once it's paid."; one row per line (label left, amount right); "To pay now" total;
  a full-width button "Pay $X"; under it "Pay by the end of <Tue 18 Nov>. Card payment through
  PayHere." (the first sentence is left out when `payBy` is null).
- Pay requests a checkout token with `{ addOnRequestId }`, then starts checkout with
  `{ purpose: 'add_on', addOnRequestId }` through the page's existing PayHere handoff.
- On return from a successful add-on payment: a green "Add-on paid" card naming the add-on(s);
  no "An add-on to pay" card for that request.
- A paid request: its amount is shown on its own line "Add-ons · paid $X" under the trip total.
  The trip's Total and Paid figures do not change.
- An expired request: one muted line "<label> wasn't added." No button.
- The browser `purchase` event does not fire on an add-on return.
- Reuse the page's existing card, button and ticket styles. No new colours or fonts.

**Tests (write first):** unit — `projectBooking` shape, cancelled left out, `payBy` is the
earliest dated leg in the request; e2e at 375, 768 and 1280 — card renders with lines and
total; Pay calls the token route then checkout with the add-on body; two payable requests give
two cards and two buttons; paid state; expired state; no add-on requests leaves the page
byte-for-byte as before in the ticket area; no horizontal overflow at 375; `purchase` not
pushed to `dataLayer` on an add-on return.

- [ ] Tests red → implement → `npm run stamp` → green; full gates; commit; PR.

---

### Task 6: Ops booking pane

**Branch:** `feat/addons-6-ops-pane` · **Spec:** §7.2, §6.5 (pane), §7.2 "Elsewhere"
**Depends on:** Task 3 (Task 4 for the paid / refund states)

**Files (modify):** `api/src/routes/ops-ui.html`, `web-tests/e2e/ops-*.spec.js` (new spec file
`ops-booking-add-ons.spec.js`), and any existing ops-pane spec the new section legitimately moves.

**Behaviour (UX screens 1, 2b, 2c, 3):**
- In the itinerary block (`data-testid="sheet-itinerary"`), under the legs, an "Add-ons"
  sub-section: booking-time add-ons each tagged "Booked with the trip"; then one card per
  request with its lines, total, state pill and meta line.
- State pill text: Awaiting payment, Paying now, Paid, Expired, Cancelled, Cancelled with
  booking, Part refunded, Refunded.
- Awaiting payment card: "Request A1 · sent <when> · <by>", "Customer can pay until the end of
  <date>." (left out when undated), buttons "Copy pay link" and "Cancel request".
- Paying now: Cancel disabled, with "Can be cancelled after <HH:MM> if they don't pay."
- Paid: "Tell the driver about this add-on."
- "+ Add-on" (only when `addOnCatalogue` is present and the user has `bookings:operate`) opens
  the tick-box form of spec §7.2. Submit posts `{ lines, notifyCustomer }`.
- After sending: toast "Request sent. Customer emailed the pay link." or, when `emailed` is
  false, "Saved, but the customer was NOT emailed. WhatsApp them the pay link."
- Cancel asks for a reason (required) and posts it; API error codes show as plain sentences.
- Payment fold: an add-on payment row is labelled "Add-on A1". Refund panel target label
  "Add-on A1 — $10". History (`buildActivity`): request sent / paid / cancelled entries.
- After a full trip refund with a paid add-on not refunded, the pane says the add-on payment
  still needs refunding (spec §6.5).
- The pane's own `legRows` is NOT changed. Follow `ops-ui.html`'s existing idioms (`_openSeq`,
  no inline handlers in side-panel renders, dialogs above the rail).

**Tests (write first, Playwright against the stubbed API):** section renders booking-time and
request lines; "+ Add-on" hidden for finance, for a shared booking, and when the catalogue is
absent; the form lists only the legs the API returned, ticks under two legs post one request
with two lines and the right total on the button; an already-added add-on is disabled; Send is
disabled with nothing ticked; both toasts; Copy pay link writes the request's `payLink`; Cancel
requires a reason and posts it; `payment_in_flight` shows its sentence; every state pill; the
refund target and payment fold labels; history entries; no layout overflow at 780 px pane width.

- [ ] Tests red → implement → green; full gates; commit; PR.

---

### Task 7: The one add-ons list

**Branch:** `feat/addons-7-addons-list` · **Spec:** §7.6 · **Depends on:** Task 4

**Files (modify):** `api/src/db/postgresBookingRepo.ts` (`assembleMany`), the in-memory twin in
`api/src/db/bookingRepo.ts`, and tests.

**Behaviour:** `booking.addOns` gains the labels of post-booking lines whose request is `paid`
and whose payment is not fully refunded, after the booking-time ones. Open, expired and
cancelled requests add nothing. One extra query per `assembleMany` call (not per booking).

**Tests (write first):** contract for both repos — paid line appears; open / cancelled do not;
fully refunded does not; part refunded does; a list read of 20 bookings issues a constant number
of queries (extend the existing query-count guard if one covers `assembleMany`); one email
snapshot (trip reminder) shows the paid add-on in its Extras row.

- [ ] Tests red → implement → green; full gates; commit; PR.

---

## After the last merge

- Confirm `https://ops.staging.ceylonhop.com/health` reports the last merge's commit.
- Smoke on staging: `GET /admin/ops/bookings/:id` for a private paid booking returns `legs` and
  `addOnCatalogue`.
- Nothing is promoted to `production`.

## Self-review against the spec

| Spec section | Task |
|---|---|
| §4.1–4.5 rules | 1 (pure rules, repo guards), 3 (route errors) |
| §5 data model | 1 |
| §6.1 trip money | 2 |
| §6.2 checkout, token | 4 |
| §6.3 settlement | 4 |
| §6.4 webhook replies | 4 |
| §6.5 refunds | 2 (ceiling guard test), 6 (labels, "still needs refunding") |
| §7.1 ops API | 3 |
| §7.2 ops pane | 6 |
| §7.3 payment lookup | 4 |
| §7.4 manage page | 5 |
| §7.5 emails | 3 (request), 4 (receipt, team) |
| §7.6 add-ons list | 7 |
| §7.7 quote pay page | 2 (keeps stating the trip's amount) |
| §7.8 analytics | 4 (GA4) |
| §9 edge cases | each row has a named test in Tasks 1–6 |
