# Deposits — ops first (deposit now, balance on day one) — Design Spec

**Date:** 2026-10-07
**Status:** Approved design (owner, 2026-10-07). Build not started.
**Supersedes:** the stale parts of `2026-07-23-deposits-balance-payments-design.md` (see §9).
Its business rules for the deposit amount and cancellation still stand; its data model
(`deposit_paid` status, `quote.payToken`, migration 0015) and slice plan do not.
**Verified against:** `origin/main` @ `06caf849` (2026-10-06). Every "today" claim below cites
the file:line it was read from.

---

## 1. Goal

Let ops take a **card deposit** on an eligible quote, run the trip as secured, and collect the
**balance by card on day one** of the trip through a link ops sends by hand. Website checkout
deposits come later, on the same rails.

## 2. Business rules (owner, 2026-10-07)

| Rule | Value |
|---|---|
| Deposit amount | **Fixed rule, not editable by ops:** `max(10% of total, $50)`, capped at the total. Rounded to whole cents (`Math.round`). |
| Eligibility | Private transfers and chauffeur trips with **total ≥ $150**. Shared rides always pay in full. |
| How the deposit is paid | **Card only**, via a deposit pay link ops mints from the quote. Whole trip only — never combined with a part-of-trip (subset) link. |
| How the balance is paid | **Card only**, via a balance link (the booking's manage page) ops copies and sends by hand. |
| When the balance is due | **Day one of the trip.** Ops sends the link on the travel day. **No automated reminders** in this release. |
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
- **`bookings.amount_due_now` = the deposit** for a deposit booking (total otherwise). Set once at
  creation, never updated. It is "what securing the booking costs", which is what checkout,
  the deposit email branch and every email already read it as.
- **Migration 0066 (additive; 0065 is claimed by open PR #930 `0065_experiences` — take the next free number at build time, with a journal `when` later than every other):** `payments.purpose text NOT NULL DEFAULT 'full'` with
  `CHECK (purpose IN ('full','deposit','balance'))`. Existing rows read `'full'`. Same migration:
  `quotes.pay_link_deposit_cents integer NULL` (CHECK `> 0`), and the
  `customer_communications_kind_valid` CHECK re-created with `'balance_received'` added.
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
- **Order IDs:** first payment keeps `orderId = REF` (full or deposit); balance is `REF-B`.
  Idempotency key for the balance attempt: `checkout:${bookingId}:balance`. Distinct order IDs
  make PayHere's (non-)uniqueness of `order_id` irrelevant.

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

### 5.2 Deposit link (ops quote)
- `POST /admin/quote/:id/pay-link` accepts `{ "mode": "deposit" }` (body otherwise as today).
  Refused `409 { error: 'not_linkable', reason: 'deposit_ineligible' }` unless the quote is
  eligible (§2) **and** the link is for the whole trip (no `legIndexes`/`extraIndexes`).
- Freezes the deposit on the quote as `quotes.pay_link_deposit_cents` (same migration; mirrors how
  `sold_cents` freezes a partial link's amount), and bumps `payLinkSeq` whenever the mode changes,
  so a previously sent full link goes stale and vice versa. A content edit clears it, exactly where
  `soldCents` is cleared today (`quoteRepo.ts:643-644`, `postgresQuoteRepo.ts:511-512`).
- `/quotes/pay/start` for a deposit link creates the booking with `total = quote.totalCents`,
  `amountDueNow = quote.payLinkDepositCents`. Checkout then charges the deposit (existing
  `dueNow = amountDueNow ?? total`, `bookings.ts:983`) with `purpose = 'deposit'`.
- `pay.html` payable view: "Deposit $Y today · balance $Z due on day one of your trip"; the pay
  button charges $Y.

### 5.3 Balance link (manage page)
- `POST /bookings/:id/checkout` with `{ purpose: 'balance' }`: allowed only when the booking is
  `paid | confirmed | in_progress`, has a succeeded `deposit` payment, and
  `balanceDueCents > 0`. Charges exactly `balanceDueCents`, `orderId REF-B`, key
  `checkout:${id}:balance`, `purpose 'balance'`. Anything else → `409 no_balance_due`.
- `manage.html`: when `balanceDueCents > 0` and status is `paid | confirmed | in_progress`, show
  "Pay balance $Z" (same checkout-token flow as today's pay button).
- `GET /bookings/pay-return` today answers `paid` if ANY payment succeeded (`bookings.ts:901-905`),
  which would tell a balance payer "paid" off the deposit before the balance lands. When the
  booking has a `balance` payment row, the answer is computed from that row alone.
- `POST /bookings/view/checkout-token` (`bookings.ts:930-935`) and the ops detail `payLink`
  (`routes/ops.ts:304-307`) both gate on `draft | payment_pending`; both also allow a booking with
  `balanceDueCents > 0` in `paid | confirmed | in_progress`.
- The browser GA4 `purchase` on `manage.html` must not re-send the booking reference with the
  deposit value for a balance return: it sends nothing for a balance (server-side GA4 covers it).

### 5.4 Ops tool (`api/src/routes/ops-ui.html`)
- Quote builder: **Deposit link** button beside Pay link, shown only when the quote is eligible
  (the estimate's existing `deposit` figure, `internalQuote.ts:455`, becomes the rule's amount
  and is 0 when ineligible; the mint route re-checks and is the authority). Copy: "Deposit link
  ($Y)".
- Booking drawer payment block: Total / Paid so far / Balance due; **Copy balance link** button
  (the existing manage URL) shown when balance > 0.
- Bookings list: row pill "Balance $X" when balance > 0; attention reason
  "Balance due — travels today" when balance > 0 and the travel date (Asia/Colombo) is today.
- Copy: the estimate chip "Pay in full to confirm … no balance due after checkout"
  (`ops-ui.html:8985-8992`) and the Rates page row "Deposit — not charged — bookings are paid in
  full" (`ops-ui.html:8253-8255`, source `opsRates.ts:67-68`) are updated to describe the deposit
  option.

## 6. Emails
- `sendDepositReceived` (exists, `notifications.ts:895-939`): copy changes "we'll share the payment
  details on WhatsApp closer to the day" → "we'll send you a link to pay the balance on the first
  day of your trip".
- **New `sendBalanceReceived`** (customer, kind `'balance_received'`): "You're fully paid — REF",
  rows Total / Deposit paid / Balance paid. Reuses the existing shell and `paidRows` style. The
  `kind` list is duplicated in `adapters/email.ts:10-21`, `domain/trackingContract.ts:9-21`,
  `customer_communications` CHECK (`schema.ts:633`) and `notificationLogRepo.ts:5-13` — the CHECK
  change rides in the same migration.

## 7. Out of scope (this release)
Website checkout deposit option · automated balance reminders · policy-computed refund amounts ·
tokenized auto-charge of a saved card · cash/bank deposits or balances · deposit on part-of-trip
or shared-ride links.

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
- Unit: `depositCents` boundary table ($149.99 ineligible, $150 → $50, $500 → $50, $600 → $60,
  shared ineligible); `balanceDue` across statuses and payment sets.
- Settlement (in-memory + Postgres suites): deposit then balance → `balance_settled`; balance
  without deposit / over total → `double_capture`.
- Routes: pay-link deposit mode (eligible, ineligible, subset refused, re-mint bumps seq);
  quotePay start writes `amountDueNow = deposit`; balance checkout gates and amount;
  refunds per payment ceiling.
- Payment case, tracking, watchdog regression tests for the deposit + balance pair.
- E2E (`web-tests/`): pay page deposit copy; manage page balance button. Full-payment specs pass
  untouched (regression guard for the default lane).
