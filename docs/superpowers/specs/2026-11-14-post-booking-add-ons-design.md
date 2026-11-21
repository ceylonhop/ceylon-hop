# Add-ons after booking, per leg, paid online — design

Owner request 2026-11-14. Read against `origin/main` 4eb75d41. Line numbers are from that commit
and will drift; function and file names are the stable reference.

**Status:** approved by the owner 2026-11-14 (UX reviewed on the design canvas; build authorised
through to staging). Build plan: `docs/superpowers/plans/2026-11-15-post-booking-add-ons.md`.

## 1. Problem

A customer who has already booked asks for something extra on one leg of their trip: sightseeing
stops, waiting time, a safari wait. Today ops has no way to add it. The only routes are an
off-system payment or a brand-new quote for a $10 line.

The codebase has no notion of "more money on a booking that is already paid":

- **A booking's price never changes after it is created.** No code writes `bookings.total`,
  `subtotal` or `pricing_snapshot_json` after the insert. Every `update(bookings)` sets status,
  promo hold, `amountDueNow` or `paymentArrangement`
  (`postgresBookingRepo.ts`, `postgresPaymentSettlementRepo.ts`).
- **Checkout refuses a paid booking.** `POST /bookings/:id/checkout` charges only
  `draft`/`payment_pending`, or the balance of a deposit (`bookings.ts`, the `wantsBalance` gate).
  There is one payment row per purpose per booking: `REF`, `REF-D`, `REF-B`, `REF-MANUAL`.
- **A second payment beside another is a double capture** unless it is exactly a balance after a
  deposit (`isBalanceAfterDeposit`, `captureKindWithOthers` in `paymentSettlementRepo.ts`).
- **A first payment on a booking that is not `payment_pending` is `unexpected_booking_state`**
  (`postgresPaymentSettlementRepo.ts`).
- **"Mark paid" records the whole `booking.total`** and refuses when any payment has succeeded
  (`admin.ts`, `mark-paid`).
- **Add-ons are re-derived on every read** from the booking's quote, else its website snapshot
  (`assembleMany` in `postgresBookingRepo.ts`: `addOnsFor` → `snapshotAddOns`). Nothing stored
  later can appear in them.
- **Legs have three numberings.** The quote's `legIndex` counts driving legs. The ops pane's
  `legRows` counts rows including gaps. `booking_legs.seq` is display order. The only stable
  per-leg key is `booking_legs.id`, and no API returns it.

The partial-leg pay-link spec deferred exactly this
(`2026-08-04-partial-leg-pay-link-design.md` §12, "top-ups") and listed why.

## 2. Decisions (owner, 2026-11-14)

| # | Decision |
|---|---|
| D1 | Not just sightseeing: any rate-card add-on, attached to one leg of the trip. |
| D2 | **Online payment is the priority.** The business is cashless; cash is a last resort for large bookings. Version 1 has no cash path for add-ons. |
| D3 | **Private transfers only** in version 1 (single transfers and private multi-stop trips). Chauffeur trips and shared seats are deferred. |
| D4 | **Rate-card add-ons only.** Ops never types a price. An add-on added to the rate card later appears automatically. |
| D5 | **Today's rate card** prices the add-on, frozen at the moment ops sends it. |
| D6 | **One of each add-on per leg.** |
| D7 | **Customers sometimes ask mid-trip; the strong preference is payment in advance.** Ops can add an add-on while the trip is under way, including on the leg being driven. The customer can pay until the end of that leg's travel day (Sri Lanka time). No charging after the fact. |

