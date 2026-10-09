# Deposits — customer picks on the pay link (deposit now, balance on the same link) — Design Spec

**Date:** 2026-10-07
**Status:** Approved design (owner, 2026-10-07), **revised by the owner 2026-10-08** after testing
#948 on staging: the customer chooses deposit or full on the pay link, and pays the balance from
the same link, any time. §2, §4, §5.2–§5.4, §6, §7 and §10 changed; see §11 for the diff. PR 1
(#940) and PR 2 (#948) are built; PRs 3–5 not started.
**Supersedes:** the stale parts of `2026-07-23-deposits-balance-payments-design.md` (see §9).
Its business rules for the deposit amount and cancellation still stand; its data model
(`deposit_paid` status, `quote.payToken`, migration 0015) and slice plan do not.
**Verified against:** `origin/main` @ `06caf849` (2026-10-06). Every "today" claim below cites
the file:line it was read from.

---

## 1. Goal

Let a customer paying an eligible quote's pay link choose **pay a deposit** or **pay in full**,
run the trip as secured after a deposit, and let them pay the **balance by card from the same
link, any time**. Ops sends one link (as today) and resends the same link for the balance.
Website checkout deposits come later, on the same rails.

## 2. Business rules (owner, 2026-10-07; revised 2026-10-08)

| Rule | Value |
|---|---|
| Deposit amount | **Fixed rule, not editable by ops:** `max(10% of total, $50)`, capped at the total. Rounded to whole cents (`Math.round`). |
| Eligibility | Private transfers and chauffeur trips with **total ≥ $150**. Shared rides always pay in full. |
| Who chooses deposit or full | **The customer**, on the pay link (`pay.html`). Ops mints one ordinary pay link — there is no deposit mode or second link. *(2026-10-08; was: ops mints a deposit link.)* |
| How the deposit is paid | **Card only**, on the pay link. Offered only when the link covers the **whole trip** (no part-of-trip selection) and the quote is eligible. |
| How the balance is paid | **Card only**, from the **same pay link**: reopened after a deposit it shows what is paid and a "Pay balance" button. Ops resends that link by hand. *(2026-10-08; was: the manage page.)* The manage page keeps its read-only "Balance due" row and gets no button. |
| When the balance can be paid | **Any time** after the deposit settles. It is due by day one of the trip; ops chases it by resending the link. **No automated reminders** in this release. *(2026-10-08; was: day one only.)* |
| Booking after the deposit | **Secured.** The trip runs normally (`paid → confirmed → …`), with "balance due $X" shown everywhere until it is paid. |
| Unpaid balance | Never auto-cancelled. Surfaced to ops; a human decides. |
| Cancellation | Existing cancellation ladder applied to the **amount actually paid** (refund = max(0, paid − retention)). Refund figures stay operator-entered, as today (`admin.ts:207-213`). Terms unchanged. |
| Cash / bank deposits or balances | **Out of scope.** Mark paid stays full-amount only. |

## 3. Current state (verified @06caf849)

- This release reverses two recorded owner decisions, by the owner's call on 2026-10-07:
  "Charge full amount for all bookings" (2026-07-07, `engine.ts:171-178`) and "no booking charges a
  deposit today" (2026-09-26, `opsRates.ts:67`, `ops-ui.html:8252`). Both comments are updated in
  the PRs that change the behaviour.

- Every booking is charged its full total. `engine.ts:179` (`amountDueNowCents = totalCents`)
  and again `services/pricing.ts:61` and `:194`. Creation sites also write total:
  `internalQuote.ts:1130-1132` (Mark booked), `quotePay.ts:322-324` (pay link).
- `RATE_CARD.deposit = { pct: 10, capCents: 5000 }` (`rateCard.ts:51`) and `depositCents()` is
  `min(round(total×pct/100), capCents)` (`extrasDeposit.ts:40-43`) — the **old** rule, and
  display-only. It is exported to the site as `depositPct`/`depositCap`
  (`pricingPayload.ts:17-18,57-58` → `transfers-data.js:14-15`).
- `bookings.amount_due_now` exists, nullable, CHECK `0 ≤ amount_due_now ≤ total`
  (`schema.ts:42,91-94`). No repo method changes it after insert.
- **One payment per booking is assumed everywhere:**
  - checkout idempotency key `checkout:${booking.id}` and `orderId = booking.reference`
    (`bookings.ts:985,1005-1012`); `payments.order_id` and `idempotency_key` are UNIQUE
    (`schema.ts:135,139`);
  - settlement marks a second success on the same booking `double_capture` and leaves the booking
    alone (`postgresPaymentSettlementRepo.ts:126-155`; alert `webhooks.ts:347-355`);
  - mark-paid refuses if any payment succeeded (`admin.ts:514-515`);
  - `paymentVerdict` reads the first gateway row only → two card captures = `paid_twice`
    (`domain/paymentCase.ts:124-146,217-225`);
  - tracking requires a `→ paid` status event per succeeded payment
    (`services/bookingTracking.ts:234-268`);
  - watchdog "paid booking has no confirmation email" looks only for `'confirmation'`
    (`services/watchdog.ts:264`), while a deposit settle marks `'deposit_received'`
    (`webhooks.ts:383-385`);
  - refunds always attach to `captured[0]` (no ORDER BY) with only a booking-wide ceiling
    (`postgresRefundRepo.ts:58-86`);
  - ops `paymentStatus` is `'paid'` if any payment succeeded (`routes/ops.ts:237-243`,
    `services/opsView.ts:40,114`).
- Already deposit-aware and reusable:
  - webhook sends `sendDepositReceived` instead of the confirmation when
    `amountDueNow < total` (`webhooks.ts:380-386`); template at `notifications.ts:895-939`;
  - `paidRows` renders "Deposit paid / Balance due" (`notifications.ts:559-570`);
  - team "Paid:" email has a Balance due row (`opsNotifications.ts:280-281,342-358`);
  - `manage.html` shows a "Balance due" row when `balanceDueCents > 0` (`manage.html:332,355-357`);
    `balanceDueCents` today is the static `total − amountDueNow` (`bookings.ts:188-200`);
  - server-side GA4 labels a second payment `payment_type: 'balance'` with its own
    transaction id (`analytics/ga4Hits.ts:120-123`);
  - revenue sums all succeeded payments (`analytics/business.ts:186-197`);
  - terms §4 already allow a deposit with the balance before travel (`tools/legal/terms.body.html:49-51`).

## 4. Data model

- **No new booking status.** A deposit settle moves `payment_pending → paid` exactly like a full
  payment. Lifecycle (`paid → confirmed → in_progress → completed`) is untouched.
- **`bookings.amount_due_now` = the deposit** when the customer chose the deposit (total otherwise).
  It is "what securing the booking costs", which is what checkout, the deposit email branch and
  every email already read it as. Written by `/quotes/pay/start` from the customer's choice. A
  resumed `/start` (the customer came back and chose the other option) may rewrite it, but **only**
  while the booking is `draft | payment_pending` and no payment on it has succeeded; after that it
  never changes.
- **Migration 0066 (additive; 0065 is claimed by open PR #930 `0065_experiences` — take the next free number at build time, with a journal `when` later than every other):** `payments.purpose text NOT NULL DEFAULT 'full'` with
  `CHECK (purpose IN ('full','deposit','balance'))`. Existing rows read `'full'`. Same migration:
  the `customer_communications_kind_valid` CHECK re-created with `'balance_received'` added.
  *(2026-10-08: `quotes.pay_link_deposit_cents` is dropped — there is no deposit link to freeze;
  the deposit is computed from the quote total at `/start` by the fixed rule.)*
  **Release order:** drizzle skips a migration whose journal `when` is older than the last one
  applied. Whichever of #930 (0065) and this PR reaches `main` second must carry the larger `when`.
  (On Postgres ≥ 11 a constant default is metadata-only — no table rewrite. Our Supabase Postgres
  major version is **unverified**; check `select version()` on staging before merging.)
- **Derived, never stored:**
  - `paidCents` = Σ `amount` of succeeded payments on the booking;
  - `balanceDueCents` = `max(0, total − paidCents)` while the booking is `paid | confirmed |
    in_progress` **and** at least one payment has succeeded; otherwise `max(0, total −
    amountDueNow)` (today's meaning — before any payment, or a secured booking with no recorded
    payment, so a legacy row never claims the whole total is owed); and `0` for
    cancelled/refunded/no_show/completed. `paidCents` is gross (refunds not netted) — never display
    it unchanged on a refunded or double-captured booking.
  One pure function owns this (`domain/balance.ts`), used by the customer projection, ops view and
  the balance checkout.
- **Order IDs and idempotency keys** — one per kind of attempt, so a customer who tries the deposit
  and then switches to full (or back) gets a fresh row instead of colliding on the UNIQUE
  `order_id` / `idempotency_key` (`schema.ts:135,139`):

  | purpose | orderId | idempotency key |
  |---|---|---|
  | full | `REF` (unchanged) | `checkout:${bookingId}` (unchanged) |
  | deposit | `REF-D` | `checkout:${bookingId}:deposit` |
  | balance | `REF-B` | `checkout:${bookingId}:balance` |

  An abandoned attempt of the other kind stays `pending`/`failed` beside the one that succeeded.
  Every reader that picks "the" payment of a booking must prefer the succeeded row (§5.1). Two
  succeeded first payments (deposit **and** full, e.g. two tabs) stay `double_capture`.
  Build check: grep for any code that assumes `payment.orderId === booking.reference` (settlement
  looks payments up by `orderId`, `paymentSettlementRepo.ts:95`, which is safe).

## 5. Behaviour changes

### 5.1 Accept a legitimate second payment
- **Settlement:** a succeeded `purpose = 'balance'` payment on a booking whose other succeeded
  payments are exactly one `purpose = 'deposit'` row, with deposit + balance ≤ total, is **not**
  `double_capture`. The payment is marked succeeded; the booking status is not changed (it is
  already `paid`/`confirmed`/`in_progress`); result kind `balance_settled`. Any other sibling
  capture stays `double_capture`.
- **Webhook on `balance_settled`:** send the team "Paid:" email (now titled with the amount
  actually paid), send the customer **balance receipt** (§6), report GA4 (existing reporter already
  labels it `balance`). No confirmation email, no `deposit_received`.
- **Payment case:** two card rows with purposes `deposit` + `balance` → verdict `paid`, captured =
  their sum. `paid_twice` keeps its meaning for any other pair.
- **Tracking:** a succeeded `balance` payment does not require its own `→ paid` transition.
- **Watchdog:** `'deposit_received'` satisfies the paid-booking-has-confirmation check.
- **Refunds:** a refund request names a specific payment (`paymentId`); ceiling = that payment's
  amount minus its own reserving/confirmed refunds. The booking-wide ceiling stays. The booking
  becomes `refunded` when Σ refunded = Σ captured (unchanged rule). With one captured payment
  `paymentId` may be omitted (today's behaviour); with several it is required
  (`409 payment_ambiguous`) and the ops UI shows one refund button per payment.
- **Mark paid:** unchanged — still refused once any payment succeeded.
- **Abandoned sibling attempts (2026-10-08):** with customer choice a booking can hold a `pending`
  or `failed` attempt of one kind beside a succeeded payment of another (§4 order-ID table).
  `paymentVerdict` (today: first gateway row, `domain/paymentCase.ts:124-146`), tracking and the
  ops payment status judge the **succeeded** rows; an unsucceeded sibling is history, not an
  incident. A late success on the abandoned sibling is still `double_capture`.

### 5.2 The customer chooses on the pay link
- **`GET /quotes/pay/view`, payable state:** gains `deposit: { cents, usd, balanceCents, balanceUsd }`
  when the link covers the whole trip (`quote.payLinkSelection` empty — no part-of-trip
  `soldCents`) **and** `depositFor(product, quote.totalCents) > 0`. Absent otherwise; the page then
  looks exactly as today. `totals` stays the trip total.
- **`pay.html` payable view:** when `deposit` is present, two options above the pay button:
  **Pay in full** — $X (selected by default; today's lane) and **Pay a deposit** — $Y now, balance
  $Z any time before your trip. The button label and the "Pay securely…" line follow the selection.
- **`POST /quotes/pay/start`:** body gains `payment: 'full' | 'deposit'` (missing = `'full'`).
  `'deposit'` is refused `409 { error: 'deposit_ineligible' }` unless the `/view` rule above holds
  (the server recomputes it; the client never sends an amount). The booking is created with
  `total = quote.totalCents`, `amountDueNow = deposit`. On a **resumed** start the choice may
  differ from the first tap: `amountDueNow` is rewritten under the §4 guard.
- **Checkout (`POST /bookings/:id/checkout`):** charges `amountDueNow` as today; the payment row
  gets `purpose = 'deposit'` with `orderId REF-D` / key `checkout:${id}:deposit` when
  `amountDueNow < total`, else `'full'` with `REF` / `checkout:${id}` (§4).
- **Browser GA4 `purchase`** on the pay link's return leg reports the amount actually charged
  (the deposit), with the same item (#936).

### 5.3 The balance, on the same pay link
- **`GET /quotes/pay/view`:** a new state **`balance`**, checked before `paid`: the quote's
  converted booking has a succeeded `deposit` payment, its status is `paid | confirmed |
  in_progress`, and `balanceDueCents > 0`. Body `{ state: 'balance', balance: { title, totalUsd,
  paidUsd, paidOn, balanceCents, balanceUsd } }`. Once the balance lands the link shows today's
  `paid` state. Available **any time** after the deposit; no date gate.
- **`POST /quotes/pay/balance`** (same token): `{ bookingId, checkoutToken }` for that booking
  while the balance is open; `409 { error: 'no_balance_due' }` otherwise. No terms re-acceptance
  (accepted at the deposit).
- **Checkout** with `{ purpose: 'balance', returnTo: 'pay-link' }`: allowed only when the booking
  is `paid | confirmed | in_progress`, has a succeeded `deposit` payment and `balanceDueCents > 0`.
  Charges exactly `balanceDueCents` on `REF-B` / `checkout:${id}:balance`, `purpose 'balance'`.
  Anything else → `409 no_balance_due`. No promo re-hold (honoured at the deposit).
- **`GET /bookings/pay-return`** today answers `paid` if ANY payment succeeded
  (`bookings.ts:901-905`), which would tell a balance payer "paid" off the deposit. When the
  return leg belongs to a balance attempt, the answer is computed from the balance row alone.
- **`pay.html`:** the `balance` state renders the trip, "Paid $Y on <date>", "Balance $Z" and a
  **Pay balance** button (same busy/hand-off/return flow as today). The return leg must not
  re-send the booking reference as a browser `purchase` for the balance — server-side GA4
  already reports it with its own transaction id (`ga4Hits.ts:120-123`).
- **Manage page:** unchanged except that its existing "Balance due" row reads the ledger (PR 1).

### 5.4 Ops tool (`api/src/routes/ops-ui.html`)
- Quote builder: **no new button.** The estimate chip "Pay in full to confirm … no balance due
  after checkout" (`ops-ui.html:8985-8992`) becomes, for an eligible quote: "Customer can pay a
  deposit of $Y (balance $Z later) or in full on the pay link".
- Booking drawer payment block: Total / Paid so far / Balance due; **Copy pay link** button when
  the balance is open — the converted quote's pay link URL (same token the customer already has:
  quote id, revision, `payLinkSeq`), returned by the ops booking detail as `balancePayLink`.
- Bookings list: row pill "Balance $X" when balance > 0; attention reason "Balance due — travels
  today" when balance > 0 and the travel date (Asia/Colombo) is today.
- Rates page row already describes the rule (#948).

## 6. Emails
- `sendDepositReceived` (exists, `notifications.ts:895-939`): copy changes "we'll share the payment
  details on WhatsApp closer to the day" → "pay the balance of $Z any time before your trip, using
  the same link you paid the deposit with".
- **New `sendBalanceReceived`** (customer, kind `'balance_received'`): "You're fully paid — REF",
  rows Total / Deposit paid / Balance paid. Reuses the existing shell and `paidRows` style. The
  `kind` list is duplicated in `adapters/email.ts:10-21`, `domain/trackingContract.ts:9-21`,
  `customer_communications` CHECK (`schema.ts:633`) and `notificationLogRepo.ts:5-13` — the CHECK
  change rides in the same migration.

## 7. Out of scope (this release)
Website checkout deposit option · a Pay balance button on the manage page · automated balance
reminders · policy-computed refund amounts · tokenized auto-charge of a saved card · cash/bank
deposits or balances · deposit on part-of-trip or shared-ride links.

## 8. Risks and unverified facts
- PayHere docs could not be read verbatim on 2026-10-07 (Cloudflare challenge). Nothing in this
  design depends on a PayHere feature we don't already use: both payments are ordinary
  `/pay/checkout` sales with distinct `order_id`s (`payhere.ts:133`).
- Postgres version for the instant default add — unverified (§4).
- A balance paid in cash to the driver cannot be recorded (owner chose card only).
- Changing `RATE_CARD.deposit` regenerates `transfers-data.js` (`@generated` block) — pricing
  file, owner OK required before that PR.
- The migration auto-applies on staging when merged to `main`, and on prod at promotion.

## 9. What changed vs the 2026-07-23 spec
| July spec | Now |
|---|---|
| Slice 1 "quote → cash" via `quote.html?t=` tokens | Shipped differently: ops pay links + `pay.html` (`internalQuote.ts:1183`, `quotePay.ts`). Dropped. |
| New `deposit_paid` status | Dropped — payment state is derived; lifecycle unchanged (balance can arrive after `confirmed`). |
| Balance reminders 7/3/1 days | Deferred — owner sends links by hand on day one. |
| PayHere refund API full-only | Partial amounts already supported (`payhere.ts:383-392`). Not needed here. |
| Cash recording out of scope | Mark paid (cash/bank) shipped since; stays full-amount only. |
| Migration 0015 | Next free is 0066 (0065 claimed by #930). |

## 10. Testing
- Unit: `depositFor` boundary table ($149.99 ineligible, $150 → $50, $500 → $50, $600 → $60,
  shared ineligible); `balanceDue` across statuses and payment sets.
- Settlement (in-memory + Postgres suites): deposit then balance → `balance_settled`; balance
  without deposit / over total → `double_capture`; deposit **and** full both succeeding →
  `double_capture`.
- Routes: `/quotes/pay/view` offers `deposit` only for an eligible whole-trip link; `/start` with
  `payment: 'deposit'` writes `amountDueNow = deposit`, is refused when ineligible or on a
  part-of-trip link, and a resumed start that switches choice rewrites `amountDueNow` only while
  nothing has succeeded; checkout writes `purpose`/`orderId`/key per §4; `/view` `balance` state
  and `/quotes/pay/balance` gates; balance checkout gates and amount; pay-return judges the balance
  row; refunds per payment ceiling.
- Payment case, tracking, watchdog regression tests for the deposit + balance pair **and** for an
  abandoned sibling attempt beside a succeeded payment.
- E2E (`web-tests/`): pay page shows the two options on an eligible link and none otherwise;
  choosing the deposit posts `payment: 'deposit'`; the balance state shows paid/balance and posts
  `purpose: 'balance'`. Full-payment specs pass untouched (regression guard for the default lane).

## 11. What changed on 2026-10-08 (owner, after testing #948 on staging)
| 2026-10-07 design | 2026-10-08 |
|---|---|
| Ops mints a **deposit link** (`pay-link` `mode: 'deposit'`) | No mode. The **customer picks** deposit or full on the ordinary pay link. |
| `quotes.pay_link_deposit_cents` freezes the deposit on the quote | Dropped. The deposit is computed by the fixed rule at `/start`. |
| First payment is always `REF` | Deposit attempts use `REF-D`, so switching choice never collides (§4). |
| Balance paid on the **manage page**, sent on day one | Balance paid on the **same pay link**, any time; ops resends that link. Manage page: read-only row. |
| Ops "Deposit link" button, "Copy balance link" (manage URL) | No new quote button; drawer "Copy pay link" (the quote's pay URL). |
