# Deposits & Balance Payments — Design Spec

**Date:** 2026-07-23
**Status:** Approved design, build not started. Owner will green-light the build separately.
**Author:** Brainstormed with the owner (Roshen); all business rules below were explicitly confirmed.

---

## 1. Overview

Ceylon Hop today collects full payment on website bookings only. Ops quotes have **no way to collect money at all** (quote → cash happens off-system), and every booking is all-or-nothing. This feature:

1. **Closes the quote-to-cash gap** — a hosted, branded quote payment page linked from quote emails/WhatsApp. *This is the single most valuable deliverable and ships first.*
2. **Adds an optional deposit** on qualifying bookings (website + quote page), with automated balance collection before travel.
3. **Makes cancellation/refunds real** for partially and fully paid trips — policy-computed amounts, automated through PayHere where the amounts allow, auditable always.

Business context that shaped the design: most bookings are private transfers paid in full, so the full-payment path must stay byte-for-byte the fast default lane; the deposit machinery is an opt-in side path mostly serving chauffeur trips and large multi-leg transfers. Volume is low; a daily scheduled job is sufficient for all reminders.

## 2. Business rules (owner-confirmed)

| Rule | Value |
|---|---|
| Deposit amount | **max(10% of total, $50)**, capped at the trip total |
| Deposit eligibility | Private transfers & chauffeur trips with **total ≥ $150**. Shared rides always pay in full. |
| Presentation | "Pay in full" is the primary CTA everywhere; "Pay deposit" is a smaller, secondary choice — on both the website checkout and the hosted quote page |
| Balance collection | **Online card link only** (no cash-recording flow). Due before travel day. |
| Auto-cancel | **Never.** Unpaid balance near travel = ops chase flag, a human decides. |
| Refund policy (from terms.html) | Private point-to-point: 100% until 24h before departure, then 0. Chauffeur-guide: 100% >10 days before start, 80% within 10 days, 60% within 7 days, 40% within 2 days, 0% within 24h / no-show / after start. (Tiers read as bands: 7–10d → 80%, 2–7d → 60%, 24h–2d → 40%.) |
| Refund execution | Automated PayHere **per-payment full "undo"** when the policy amount equals whole payments; guided manual (system computes amount → ops keys it into the PayHere dashboard → confirms in-app) for partial chauffeur tiers. PayHere's own KB indicates full-only API refunds; partial-amount API support is unverified — do not depend on it. |
| Shortfall on partially paid late cancels | **Accepted business risk.** Refund = max(0, amount paid − policy retention). Never chase the customer for more. |
| Environments | Staging = PayHere **sandbox** (owner-confirmed); prod = approved live merchant account. Maps onto the existing `PAYHERE_MODE` / env-var adapter selection. |

## 3. Current state (verified 2026-07-23)

The deposit rails are ~80% scaffolded already:

- **PayHere adapter** fully built: `api/src/adapters/payhere.ts` (hosted-checkout hash + webhook md5sig verification, sandbox/live URLs), selected in `server.ts` when `PAYHERE_MERCHANT_ID`/`SECRET` set, else `FakePaymentAdapter`. Checkout endpoint `POST /bookings/:id/checkout` (bookings.ts) with status gates; webhook `POST /webhooks/payments` (webhooks.ts) is the settlement source of truth (idempotent, amount-reconciled, alert-on-failure).
- **Deposit math dormant**: `RATE_CARD.deposit` in `rateCard.ts` (currently `pct 10, capCents 5000` — **wrong shape, see §4**), `depositCents()` in `extrasDeposit.ts`, `bookings.amount_due_now` column, `balanceDueCents` projection, and `paidRows()` email rendering ("Deposit paid / Balance due") all exist. The engine hard-codes `amountDueNowCents = totalCents` (engine.ts, pricing.ts), and booking.js deposit messaging is explicitly disabled.
- **Emails**: merged to main via PR #131 — `sendDepositReceived` (dormant, awaiting a real partial deposit), `sendPaymentFailed`, `sendCustomerQuote`, concierge-letter shell, `/dev/emails` preview harness (non-prod only). Plus the 9 pre-existing customer emails in `notifications.ts`.
- **Scheduler**: daily GitHub-Actions cron → `POST /admin/jobs/notifications` → `runScheduledNotifications` (idempotent via `notificationLog`). `runWatchdog` sweeps stuck `payment_pending`. This is the exact pattern balance reminders copy.
- **Cancel/refund**: `POST /admin/ops/bookings/:id/{cancel,refund}` (admin.ts, `payments:act` capability = founder/finance humans only). Refund is a **pure status flip** — no gateway call, refund email always shows the full total, and seat-release/email failures are swallowed (`console.error` only). This feature fixes all three.
- **Statuses**: bookings `draft, payment_pending, awaiting_details, paid, confirmed, in_progress, completed, cancelled, refunded, no_show` with an enforced transition matrix (`domain/status.ts`). Quotes `draft … sent, won, lost, expired` (quoteRepo.ts).
- **Payments table**: one row per booking today; `orderId` unique = booking reference; statuses `pending|succeeded|failed`. No purpose concept, no gateway payment id stored.