Design decisions made while reviewing (mine; flagged for the owner's review here):

| # | Decision | Why |
|---|---|---|
| E1 | The original sale is never rewritten. Add-ons are their own records with their own payments. | Rewriting `total` breaks the balance rule, the pair rule, refund-line scaling and about 70 `.total` reads across 22 files. |
| E2 | Ops sends a fixed **add-on request**: one or more lines, amount fixed when sent. One request is one payment. | Removes every "the amount moved while the customer was paying" race. |
| E3 | The customer pays on the **manage page** they already have. | Every booking has a signed, non-expiring manage link (`manageUrl`), sent in the confirmation emails. Works for website and quote bookings alike. Ops sees that link today only while a booking is unpaid (`payLink` in `GET /admin/ops/bookings/:id` is null once paid), so each request carries its own pay link (§7.1). |
| E4 | "Expired" and "cancelled with the booking" are **computed**, not stored. | No background job, and no change to the cancel route. |
| E5 | No founder "make it free", no custom charges, no "payment declined" email. | Nobody asked for them. |

## 3. Scope

**In:**

- Ops adds rate-card add-ons to driven legs of a private booking, from the booking pane.
- The customer pays online through PayHere from the manage page.
- Receipts, the team "add-on paid" email, refunds, GA4, payment lookup.
- The guards that keep deposits, pay-on-the-day and the tracking check behaving as today.

**Out (version 1):**

- Chauffeur trips and shared seats (D3). The tables allow them later; nothing else is built.
- Cash for add-ons (D2).
- Charging for something after its leg's day has passed (D7).
- Customers adding add-ons themselves. They can only pay for what ops sent.
- Removing an add-on that was bought at booking. That stays a refund plus a note.
- Free add-ons and custom charges (E5).
- Any automatic message to a driver. No driver is recorded anywhere (`ride_ops` has no driver
  column).

## 4. Rules

### 4.1 Which bookings and legs

A request can be **created** when all of these hold:

- The booking is private: `mode === 'single'`, or `mode === 'trip'` with `serviceType === 'private'`.
- The booking's status is `paid`, `confirmed` or `in_progress` (`SECURED_STATUSES` in
  `domain/balance.ts`). A pay-on-the-day booking is `confirmed`, so it qualifies.
- `needsPricing` is not set.
- Every line names a `booking_legs` row of this booking with `kind = 'leg'` and `removed_at` null.
  A `gap` row (a stretch the customer covers themselves) is refused.
- Every line's leg has no `travel_date`, or a `travel_date` of today or later
  (`isoToday('Asia/Colombo')`).
