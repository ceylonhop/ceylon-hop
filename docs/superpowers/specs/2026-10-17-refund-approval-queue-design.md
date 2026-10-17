# Refund requests with founder approval — partial refunds in the ops tool (design)

**Date:** 2026-10-17 · **Owner decision:** go (conversation of the same day)
**Scope:** one PR — `api/src/routes/admin.ts`, `api/src/routes/ops.ts`, `api/src/services/opsView.ts`,
`api/src/db/refundRepo.ts` + `postgresRefundRepo.ts`, `api/src/routes/ops-ui.html`, and their tests.
**No migration, no pricing change, no config change.**

## Why

Ceylon Hop's PayHere plan now allows partial refunds (owner, 2026-10-17). Customers change plans,
drop a leg, find a cheaper option for part of a trip, downgrade a vehicle, skip an extra, or have a
bad experience the team wants to make good. Today the ops tool can only refund the full remaining
balance, and only a founder can do it.

The owner's rule, in one line: **anyone on the ops team can request any refund; only a founder
approves it.** One rule replaces a list of "which refunds may which role do", and it is the same
maker-checker shape the quote workflow already uses (ops builds, founder marks ready).

## What exists today (read on `origin/main` @ `1f5111be`)

- **A refund already has a "requested" step.** `request()` writes a `manual_pending` row that
  reserves the money (`RESERVING_STATUSES`, `api/src/db/refundRepo.ts`), so two requests can never
  add up to more than was captured. A second action sends it (`execute`) or records a manual
  refund (`confirm`).
- **The server already accepts any amount** up to what is left (`refund_exceeds_captured`,
  `refund_exceeds_payment`), and the PayHere adapter sends `amount` whenever the refund is not the
  whole payment (`postgresRefundRepo.ts:265`, `adapters/payhere.ts:388`).
- **The ops screen allows full refunds only.** `refundrequest` always posts the full remainder,
  with a comment that our PayHere setup could not do partials (`ops-ui.html:4003`, `:4787`).
- **The ops role cannot see the Refunds block at all.** `refundHtmlFor` and the refund-history
  fetch both require `payments:act` (`ops-ui.html:3960`, `:4314`), which only founder and finance
  hold (`lib/opsAuth.ts:32-34`). Finance sees the ledger read-only.
- **Server gap:** the request, confirm, execute and cancel routes check only `bookings:operate`
  plus the 24-hour rule (`admin.ts:234`, `:317`, `:348`, `:435`). Whenever the 24-hour rule lets
  them through, someone on the ops role calling the API directly could send a refund of any amount
  today, with no founder involved. This design closes it.

## The rule

| Action | Founder | Ops | Finance |
|---|---|---|---|
| Read a booking's refund ledger | yes | **yes (new)** | yes |
| Request a refund (any amount ≤ remaining, reason required) | yes | yes | no |
| Approve: send through PayHere (`execute`) | yes | **no (new)** | no |
| Approve: record a manual refund (`confirm`) | yes | **no (new)** | no |
| Cancel a pending request | yes | yes | no |

- **No 24-hour rule on refunds.** A request moves no money and a founder decides every one, so the
  window only blocked the urgent last-minute cases. Requests filed inside the last day are
  **flagged "Late"** instead (§3). **Cancelling a booking keeps the 24-hour rule unchanged** —
  cancellation has no approval step, so the rule still protects it.
- **A founder still refunds in one press**, as today: their request is written and fired at once.
- Finance is unchanged: it records money and reads the ledger, never requests or approves.

## Not in scope (deliberately)

- **A leg picker.** Phase 2, its own small change: tick legs/extras and the amount fills in from
  the booking's frozen line prices (reuse `payLines()` in `api/src/quote/paySelection.ts`). Because
  a founder checks every request, it needs no server rules of its own.
- **A decline note / who cancelled.** `refunds` has no `cancelled_by` column; adding one is a
  migration. A founder who declines tells the requester directly; the ledger shows "Cancelled".
