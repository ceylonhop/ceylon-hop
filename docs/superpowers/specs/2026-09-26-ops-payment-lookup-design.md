# Ops payment lookup — slice 1: one booking's payment story

**Date:** 2026-09-26 · **Status:** design agreed with the owner in chat; spec awaiting owner review
· **Read from:** `origin/main` @ `4767c6c9`. Its payment code is identical to `production`
@ `91e8e6bc` (main is ahead only by #799, the analytics rebuild).

## 1. Problem

Ceylon Hop sells private transfers, shared seats and multi-day trips to foreign travellers, who pay
in USD by international card through PayHere's hosted checkout (`docs/backend-spec.md` §1, §3).
Declines, 3-D Secure failures and second attempts are normal trading, not rare faults.

When a payment goes wrong the founder needs answers to six questions:
1. Did we get paid?
2. If not, where did it stop?
3. What did PayHere say?
4. Did the customer try again?
5. What did we email them?
6. Did any money go back?

No screen answers them today:

- The booking drawer shows one booking's checkout log (#780). It does not show PayHere's
  notifications, the emails sent, or when the money landed (`api/src/routes/ops.ts:255-293`;
  `ops-ui.html` `buildActivity`).
- A booking still in `draft` is outside the queue's statuses (`ops.ts:62`), so the tool can
  neither find it nor open it.
- Everything else has meant SQL that the owner runs in Supabase: CH-XKZL3
  (`docs/checkout-redirect-spec.md` §1.1), and the September investigations into CH-8UVYG /
  CH-9SFAG and CH-PX5Z4.

This slice replaces that SQL for one booking.

## 2. Owner decisions (2026-09-26, chat)

1. The first user is the founder, looking at payments and payment problems. Ops will use it later.
2. The page is read-only. Every action stays in the booking drawer.
3. It names one of the nine payment situations in §6 ("all of them, nothing missing").
4. Missing history is shown as missing, never as "nothing happened".
5. Build order: this slice (one booking), then the customer's other bookings (same email), then
   search by anything.
6. It lives inside the ops tool. One read-only endpoint gathers the evidence, and a load failure
   makes the answer "incomplete", never silently empty.

## 3. Scope

### 3.1 In this slice

- A **Lookup** surface in the ops tool, for founder and finance only.
- Lookup by booking reference or quote reference. Draft bookings are included.
- For that one booking: who it is, the payment verdict, the payment timeline, the gaps, and any
  source that failed to load.
- A "Payment history" link to the page from the booking drawer.

### 3.2 Not in this slice

- **The customer's other bookings** (slice 2) and **search by email, phone or name** (slice 3).
- **Ride-board seats.** They pay differently (a card preapproval, charged at the cutoff) and have
  their own log (`ride_board_event`).
- **Access for the `ops` role.**
- **Asking PayHere live.** There is no status-lookup call in `api/src/adapters/payhere.ts`.
- **Team emails and alerts.** They are not stored per booking (§8).
- **Any write.** The page never changes data.
- **Fulfilment** (vehicle, pickup), and trip details beyond one line.

## 4. The source rule

The page shows recorded evidence, and nothing it cannot point back to.

- **PayHere's notification is the only source of truth for money.** It already is for settlement
  (`docs/checkout-redirect-spec.md`: "The `notify_url` webhook remains the **only** source of truth
  for settlement").
  - The verdict reads PayHere's own status code as stored: `payment_events.provider_status_code`.
    2 = paid, 0 = pending, -1 = cancelled, -2 = declined, -3 = chargeback (`adapters/payhere.ts:21-27`).
  - It never reads the derived `payments.status`. That status has been reinterpreted as bugs were
    fixed (#784, #792, and the still-open #785); the stored code has not.
- **What the customer's browser reported is shown as what the customer saw.** `gateway` and
  `return` rows never count as a payment or a decline. The pay-return answer is computed from our
  payment rows (`routes/bookings.ts:757-775`), so a "failed" there can belong to an earlier attempt.
- **`booking.status` is not payment evidence either.** A pay-link booking is moved to
  `payment_pending` before it has any payment row (`quotePay.ts:326-332`). A draft booking can
  carry a payment row (#788). The page shows `booking.status`, but judges payment from payment
  evidence alone.
- **Every timeline row carries its source table**, so any line can be checked in SQL.

## 5. Who can use it, and how they get there

- **Capability `payments:act`**: founder and finance (`api/src/lib/opsAuth.ts:28-29`).
  - The endpoint answers 403 to any other role.
  - The nav item is hidden without the capability.
  - A hand-typed `#lookup` bounces silently, exactly like `#analytics` (`ops-ui.html` `render()`).
- **Nav item "Lookup"** leads to a search box. It takes:
  - `CH-…` (a booking reference, which is also the PayHere order id, `bookings.ts:871`), with or
    without the `-MANUAL` suffix that manual payments use (`admin.ts:505`);
  - `Q-…` (a quote reference). This opens the booking the quote currently points to
    (`quotes.converted_booking_id`). A quote with no booking says so and shows the quote's status.
  - Input is trimmed and upper-cased.
- **Address:** `?case=<ref>#lookup`, the same pattern as `?booking=` and `?quote=`
  (`ops-ui.html` `routeStateFromUrl`, `syncUrl`). Reload and Back work the same way they do there.
- **Booking drawer:** a "Payment history →" link in its Payment block, shown only with
  `payments:act`.
- **"Open in queue"** on the page appears only for statuses the queue shows (`ops.ts:62`). A draft
  says "Not in the queue (draft)".

## 6. The verdict

One line at the top. It names one of the owner's nine situations and adds the facts behind it.

### 6.1 The nine situations

| # | Situation | True when (payment evidence only) | Facts shown |
|---|---|---|---|
| 1 | **Paid** | The gateway payment row succeeded | amount; PayHere payment id + card type from the success notice; checkouts before it; decline notices before it |
| 2 | **Paid by hand** | The manual row (`<ref>-MANUAL`: cash, bank transfer, other) succeeded | method; who recorded it (`settled_by`, or "not recorded" on rows older than 0043); their reference; when |
| 3 | **Declined** | Unpaid, and PayHere's latest notice since the latest `checkout/succeeded` row (for a booking older than the checkout log, simply its latest notice) was -2 (declined) or -1 (cancelled on PayHere's page) | PayHere's `status_message`; how many checkouts; how many decline notices |
| 4 | **Reached PayHere, no answer** | Unpaid, no -2 or -1 notice since the latest checkout, and since then at least one proof they reached PayHere: a `gateway/opened` row, a `return` row, or a code-0 (pending) notice | when they reached it; that a 3-D Secure failure and closing the page look identical here |
| 5 | **Started checkout, nothing after** | Unpaid, a checkout happened (a gateway payment row exists), and nothing proves they reached PayHere | checkout time(s); the pay-link / manage-link gap note (§8) |
| 6 | **Never started checkout** | No payment row and no `checkout/succeeded` row | when the booking was created; its status |
| 7 | **Paid on another booking** | `cancelled_by = 'system:duplicate-close'` | the paying booking's reference, parsed from `duplicate — paid on CH-…` (`duplicateBookings.ts:75`), linked to its own lookup |
| 8 | **Paid twice** | Two success notices (code 2) with different PayHere payment ids on the gateway row, **or** both the gateway and the manual row succeeded | both payment ids / methods; which one is on our books |
| 9 | **Money went back** | Any refund row other than `cancelled`, **or** a code -3 (chargeback) notice | refund state, amount of captured, who requested / confirmed, PayHere refund ref or message; chargeback date |

### 6.2 When several are true

Situations 8 > 9 > 1 > 2 > 7. If none of those apply, the unpaid situations follow the latest
evidence: 3, 4, 5 or 6.

Whatever wins, two lines are always added:
- **refunds**, if any exist;
- **the cancellation**, if the booking is cancelled: who and why (`cancelled_by`,
  `cancellation_reason`), or "who and why not recorded" when both are empty.

### 6.3 Mismatch warning

The page warns when the money evidence and `booking.status` disagree. Two cases:
- Money received (1, 2 or 8) while the booking is still `draft` or `payment_pending`, or money that
  settled after the booking was cancelled (`settled_at` later than `cancelled_at`). The webhook
  marks such a payment succeeded but leaves the booking alone and pages
  `paid_in_unexpected_status` (`webhooks.ts:376-387`).
  - A paid booking cancelled *before* the money arrived is not a mismatch. That is the normal
    cancel-then-refund order.
- The booking says `paid` or later with no succeeded payment row.

### 6.4 Incomplete

If any source fails to load (§7), there is **no verdict**. The line reads "Incomplete — couldn't
load <sources>", and the timeline shows what did load.

### 6.5 Counting

- **Checkouts** = `checkout/succeeded` rows. Each one is a PayHere form handed out
  (`bookings.ts:957-967`), not a visit to PayHere.
- **Decline notices** = `webhook/failed` rows with an empty reason. `payment_events` cannot count
  them: repeated declines on one booking share one stored row, because PayHere sends payment id
  `"0"` on every decline (owner's SQL, 2026-09-26).
  - The log also records a notice PayHere re-delivers, so the page says "decline notices", never
    "declines".
  - Before 2026-09-24 19:18 UTC neither count exists (§8).

## 7. Where the evidence comes from

| Source | Rows for this booking | Read with |
|---|---|---|
| `bookings` + `customers` | the booking; name, email, WhatsApp, country; billing; cancellation; status | `BookingRepo.findByReference` (**new**) |
| `payments` | at most one gateway row (`checkout:<id>`) and one manual row (`manual-paid:<id>`) (`bookings.ts:846-877`, `admin.ts:496-512`) | `PaymentRepo.findByBookingId`, plus `provenanceFor` (**new**). The `Payment` shape drops settlement details on purpose (`paymentRepo.ts:59-76`), and the page needs `created_at`, `settled_at`, `settlement_source`, `settled_by` and `gateway_payment_id` |
| `payment_events` | every signature-checked PayHere notice for those rows. The sanitized payload holds `status_message`, `method`, `payment_id` and `status_code`; card holder, number and expiry are never stored (`payhere.ts:42-54`) | `PaymentEventRepo.listForReconciliation` per payment. Needs **wiring**: the Postgres repo exists but is not constructed in `server.ts`; the in-memory one is built inside the settlement repo (`app.ts:175`) |
| `booking_checkout_event` | rows with this `booking_id`, **plus** rows with `order_id` = the reference. The second set catches rejected notices, which carry no booking id (`webhooks.ts:150-207`) | `listByBookingId`, plus `listByOrderId` (**new**) |
| `refunds` | every refund row | `RefundRepo.list`. Needs passing into the ops routes (`app.ts:518-525` omits it) |
| `notification_log` | which customer emails of each kind went out | `listByBookingId` (**new**) |
| `quotes` | the quote this booking came from, if any | `findByConvertedBookingId`; `findByReference` (**new**) for `Q-` input |

- **Loading:**
  - Resolve the booking first.
  - Then load every other source in parallel. Each source has its own `catch`, which adds it to
    `unavailable`.
  - That is two database round trips of latency, which matters at ~100 ms per round trip from
    Render (#703).
- **The header** reuses `toOpsRow` (`services/opsView.ts`), so the route, travel date, amount
  and test flag read exactly as they do in the queue.
  - The test flag is the `TEAM_EMAILS` rule (`services/testBookings.ts`). Webhooks, emails and
    logs treat test bookings like any other, so the flag is a label only.

### 7.1 Timeline rows

All rows are merged into one list, oldest first. Each shows local time to the second, with the
UTC timestamp on hover for matching against PayHere's dashboard and Clarity.

- **Booking** — created (once: when the checkout log has the create row, that row stands for it).
  Cancelled: who, why, when. Auto-closed as a duplicate.
- **Checkout log:**
  - Rows are worded with the drawer's existing labels (`paLabel` in `ops-ui.html`), so the drawer
    and this page never disagree.
  - `reason`, `attempt` and `http_status` are shown when present.
  - The raw user agent is shown under every row the customer's browser caused (everything except
    PayHere's webhook rows, whose user agent is PayHere's server). It is shown as stored, not
    parsed.
  - Webhook rows that were `settled`, `failed`, `dismissed` or `pending` are **not** listed: the
    `payment_events` row for the same notice carries more. The exception is when `payment_events`
    failed to load; then they are listed.
  - `refused` and `error` webhook rows **are** listed, because nothing else records them.
  - A row matched only by order id is labelled "claimed to be for this order", because a rejected
    notice's order id is untrusted.
- **Payments:**
  - The gateway row created: order id and amount.
  - Settled: when, and the source.
  - The manual row: method, who, reference.
- **PayHere notices** (`payment_events`):
  - The status in words, with the raw code, `status_message`, `method` and PayHere's payment id.
  - A second success on the same order is labelled "paid again".
  - A notice received after a later attempt had already captured the payment is labelled
    "earlier attempt" (the `stale_attempt` rule, `paymentSettlementRepo.ts:46-53`).
  - When the checkout log holds more decline notices than there are stored decline rows, the
    decline row says "PayHere sent N decline notices; repeats share this row".
- **Emails** (`notification_log`):
  - kind and time;
  - "delivery not tracked" on `payment_failed` and `deposit_received`, which are written whether
    or not the send worked (`webhooks.ts:236-248, 305-307`).
- **Refunds** — requested, sent to PayHere, confirmed, failed, cancelled. Each with who and
  amount, and PayHere's ref or message.

## 8. Gaps the page must name

A gap appears only when it affects this booking.

| Gap | Shown when | Wording (gist) |
|---|---|---|
| The checkout log starts 2026-09-24 19:18 UTC (promote #774, migration 0055) | booking created before then | "Checkout attempts before 24 Sep weren't recorded" |
| PayHere declines are stored per booking only from 2026-09-26 04:07 UTC (promote #793). Before that, every decline after the first on 2 Aug was dropped | booking created before then | "PayHere declines before 26 Sep may be missing" |
| Only the website checkout reports reaching PayHere (`booking.js`). Pay links and manage links never send `gateway` rows. A `return` row still proves the customer came back from PayHere | verdict 5 | "Pay links and manage links don't report opening PayHere" |
| Pay-link and ops-created bookings log no `create` row | the log starts at `checkout` | none; the timeline simply starts there |
| Who did it is recorded only for an ops cancel, a manual payment (from 0043), and refunds. The 24-hour shared-seat hold sweep cancels with no reason (`scheduler.ts:144-177`) | a cancellation with no `cancelled_by` | "Who and why not recorded" |
| `notification_log` keeps one row per email kind (the first send). Cancellation, refund and details-needed emails to the customer, and every team email, are not stored per booking | always, as a footnote | "Only some customer emails are recorded" |
| A 3-D Secure failure produces no PayHere notice at all (payment investigation, 2026-09-24) | verdict 4 | covered by verdict 4's wording |

## 9. API

`GET /admin/ops/cases/:ref`, in `routes/ops.ts`, `requireCap('payments:act')`.

The exact response shape (field names, enums, row kinds) is fixed in the implementation plan,
`docs/superpowers/plans/2026-09-26-ops-payment-lookup.md` §Contract; UI and API are both built to it.

- **Errors:** 404 `not_found` for an unknown ref, 400 for input that is neither `CH-` nor `Q-`,
  and no 500 for a single source failing (that source goes into `unavailable`).
- **Nothing that acts is returned:** no manage link, pay link or checkout token. No margin.
- **The logic is pure and separate from loading:**
  - `api/src/domain/paymentCase.ts` holds `paymentVerdict(evidence)`, `caseTimeline(evidence)`
    and `caseGaps(evidence)`.
  - `api/src/services/paymentCase.ts` loads the evidence and handles per-source failure.
  - The route stays thin.

## 10. UI (`api/src/routes/ops-ui.html`)

- **A `lookup` route that follows the `analytics` pattern:**
  - `routeStateFromUrl`, `syncUrl` and `setNav` gated on `payments:act`;
  - a `render()` branch with the same silent bounce;
  - a `viewLookup()` function.
- **Layout, top to bottom:** search box, header, verdict (plus warnings), timeline, gaps,
  unavailable sources.
  - Single column; it works at phone width.
  - WhatsApp uses the tool's existing `wa.me` link pattern.
- **Words live in the page, facts come from the API.** A small label map covers the new sources.
  Checkout rows use `paLabel`.
- **Every string goes through `esc()`.**
- The drawer gains one link. Nothing else in the drawer changes.

## 11. Tests (red first, per CLAUDE.md)

- **Pure verdict, Vitest:**
  - one case per situation 1-9;
  - precedence (paid twice + refund; chargeback on a paid booking);
  - a decline followed by a new checkout, which becomes 4 or 5, not 3;
  - a pay-link booking in `payment_pending` with no payment row, which becomes 6;
  - a pre-log booking with a pending payment row and no events, which becomes 5 plus the gap;
  - -1 read as 3, and 0 read as 4;
  - a `return` row with no `gateway` row, which becomes 4;
  - the duplicate-close reference parsed;
  - a manual row with no `settled_by`;
  - both mismatch warnings;
  - incomplete.
- **Timeline and gaps:**
  - ordering;
  - the notice/log de-duplication rule;
  - order-id rows labelled untrusted;
  - each gap's trigger.
- **Route:**
  - 401 without a session; 403 for `ops`; 200 for founder and finance;
  - 404 for an unknown ref; lower-case input; the `-MANUAL` suffix;
  - a draft found;
  - `Q-` to its booking, and `Q-` with no booking;
  - one source throwing, which produces `unavailable` and a null verdict.
- **Postgres repo tests** for the five new reads (run with `DATABASE_URL_TEST`).
- **web-tests:**
  - e2e: nav shown for founder and hidden for ops; open by ref; deep link survives reload; the
    drawer link opens the case.
  - unit: the label and verdict wording maps.
- **Gates:** `cd api && npm run check`, and `npm run test:all` in `web-tests/`.

## 12. Open PRs that change payment recording (read 2026-09-26)

The rules above hold whichever way these land:
- **#785** (a pending notice keeps the payment pending). The verdict reads code 0 as "no final
  answer" whatever `payments.status` says.
- **#794** (a decline is final only on the cancel leg; `return` rows record the leg in `reason`).
  `return` rows are never read as a decline, and the leg shows through `reason`.
- **#788** (a retry repairs a draft booking that has a payment row). `booking.status` is never
  payment evidence.

**File overlap:** none of them edits a file this slice changes.
- #794 and #788 edit `routes/bookings.ts`, and #785 edits the settlement repos and `webhooks.ts`.
  This slice only reads those.
- #785 also edits the shared `db/postgres.test.ts`, so this slice puts its Postgres tests in their
  own files (the `postgresBookingRepo.list.test.ts` pattern).

## 13. Later slices (not designed here)

- **Slice 2, the person:** every booking with the same `customers.person_key`, the quotes behind
  them, and "possibly the same person" by phone digits, never merged. This also lists the
  duplicates that a paid booking closed.
- **Slice 3, search** by email, phone or name.
- **Ops access:** decide the trimmed view (billing address and raw PayHere detail are the
  candidates to hide).
- **Ride-board seats. PayHere live status**, if a lookup call is ever added.

## 14. Needs the owner's sign-off (CLAUDE.md maintenance rules)

- **No migration, no pricing, no config, no generated files.**
- **Interfaces (hard rule 5):** read-only methods added to five repo interfaces:
  - `BookingRepo.findByReference`
  - `QuoteRepo.findByReference`
  - `NotificationLogRepo.listByBookingId`
  - `BookingCheckoutEventRepo.listByOrderId` — optional on the interface, because two test files
    type object-literal fakes against it and #794 edits one of them
  - `PaymentRepo.provenanceFor`

  Each is added to both the in-memory and Postgres versions. No existing method changes.
- **Wiring:**
  - `server.ts` constructs `PostgresPaymentEventRepo`.
  - `app.ts` shares one payment-event repo between settlement and the ops routes, and passes
    `refunds` into the ops routes.
- **Shared file:** `ops-ui.html` gets a new route plus one drawer link.
- **Rollout:** merge to `main` (staging auto-deploys, no migration), check it on staging with a
  staging booking, then promote with the owner's ok.