## 4. Data model & status machine (migration 0015, additive)

### Bookings
- New status **`deposit_paid`**, between `payment_pending` and `paid`. New transitions:
  - `payment_pending → deposit_paid` (deposit webhook settles)
  - `deposit_paid → paid` (balance webhook settles)
  - `deposit_paid → cancelled` and `deposit_paid → refunded` (cancellation of a partially paid trip)
- Full payments keep today's exact path (`payment_pending → paid`); nothing downstream of `paid` changes.
- `amountDueNow` keeps its meaning: "what the next checkout charges". Set to the deposit only when the customer picks the deposit option; otherwise equals total. After deposit settles, it becomes the balance.
- New column **`payToken`** (random 128-bit urlsafe, unique, nullable): keys the customer balance-pay link. Generated on first need.
- Interaction with `awaiting_details` (paid-but-flexible-date): a deposit-paid flexible-date booking stays `deposit_paid`; the details-needed nudge must not assume `paid`. Handle in the same PR that activates deposits.

### Payments
- New column **`purpose`**: `'full' | 'deposit' | 'balance'`. Existing rows backfill to `'full'`.
- New column **`gatewayPaymentId`** (nullable): PayHere's `payment_id` captured from the webhook payload. **Required for refund API calls.** Also backfills nothing — historical rows stay null and are manual-refund-only.
- Order-ID scheme (PayHere `order_id`, our `payments.orderId`, stays unique): full = `REF` (today's format — existing rows remain valid), deposit = `REF-D`, balance = `REF-B`. The webhook already routes by orderId lookup, so purpose routing comes free.

### Refunds (new table)
`refunds`: `id, bookingId, paymentId, amountCents, currency, status ('pending'|'succeeded'|'failed'|'manual_pending'|'manual_confirmed'), gatewayRef, reason, policyBreakdownJson, createdBy, createdAt, updatedAt`.
One row per refund attempt against a specific payment — an audit trail, not a status flag. Failed API calls are visible records ops can retry. Manual refunds get `manual_pending` → ops confirms → `manual_confirmed`.

### Quotes
- New column **`payToken`** (random, unique, nullable): generated when the quote transitions to `sent`. The hosted quote page is keyed on it — never on the guessable quote reference.

### Rate card
`RATE_CARD.deposit` changes shape: `{ pct: 10, minCents: 5000, eligibleMinTotalCents: 15000, eligibleProducts: ['private', 'chauffeur'] }` (replacing the current `capCents` semantics — the old rule was min(10%, $50), the confirmed rule is **max(10%, $50) capped at total**). `depositCents()` in `extrasDeposit.ts` is rewritten accordingly + an `isDepositEligible(product, totalCents)` helper. Front-end mirror constants in `transfers-data.js` (`DEPOSIT_PCT`, `DEPOSIT_CAP`) update to match, and the existing front-end/back-end parity guard extends to cover them.

## 5. Payment flows

### 5.1 Website checkout (customer builds itinerary)
Step-3 payment screen gains a second, visually secondary option when `isDepositEligible`: primary button **"Pay $X now"**; below it, a quiet link-style option **"or reserve with a $Y deposit — balance due before travel"**. Choosing deposit sets `amountDueNow = deposit` on the draft booking (new optional field on the existing booking-create/checkout call, validated server-side against `depositCents` — the client never picks the amount). Everything downstream — checkout endpoint, PayHere popup, webhook — is the same code path charging a smaller amount with orderId `REF-D`.

- Webhook settles deposit → `payment_pending → deposit_paid` → **`sendDepositReceived`** (instead of full booking confirmation) → concierge task as today.
- Non-qualifying bookings render exactly today's UI. Zero change to the default lane.
- Demo mode (no API) keeps simulating full payment only; it never simulates deposits.

### 5.2 Hosted quote page (ops quote → cash)
- Quote → `sent` generates `payToken`; the quote email (`sendCustomerQuote`, needs its send-wiring completed — known follow-up from PR #131) and the ops WhatsApp snippet include `https://ceylonhop.com/quote.html?t=<token>`.
- **`quote.html`** (new static page, customer site): fetches `GET /pay/quote/:token` → renders branded itinerary from the quote's stored `resultJson` snapshot — **same understated line-item naming as the quote itself** (idle-day pricing stays deliberately quiet; never re-derive or expand the breakdown), price, rate-lock validity, and the primary/secondary pay buttons (deposit shown only if eligible).
- **`POST /pay/quote/:token/checkout { mode: 'full' | 'deposit' }`** → converts the quote to a real booking via the existing conversion seam (`convertedBookingId`), then reuses the standard checkout machinery. Idempotent: re-posting returns the same booking/checkout.
- Webhook settles → quote `sent → won`, booking `paid`/`deposit_paid`, emails fire.
- **Expired rate lock** (`rateLockedUntil` past): page renders a "this quote needs re-confirming" state pointing back to WhatsApp — never charges a stale price. Same for quotes no longer in `sent` (won/lost/expired → friendly terminal states).

### 5.3 Balance payment
- **`pay-balance` page** keyed on the booking `payToken` (prefer extending the existing `manage.html` retrieval surface over a new parallel page — decide at build time after reading manage.html's auth model): shows paid-so-far / remaining, one button paying exactly the balance.
- `POST /pay/balance/:token/checkout` → creatable **only** from `deposit_paid` (status gate); charges `total − sum(succeeded payments)`; orderId `REF-B`, purpose `balance`.
- Webhook settles → `deposit_paid → paid` → **payment-complete email** (see §6) → normal post-paid flow (confirmation, concierge).
- Double-charge safety: status gate + idempotent checkout key (`checkout:<bookingId>:balance`) + webhook idempotency (already present). A stale link on a paid/cancelled booking renders its state, never a pay button.

### 5.4 Webhook changes
`POST /webhooks/payments` routes by orderId as today, plus:
- captures `payment_id` → `payments.gatewayPaymentId`
- on settle, branches by `payments.purpose`: full → `paid` (today's path); deposit → `deposit_paid` + deposit email; balance → `paid` + payment-complete email
- amount reconciliation now checks against the *payment row's* amount (already the case — unchanged, just noting deposit/balance rows carry their own amounts)
- non-success on unsettled → `markFailed` + `sendPaymentFailed` (wire the PR #131 email here; today only the delayed watchdog nudge exists).

## 6. Emails

All in `api/src/services/notifications.ts`, previewable in `/dev/emails` (add fixtures for every new mode).

| Email | Status | Trigger |
|---|---|---|
| `sendDepositReceived` | exists (dormant) | deposit webhook settles. Already renders deposit/balance rows via `paidRows()`. Add the pay-balance link. |
| `sendPaymentFailed` | exists (unwired) | webhook non-success on unsettled payment (any purpose). Retry CTA links back to the right pay surface. |
| **`sendBalanceReminder`** | **new** | scheduler (§7). Paid-so-far / balance due / travel date / pay-balance link. Concierge-letter shell. |
| **payment-complete** | **new (or a `sendBookingConfirmation` variant)** | balance webhook settles. "You're fully paid" + full itinerary. Decide at build: variant flag on `sendBookingConfirmation` beats a tenth near-duplicate template. |
| `sendCustomerQuote` | exists (send-wiring incomplete) | quote → sent. Gains the quote-page pay link. Completing its send-wiring is part of Slice 1. |
| `sendRefundConfirmation` | exists (wrong for partials) | refund executed/confirmed. **Fix:** state the actual refunded amount (and retained amount when partial), sourced from the `refunds` row — never `booking.total`. |
| `sendCancellationConfirmation` | exists | unchanged, but partially-paid cancels must show real figures (reuse `paidRows`). |

**Prod dependency:** real customer sending still requires the verified Resend domain (open go-live item). Staging keeps the fake/test sender.

## 7. Balance reminders & ops chase (scheduler)

Extends `runScheduledNotifications` (daily cron, idempotent via `notificationLog`) — no new infrastructure.

- **Targets:** bookings in `deposit_paid` with a travel date.
- **Lead-time-aware cadence** (bookings are often made days, not months, ahead): reminder checkpoints at **7, 3, and 1 day(s) before travel**, with rules: (a) skip checkpoints already in the past at deposit time; (b) never send two reminders less than 24h apart; (c) max 3 total; (d) first reminder never fires on the deposit day itself (the deposit email already states the balance). Example: deposit paid 2 days before travel → exactly one reminder, on day-1. Idempotency keys: `balance_reminder_7d/3d/1d` in `notificationLog`.
- **Ops chase flag:** booking still `deposit_paid` on travel-day morning (or with all reminders exhausted) → surfaces in the ops dashboard attention system (existing hot-zone/attention-chip patterns) as "balance outstanding — travels <date>", plus a line in the daily ops digest. **No auto-cancel, ever.**

## 8. Cancellation & refunds

### 8.1 Policy calculator (pure, unit-tested to death)
`refundQuote(booking, payments, now)` → `{ retainedCents, refundableCents, band, breakdown }`:
- Private point-to-point: >24h before departure → retain 0; else retain everything.
- Chauffeur: bands per §2 against the trip **start date**.
- `refundableCents = max(0, sumSucceededPayments − retainedCents)` — the accepted-risk rule; never negative, never chases.
- Multi-day chauffeur "travel time" = start of day 1. Timezone: Sri Lanka (Asia/Colombo) — same convention the scheduler uses for travel dates.

### 8.2 Refund planner
Given `refundableCents` and the booking's succeeded payments (each individually refundable-in-full via API):
- Find a subset of whole payments summing exactly to `refundableCents` → **automated plan**: one PayHere refund API call per payment (deposit `REF-D` and balance `REF-B` being separate payments is what makes 100%-refund cases fully automatic, including partially-paid trips where the whole deposit comes back).
- No exact subset (the chauffeur 80/60/40 tiers on paid-up trips) → **manual plan**: system shows the exact figure, ops keys it into the PayHere dashboard, then confirms in-app → `refunds` row `manual_pending → manual_confirmed` → email.

### 8.3 PayHere refund adapter
- Extend the payment adapter interface with `refundPayment(gatewayPaymentId, reason)`; PayHere impl uses the **Merchant API**: OAuth2 client-credentials token from new env vars **`PAYHERE_APP_ID` / `PAYHERE_APP_SECRET`** (a "Business App" created in the PayHere portal — owner action required for prod; sandbox portal supports it for staging), then the refund endpoint. `FakePaymentAdapter` gets a matching fake for tests/staging-without-creds.
- **Unverified externally** (docs are behind bot protection): exact endpoint shape and whether an amount parameter exists/works. Verify against sandbox during Slice 4 before relying on anything beyond full-payment refunds. The planner already assumes full-only; if partial-amount refunds turn out to work, the manual tier collapses later without redesign.
- Failure handling: API failure → `refunds.status = 'failed'` + ops alert (existing `alertLog` pattern) + visible retry in ops. **Never** flip the booking to `refunded` unless every planned refund row succeeded/was confirmed.

### 8.4 Ops flow & fixes
- Cancel action shows the refund quote (band, retained, refundable) **before** confirming. Cancel and refund remain separate steps (cancel now, refund executes/confirms after), matching the existing two-endpoint shape.
- `payments:act` capability (founder/finance humans) gates refund execution, as today.
- **Fix the swallow gaps** in `admin.ts` `transitionAndNotify`: seat-release and customer-email failures now raise ops alerts instead of `console.error` only.

## 9. Ops dashboard surfacing

- Booking payment state at a glance: chip for `Paid in full` / `Deposit paid — $X due` / `Balance overdue` (overdue = travel within 48h and still `deposit_paid`).
- Attention system: chase flags per §7.
- Refund UI: refund-quote display, automated-plan progress, manual-confirm step with the computed figure and a copyable amount.
- Quote list: show quote-page link + whether the customer has opened/paid (paid = `won`, existing).

## 10. Security & correctness invariants

- Tokens: 128-bit random, urlsafe, single-purpose (quote-pay vs balance-pay), unique-indexed; pages keyed only on tokens, never enumerable references. Tokens in URLs shared over WhatsApp is accepted (transport is E2E-encrypted; links die when the quote/booking leaves the payable state).
- The client never chooses amounts — deposit and balance amounts are always computed server-side; checkout validates mode/eligibility server-side.
- Status gates: deposit checkout only from `draft`/`payment_pending` with eligibility; balance checkout only from `deposit_paid`; everything else 409s (extends the existing gate).
- Webhook remains the only settlement authority; amount/currency reconciliation per payment row; signature verification unchanged.
- Money stays integer USD cents end-to-end (existing convention). FX drift on LKR settlement/refund is absorbed by the business (low volume, owner-accepted implicitly via PayHere choice).

## 11. Testing

- **Unit:** `depositCents` (min/cap/eligibility boundary table: $149.99, $150, $500, $30 trip), `refundQuote` (every band × private/chauffeur × full/partial payment, boundary hours, Asia/Colombo edges), refund planner subset logic, reminder cadence (lead-time matrix incl. same-day booking).
- **Route (Vitest, in-memory repos):** deposit checkout gating + amount authority, quote-token endpoints (expired lock, wrong status, idempotent convert), balance checkout gates + double-charge, webhook purpose routing (deposit/balance/full × success/failure), refund endpoints (auto plan, manual confirm, API-failure alerting).
- **E2E (Playwright, `web-tests/e2e/`):** deposit option visibility rules on checkout, deposit pay path (fake adapter), quote page render/pay/expired states, balance page pay + stale-link states. Reuse `_stubs.js` patterns; **date rules:** `nextIsoWeekday`/`futureIsoDate` helpers only, never literal dates.
- **Email fixtures:** every new email × modes in `/dev/emails` sample fixtures.
- Existing full-payment specs must pass untouched — they are the regression guard for the default lane.

## 12. Build sequencing (value-ordered slices, each its own PR chain, staging-soaked)

- **Slice 1 — Quote → cash (highest value):** quote `payToken`, `quote.html` + `GET/POST /pay/quote/:token*`, quote→booking conversion, `sendCustomerQuote` send-wiring, ops link surfacing. **Full payment only.** Migration 0015 ships here (all columns/tables at once; later slices activate them).
- **Slice 2 — Deposit option:** rate-card reshape + `depositCents` + parity guard, website checkout secondary option, quote-page deposit button, `deposit_paid` status + webhook branching, `sendDepositReceived` activation, `sendPaymentFailed` wiring, `awaiting_details` interaction.
- **Slice 3 — Balance collection:** balance page/endpoint, `sendBalanceReminder` + scheduler cadence, payment-complete email, ops chips + chase flags + digest line.
- **Slice 4 — Cancellation & refunds:** policy calculator, planner, PayHere Merchant-API adapter (+ sandbox verification of the API's actual shape), refunds table wiring, ops refund UI, swallow-gap fixes, partial-aware refund emails.

Each slice is independently shippable and leaves prod coherent. Prod promotion of Slices 1–3 additionally gated on go-live items: verified email domain (for real sends), PayHere apex-domain approval; Slice 4 needs the live Business-App credentials.

## 13. Open items (deliberately deferred to build time)

1. `manage.html` reuse vs. a dedicated balance page — read its auth model first (§5.3).
2. Payment-complete email: variant of `sendBookingConfirmation` vs. new template (§6).
3. PayHere Merchant API exact shape (endpoint, partial-amount support) — verify on sandbox in Slice 4 (§8.3).
4. Exact reminder/quote-page copy — draft in-slice, owner eyeballs on staging.
5. Whether the quote page needs an explicit "quote opened" signal for ops (nice-to-have; not in any slice yet).

## 14. Out of scope (owner-confirmed)

- Auto-cancelling unpaid bookings (never).
- Recording cash / bank-transfer payments.
- Deposits on shared rides.
- Chasing shortfalls beyond what was paid.
- PayHere API automation of partial-amount refunds (unless sandbox verification proves it trivial).
- Changing the published cancellation policy in terms.html.