- **Marking a refunded leg as not running.** Refunding a leg does not take it off the plan — ops
  still has to, exactly as today.
- Refund fees or a cancellation policy, anything customer-facing, any change to the
  cancel-booking rule, finance requesting refunds.

## Design

### 1. Server permissions (`api/src/routes/admin.ts`)

| Route | Today | After |
|---|---|---|
| `GET /bookings/:id/refunds` | `payments:act` | `bookings:read` (founder, finance, ops — not the machine key) |
| `POST /bookings/:id/refunds` | `bookings:operate` + `reversalGate` | `bookings:operate`, **no** `reversalGate` |
| `POST …/:refundId/execute` | `bookings:operate` + `reversalGate` | `payments:reverse` |
| `POST …/:refundId/confirm` | `bookings:operate` + `reversalGate` | `payments:reverse` |
| `POST …/:refundId/cancel` | `bookings:operate` + `reversalGate` | `bookings:operate`, **no** `reversalGate` |

`reversalGate` stays on `POST /bookings/:id/cancel`. `payments:reverse` is founder-only already, so
no capability or role changes. The file-header comment ("cancel/refund require payments:act") is
corrected to describe the new rule.

### 2. Founders hear about a request

When `POST /bookings/:id/refunds` succeeds **and the requester lacks `payments:reverse`**, send one
alert through the existing `alerts` adapter (best-effort; a failed alert never fails the request):

- `severity: 'info'`, `kind: 'refund_requested'`, `dedupeKey: <refund id>` (each request is its own
  email; the cooldown cannot swallow a second request on the same booking).
- Title: `Refund requested: <reference> · <amount>` plus ` · LATE` when §3 says so.
- Body: amount and currency, who asked, their reason, the late note when it applies, and
  `bookingDeepLink(booking.id, opsBaseUrl)` (`services/opsNotifications.ts:235`).

A founder's own request sends nothing — they are about to fire it.

### 3. The "Late" flag

A request is **late** when it was filed less than 24 hours before the trip starts, or after it
started. "Trip start" is exactly `tripStartAt()` in `domain/reversalWindow.ts` (earliest date,
00:00 Sri Lanka time when there is no time). A booking with no trip date is never late. Display
only — it changes no permission.

- Server: computed for the alert (§2) from `tripStartAt(booking)` and the refund's `requestedAt`.
- Ops UI: computed per pending row from the existing `tripStartMs(t)` and `r.requestedAt`; shown as
  a tag **"Late — trip starts in under 24h"** on the pending row.

### 4. The founder's waiting list (bookings queue)

- `OpsBookingRow` gains `refundWaitingCents: number` — the sum of the booking's `manual_pending`
  refunds, `0` when none. Filled in `GET /ops/bookings` from **one batched query** (new repo method
  `pendingCentsByBookingIds(ids): Promise<Map<string, number>>`, InMemory + Postgres), next to the
  existing batched payments read — never one query per row (`ops.ts:244` comment, N+1 history).
- Ops UI, **founders only** (`payments:reverse`):
  - A queue chip **"Refunds waiting"** listing every row with `refundWaitingCents > 0`, **including
    cancelled and other closed bookings** — cancel-then-refund is the common case, and closed rows
    are otherwise hidden from "All open".
  - `reason(t)` returns **"Refund waiting for your approval"** for such a row, checked *before*
    the closed-stage early return, so it shows as the row's attention reason.
  - The nav attention badge counts these rows too (once, not twice).
- Ops agents see no chip; their own pending requests show on the booking sheet (§5).

### 5. The booking sheet's Refunds block (`ops-ui.html`)

- **Who sees it:** anyone with `bookings:read` (founder, finance, ops). The refund-history fetch
  in the sheet loader uses the same gate.