- The booking has stored legs. A booking with no `booking_legs` rows returns `legs_missing`.
  Rows exist for every booking created since migration 0042 (2026-08-08); older ones need
  `scripts/backfill-booking-legs.ts`, which is run deliberately. Whether it has run on prod is
  **unverified** (a prod read needs the owner's OK).

### 4.2 Which add-ons and what price

- Codes are `EXTRA_CODES` (`quote/rateCard.ts`): sightseeing, safari-wait, luggage, front, flex,
  waiting. `hotel-pickup` / `hotel-dropoff` are shared-only and stay excluded.
- The price is `liveRateCard(...).extras[code]`: the compiled card with the Rates page's revisions
  applied, the same card a new website booking prices against. Extras are flat amounts
  (`priceExtras` in `quote/extrasDeposit.ts`): no pax, km, vehicle or hot-zone multiplier, and no
  price finishing.
- The line's label is frozen at creation: `` `${EXTRA_LABELS[code]} — ${from} → ${to}` ``, the same
  shape a per-leg quote extra already has ("Waiting fee — Kandy → Ella").
- Promo codes, manual discounts and deposits do not apply. A request is always paid in full.

### 4.3 One per leg (D6)

- Among add-ons added after booking: refused when the same code is already on that leg in a
  request that is awaiting payment or paid-and-not-fully-refunded. Checked in the transaction
  that holds the booking row lock, so two staff cannot race it.
- Against add-ons bought at booking: refused only where it is unambiguous, that is a **one-leg
  booking** whose booking-time add-ons include that code. On a multi-leg booking the booking-time
  add-ons cannot be tied to a stored leg reliably (website extras carry no leg; a quote's
  `legIndex` is positional and shifts on a part-trip link), so the form shows them and ops
  decides. This is a known limit.

### 4.4 Request states

Stored `status`: `open`, `paid`, `cancelled`. Everything else is computed on read:

| Shown as | When |
|---|---|
| Awaiting payment | `open` and payable (below) |
| Expired | `open`, not payable because a leg's day has passed or the trip has finished |
| Cancelled with booking | `open` and the booking is `cancelled`, `refunded` or `no_show` |
| Paid | `paid` |
| Part refunded / Refunded | `paid`, with confirmed refunds on its payment below / equal to its amount |
| Cancelled | `cancelled` |

**Payable** means all of:

- `status = 'open'`;
- the booking is `paid`, `confirmed`, `in_progress` or `completed`;
- every line's leg has a `travel_date` of today or later, **or** has no `travel_date` and the
  booking is not `completed`.

So a mid-trip request stays payable until the end of that leg's day even if ops marks the trip
completed that afternoon (D7). Because lines point at `booking_legs.id`, a later date change by
ops moves the deadline with the leg.

### 4.5 Cancelling a request

- Ops can cancel an `open` request, with a required reason.
- Refused with `payment_in_flight` while its payment row is `pending` and its `lastAttemptAt` is
  within `CHECKOUT_TOKEN_TTL_MS` (30 minutes, `lib/bookingToken.ts`). A PayHere form cannot be
  recalled once open; an abandoned one may never report a failure, so the lock is time-bound.
- A `paid` request is never cancelled. It is refunded through the existing refund flow.

## 5. Data model

One migration (next free number at build time; 0079 today). All additive.

### 5.1 `booking_add_on_requests`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `booking_id` | uuid FK → bookings | |
| `seq` | int | 1, 2, … per booking. UNIQUE `(booking_id, seq)`. Assigned under the booking row lock. Names the order id. |
| `status` | text | CHECK in (`open`, `paid`, `cancelled`) |
| `total_cents` | int | CHECK > 0. Sum of its lines, fixed at creation. |
| `currency` | text | `USD` |
| `rate_card_version` | text | The live card's version when priced. |
| `payment_id` | uuid FK → payments, UNIQUE, nullable | Set when the first checkout creates the payment row. |
| `created_by` | text | Staff email. |
| `created_at` | timestamptz | |
| `paid_at` | timestamptz null | |
| `cancelled_by`, `cancelled_at`, `cancel_reason` | text / timestamptz / text, null | |

### 5.2 `booking_add_ons` (the lines)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `request_id` | uuid FK → booking_add_on_requests | |
| `booking_id` | uuid FK → bookings | Denormalised for the per-booking read. |
| `leg_id` | uuid FK → booking_legs | NOT NULL in version 1. A shared seat would need it nullable later. |
| `code` | text | An `EXTRA_CODES` value at creation. Not CHECKed: the rate card owns the list. |
| `label` | text | Frozen customer-facing label (§4.2). |
| `amount_cents` | int | CHECK > 0. Frozen. |

### 5.3 Widened CHECKs

- `payments_purpose_valid`: add `'add_on'`.
- `customer_communications_kind_valid`: add `'add_on_request'`, `'add_on_paid'`.

**Release:** merging the migration applies it on staging at once and on prod at the next
`main → production` promote. It is additive and nothing reads the new tables until the later PRs.

## 6. Money

### 6.1 Trip money stays trip money (first PR, no behaviour change)

Every rule about the **trip's** money must ignore `purpose = 'add_on'` rows. One helper,
`tripPayments(rows)`, in `domain/balance.ts`, applied at:

| Place | Why it must change |
|---|---|
| `balanceDueCents`, `isBalanceOpen` (`domain/balance.ts`) | Otherwise an add-on payment lowers the trip balance a deposit customer owes. |
| Settlement: the `otherCaptures` read and the first-capture branch (`postgresPaymentSettlementRepo.ts`, and the in-memory twin) | Otherwise a balance arriving after an add-on payment sees two siblings and becomes `double_capture`. |
| `mark-paid`'s `settled` guard (`admin.ts`) | Otherwise an add-on paid online blocks recording a pay-on-the-day trip's cash. |
| `projectBooking`'s `paidCents` (`bookings.ts`), `opsView` paid / balance | "Paid" for the trip must not include add-on money. |
| Quote pay page `paid`, `payment_due`, `pay_on_day`, `balance` states (`quotePay.ts`) | The keepsake states what the trip cost. |
| Promo use: `succeededPayment()` (`postgresBookingRepo.ts`) and its twin `promoUseState` | Otherwise an add-on payment on an unpaid pay-on-the-day booking uses up the code. |
| Tracking check (`bookingTracking.ts`, the `purpose !== 'balance'` filter) | Otherwise every add-on payment is a finding: it never moves the booking to `paid`. |

**Deliberately unchanged** (they ask "is there any money on this booking?"):
`supersededPayLink.ts`, `duplicateBookings.ts`, the re-book guard in `internalQuote.ts`, the
refund ceilings in `postgresRefundRepo.ts`, collected revenue in `analytics/business.ts`, and the
details-reminder `paidAt`.

No `add_on` row can exist before the migration, so this PR changes no behaviour. Its tests pin
deposits, balance, pay on the day, "Mark paid", promo use and the tracking check with an
`add_on` row present.

### 6.2 The add-on payment

- **Row:** `purpose = 'add_on'`, `orderId = ${reference}-A${seq}`,
  `idempotencyKey = checkout:${bookingId}:addon:${requestId}`, `amount = request.total_cents`.
- **Checkout:** `POST /bookings/:id/checkout` gains a third lane beside `balance`:
  `{ purpose: 'add_on', addOnRequestId }`. It requires the request to be payable (§4.4), skips the
  draft / payment_pending gate and the promo re-hold exactly as the balance lane does, creates or
  resumes the row by its idempotency key, and sets `request.payment_id`. A succeeded row returns
  `already_paid`. It never moves the booking's status.
- **Checkout token:** `POST /bookings/view/checkout-token` accepts `{ addOnRequestId }` and issues
  the existing 30-minute token when that request is payable. Without it, the route behaves as
  today.

### 6.3 Settlement

A new branch in `settle`, taken when `payment.purpose === 'add_on'`, after the existing lock,
amount check, event dedupe and failure handling:

- A second success on the same order stays `double_capture`, as today.
- Lock the request by `payment_id`. If the request is `open` and the booking is `paid`,
  `confirmed`, `in_progress` or `completed`: mark the payment succeeded, set the request `paid`
  with `paid_at`, return **`add_on_settled`**.
- Otherwise (request cancelled, or booking cancelled / refunded / no-show): mark the payment
  succeeded (the money moved, and the refund ceiling must see it) and return
  **`add_on_orphaned`**.
- Neither outcome touches `bookings.status` or `amountDueNow`.

The in-memory repo gets the same branch through a shared helper, as `captureKindWithOthers` is
shared today.

### 6.4 Webhook replies (`webhooks.ts`)

| Outcome | Reply |
|---|---|
| `add_on_settled` | Customer receipt (`add_on_paid`). Team email "Add-on paid — tell the driver". GA4 `reportPayment`. |
| `add_on_orphaned` | Critical alert: money arrived for an add-on that is no longer wanted; refund it. |
| `failed` on an `add_on` payment | Nothing to the customer, no team rescue email. Today's `failed` branch sends the trip's "payment failed" email and a rescue alert; it must skip `add_on` rows. |
| `reversal` | Unchanged. The existing critical alert is per order id. |

### 6.5 Refunds

- Unchanged on the server: a refund targets one payment and is capped by it
  (`postgresRefundRepo.ts`). The pane already sends `paymentId` (`refundTargets`).
- The pane labels the target "Add-on A1 — $10".
- The refund-lines picker (`refundLinesFor`) stays the trip's. An add-on payment's lines are its
  own lines at their own amounts, never scaled.
- A booking only becomes `refunded` when confirmed refunds equal **all** captured money
  (existing rule). After a full trip refund with a paid add-on outstanding, the pane says the
  add-on payment still needs refunding.

## 7. Surfaces

### 7.1 Ops API

- `GET /admin/ops/bookings/:id` adds:
  - `legs`: the stored `booking_legs` rows (`id`, `seq`, `kind`, `from`, `to`, `viaStops`,
    `travelDate`);
  - `addOnRequests`: each with its lines, computed state (§4.4), `orderId`, who/when, and, while
    payable, `payLink`: `manageUrl(booking)` + `#add-ons`. The existing `payLink` field is
    untouched (it stays null on a paid booking);
  - `addOnCatalogue`: `[{ code, label, priceCents }]` from the live card, present only when a
    request can be created (§4.1).
- `POST /admin/ops/bookings/:id/add-ons` — CSRF, `bookings:operate`.
  Body `{ lines: [{ legId, code }], notifyCustomer }`. Returns the request and `emailed`.
  Errors: `not_private`, `booking_not_eligible`, `awaiting_price`, `legs_missing`,
  `leg_not_found`, `leg_not_driven`, `leg_passed`, `unknown_add_on`, `duplicate_add_on`,
  `already_bought_at_booking`.
- `POST /admin/ops/bookings/:id/add-ons/:requestId/cancel` — CSRF, `bookings:operate`.
  Body `{ reason }`. Errors: `already_paid`, `payment_in_flight`, `not_open`.

Finance (`payments:act` without `bookings:operate`) can see requests but not create them, the
same split as date changes.

### 7.2 Ops pane (`ops-ui.html`)

In the itinerary block (`data-testid="sheet-itinerary"`), under the legs:

- **Add-ons list.** Booking-time add-ons (today's Extras row) plus each request's lines with a
  state tag: Awaiting payment, Paid, Expired, Cancelled, Refunded.
- **"+ Add-on"** (shown when `addOnCatalogue` is present and the user has `bookings:operate`)
  opens the form the owner chose on 2026-11-14 (tick-boxes per leg, not dropdowns):
  - one row per stored leg from `legs` that can take an add-on (driven legs whose day has not
    passed); a row opens to show every catalogue add-on as a tick-box with its price;
  - an add-on that is already on that leg (awaiting payment or paid) is shown ticked and
    disabled with "Already added"; on a one-leg booking a booking-time add-on is shown disabled
    with "Already booked";
  - a closed row says how many are ticked;
  - an "In this request" list of every ticked line, the total, "Email the customer the pay link"
    (default on), and "Send request · $X" (disabled until something is ticked);
  - ticks under several legs make **one** request and one payment.
  The booking-time add-ons stay visible above the form (§4.3).
- **A request in flight** (its payment is `pending` with a checkout started inside the last 30
  minutes) shows "Paying now" and a disabled Cancel with the time it unlocks (§4.5).
- **Copy pay link** on an awaiting-payment request: the request's `payLink`.
- **Cancel request**, with a reason.
- Save toast follows the date-change pattern: "Sent" or "Saved — customer NOT emailed: WhatsApp
  them".

The leg picker uses the server's stored legs. The pane's own `legRows` list is **not** changed.

Elsewhere in the pane:

- **Payment fold:** an add-on payment row is labelled "Add-on A1".
- **History:** `buildActivity` gains request created / paid / cancelled entries from the request's
  own timestamps and actors.
- **Refund panel:** target label (§6.5).

### 7.3 Payment lookup (`domain/paymentCase.ts`, `services/paymentCase.ts`)

- `normaliseCaseRef` also strips `-A<n>`, so a pasted `CH-XXXXX-A1` opens the booking.
- The case view lists add-on payments in their own group. Today's fixed slots would show one as a
  stray or a double payment.

### 7.4 Customer manage page (`manage.html`, `GET /bookings/view`)

- `projectBooking` adds `addOnRequests`: `[{ id, state, totalCents, payable, lines: [{ label,
  amountCents }] }]`. Cancelled requests are left out.
- A new **"Add-ons to pay"** card for each payable request: its lines (each already names its
  leg), the total and a Pay button. Pay uses the existing checkout handoff shared with
  `booking.html`.
- Paid add-ons join the existing Extras rows (§7.6). Expired requests show as "Not added".
- The trip's Total and Paid figures are unchanged: they are the trip's.
- The page's browser `purchase` event (it reports `amountDueNowCents` against the booking
  reference) must not fire on an add-on return. The server-side GA4 hit is the record.

### 7.5 Emails (`services/notifications.ts`, `opsNotifications.ts`)

| Email | To | Trigger | Notes |
|---|---|---|---|
| `add_on_request` "An add-on for your trip — pay $X" | Customer | Ops sends a request with "Email the customer" on | Lists the lines, links to the manage page. Best-effort, like `sendScheduleSet`; the response says whether it was delivered. |
| `add_on_paid` receipt | Customer | `add_on_settled` | |
| "Add-on paid — tell the driver: REF" | Team | `add_on_settled` | Must **not** use the "Paid:" subject prefix, which is a Gmail filter anchor. |

`emailTracking` keys the ledger on `${booking.id}:${kind}`, which would fold every add-on email of
a booking into one ledger row. These two kinds key on
`${booking.id}:${kind}:${requestId}`.

### 7.6 The one add-ons list

`booking.addOns` is the single list every existing reader uses: the `factRows` Extras row in
about a dozen customer and team emails, the manage page, and the ops pane. `assembleMany`
(and the in-memory repo) append the labels of **paid, not fully refunded** post-booking lines to
it. That puts a paid add-on on the trip reminder, the cancellation email and the rest with no
change to those senders.

### 7.7 Quote pay page (`quotePay.ts`)

A quote customer also has the pay page, whose `paid` state is a keepsake. It keeps stating the
trip's amount (§6.1) and the quote's own add-ons. It does not list post-booking add-ons; the
manage page does.

### 7.8 Analytics

- **GA4 server hit** (`ga4Hits.ts`): an `add_on` payment reports `payment_type: 'add_on'` and its
  order id as `transaction_id`. Today any second payment is labelled `'balance'`.
- **Collected revenue** sums succeeded payment rows and needs no change.
- **Accepted gaps:** "revenue at risk" and "payment outstanding" look only at `payment_pending`
  bookings, so an unpaid request is not counted there. The daily digest's `valueBooked` sums
  `booking.total` and leaves add-ons out.
- **Watchdog:** it sweeps `payment_pending` bookings only, so a pending add-on payment raises no
  alert and is never chased (owner rule: don't chase abandoned checkouts).

## 8. Stories this supports

Ops:

1. Add sightseeing to Kandy → Ella on a four-leg trip; the customer is emailed a pay link.
2. Copy the pay link into WhatsApp.
3. Add several add-ons in one request; the customer pays once.
4. Cancel a request the customer no longer wants.
5. See each add-on's state on the booking; get the "tell the driver" email when one is paid.
6. Refund a paid add-on on its own payment.
7. Add an add-on mid-trip, on the leg being driven (D7).

Customer:

8. Pay from the email or the WhatsApp link, on the manage page.
9. Get a receipt; see the add-on on the manage page and in later emails.
10. Come back days later through the same link and pay then.

Founder / finance:

11. See the money in collected revenue and in GA4 as an add-on payment.
12. Paste `CH-XXXXX-A1` from the PayHere dashboard into payment lookup.

## 9. Edge cases

| Case | Behaviour |
|---|---|
| Deposit booking pays an add-on, then the balance | Balance still shows the full amount owed and settles as `balance_settled` (§6.1). |
| Pay-on-the-day booking pays an add-on online | Settles as `add_on_settled`; the trip's cash can still be recorded (§6.1). |
| Card declined | No trip "payment failed" email, no rescue alert. The Pay button is still on the page. |
| Double click, or two tabs | One payment row, resumed by its idempotency key. |
| Ops adds another add-on while the customer is paying | A new request with its own Pay button. The one in flight is untouched. |
| Ops cancels while the customer is paying | Refused for 30 minutes after the last attempt (§4.5). |
| Money arrives after a request was cancelled | `add_on_orphaned`: critical alert to refund. |
| Money arrives after the booking was cancelled | `add_on_orphaned`. |
| Booking cancelled with an open request | Shown as "Cancelled with booking"; not payable (§4.4). No change to the cancel route. |
| Booking fully refunded, add-on not | Booking stays `cancelled` until the add-on payment is refunded too. The pane says so. |
| Rates page changes between send and pay | The customer pays the frozen amount. |
| Ops moves the leg's date | The pay deadline moves with the leg. |
| Leg has no date yet | Payable until the trip is completed. |
| Leg's day has passed | Cannot be added; an open request shows as Expired. |
| Gap leg | Refused (`leg_not_driven`). |
| Same add-on twice on a leg | Refused (`duplicate_add_on`). |
| Same add-on already bought at booking, one-leg booking | Refused (`already_bought_at_booking`). |
| Same add-on already bought at booking, multi-leg booking | Not detected; the form shows the booking-time add-ons (§4.3). |
| Booking has no stored legs | `legs_missing` (§4.1). |
| Customer email fails to send | Toast: "Saved — customer NOT emailed: WhatsApp them". |
| Chargeback on an add-on payment | Existing `reversal` alert, per order id. |
| Chauffeur trip or shared seat | No "+ Add-on"; the API returns `not_private`. |

## 10. Build order

One PR each, tests first (red → green), `npm run check` and `npm run test:all` green before
every commit.

1. **Migration + repos + rules** (§4, §5). A schema change that reaches staging on merge (owner
   OK given 2026-11-14). Request / line repos (Postgres and in-memory), eligibility, payable and
   state rules as pure functions. Moved ahead of the money guard on 2026-11-15: the guard's
   Postgres tests need an `add_on` payment row, which the widened CHECK in this migration allows.
2. **Trip money ignores add-on payments** (§6.1). No behaviour change. Postgres contract tests
   for settlement; unit tests for balance, mark-paid, promo use, tracking.
3. **Ops API + request email** (§7.1, §7.5 first row).
4. **Online payment** (§6.2–6.4, §7.3, §7.8 GA4): checkout lane, checkout token, settlement
   branch, webhook replies, receipt and team emails, payment lookup.
5. **Manage page** (§7.4), with web tests at 375 / 768 / 1280.
6. **Ops pane** (§7.2, and the pane halves of §6.5 and §7.2 "Elsewhere": refund target label,
   payment-fold label, history entries). `ops-ui.html` is the hot file: one PR touches it.
7. **The one add-ons list** (§7.6): the `booking.addOns` merge.

Nothing reaches a customer until PR 6 gives ops the button, so PRs 1–5 can merge and soak on
staging first. Nothing in this build is promoted to `production` without the owner.

## 11. Stop-and-ask items this touches

Per `CLAUDE.md` maintenance rules, each needs the owner's explicit OK when its PR is proposed:

- **Schema / migration** (PR 2).
- **Pricing read** (PR 2): reads `liveRateCard`; does not change `rateCard.ts` or any price.
- **Shared money paths** (PRs 1 and 4): `domain/balance.ts`, settlement, checkout, webhooks.
- **Shared component** (PR 6): the booking pane's itinerary block.
- **Config:** none. No new env var and no kill switch: nothing happens until ops sends a request.

## 12. Unverified

- Whether `scripts/backfill-booking-legs.ts` has been run on prod.
- PayHere's fee and any minimum on a $5–19 charge.
- The internals of `reversalGate` and `transitionAndNotify` in `admin.ts`.
- How `services/paymentCase.ts` lays out its slots in detail (read at the function-name level).

## 13. Adjacent issues noticed, not fixed here

- Three label maps for the same add-ons disagree: the pane's `EXTRA_LBL` ("Front seat"), the
  quote's `EXTRA_LABELS` ("Child seat") and the email's `EXTRA_LABELS`.
- `booking_schedule_events.leg_id` exists and is never written.
- `transfer_request` has no extras column, so the `input.extras` fallbacks in the pane and the
  emails are dead on Postgres.