- **Request form** (founder and ops; never on ride-board rows), above the ledger as today:
  - **Amount** field, optional. Empty means "the full remaining amount" of the target payment;
    placeholder shows that figure. Parsed from the typed decimal string to integer cents with no
    floating point (`"12"`, `"12.5"`, `"12.50"` ok; more than 2 decimals, `0`, negative, or more
    than the target's remaining → an error toast and nothing is posted).
  - **Reason**, required (unchanged).
  - One button, or one per captured payment on a deposit booking (unchanged); the amount applies
    to the payment whose button was pressed.
  - Founder: button **"Refund"**; the confirm says `Refund <amount> now? This sends the money back
    through PayHere immediately. There is no undo.` then request + fire, as today.
  - Ops: button **"Request refund"**; the confirm says `Request a refund of <amount>? A founder has
    to approve it before any money moves.` On success the toast says `Refund requested — waiting
    for a founder`.
  - **No 24-hour block** on this form for anyone. The cancel-booking block keeps `reverseGate()`
    exactly as it is.
- **Pending rows:**
  - Founder: unchanged actions (Refund through PayHere now / record manual refund / Cancel
    request), plus the Late tag.
  - Ops: the text **"Waiting for a founder to approve"**, a **Cancel request** button, and the Late
    tag. No send or confirm controls.
  - Finance: read-only, unchanged.
- The stale "our PayHere setup cannot do partial refunds" comments are rewritten.

### 6. What stays the same

- Customer refund email already states the actual amount (`services/notifications.ts:694-701`).
- Team "Refunded:" email already says partial vs full (`opsNotifications.ts:520`).
- Booking status flips to `refunded` only when the whole captured amount is back
  (`bookingFullyRefunded`); a partial refund leaves it as it was. Won-quote release and shared-seat
  release follow the same "fully refunded" condition, unchanged (`admin.ts:263-270`).
- GA4 refund reporting, the stuck-refund watchdog, and the "outcome unknown — do not retry" path
  are untouched.

## Risks and checks

- **PayHere and repeat partials — unverified.** Their Refund API page sits behind a bot check, so
  this session could not confirm that several partial refunds may be issued against one payment,
  or any time limit. **Release check (owner):** before promoting to production, refund a small
  part of a real PayHere payment, then a second part, and confirm both in the PayHere dashboard.
  If PayHere refuses the second, the request still fails safely: a definite decline settles as
  `api_failed` and frees the money (existing `settleApi` behaviour).
- **Founder becomes the bottleneck.** Mitigated by the alert (§2) and the queue chip (§4); nothing
  more is built.
- **`ops-ui.html` is the hot file** shared by many sessions — merge this PR promptly after review.

## Testing

- **API (vitest, `api/src/routes/refunds.test.ts`, `admin.test.ts`):** the permission table in §1
  row by row for founder / ops / finance / machine key / anonymous; ops may request inside 24h and
  with no trip date; ops gets 403 on execute and confirm; ops may cancel a request; the
  `refund_requested` alert fires for ops (with LATE when late) and not for a founder; a partial
  amount is passed to the gateway. `admin.test.ts:282` ("the ops time window applies to refunds
  too") is rewritten to assert the window no longer applies to refund requests but still applies to
  cancel.
- **Repo:** `pendingCentsByBookingIds` for InMemory and Postgres (sums only `manual_pending`,
  missing ids absent).
- **Ops row:** `refundWaitingCents` present and correct on `GET /ops/bookings`.
- **Web (web-tests):** amount parsing unit test; e2e for ops requesting a partial refund, seeing
  "Waiting for a founder", the Late tag, and the founder's "Refunds waiting" chip including a
  cancelled booking. Existing e2e that pin the old rule are updated:
  `ops-refund-workflow.spec.js:258` (ops now reads the ledger) and `:352` (ops may now request
  inside 24h, flagged Late); `ops-cancel-refund.spec.js:104-126` keep asserting the 24-hour rule
  for **Cancel** only.
- Gate: `cd api && npm run check` and `npm --prefix <abs>/web-tests run test:all` green.

## Release

No migration, so merging to `main` deploys it to staging and nothing else changes. Production
goes out only through the usual `main → production` promotion, with the owner's OK and after the
PayHere repeat-partial check above.
