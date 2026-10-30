# Pay on the day (cash to driver) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ops can mark a WhatsApp quote booked as **"pay on the day"** — the booking is genuinely
*confirmed* (reminders, trip stages, no-show all work) while every money fact (owed, paid, "Paid"
labels) comes from the payments ledger, so nothing claims money that hasn't arrived. Plus: the
Mark booked modal pre-fills from what the customer typed on the pay page.

**Architecture:** *Status describes the trip; the payments ledger describes the money.* A new
nullable `bookings.payment_arrangement` (`'on_the_day'`) is the only thing that allows the new
`payment_pending → confirmed` edge, and the state machine itself enforces that (so the fulfilment
mirror in `ops.ts` can't move an ordinary unpaid booking to confirmed). Every place that today
infers money from status is switched to the ledger (`paidCents`). Cash is recorded with the
existing Mark paid → Cash, now allowed on a confirmed/in-progress/completed pay-on-the-day booking
without moving its status.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Vitest · Drizzle + Postgres · ops UI is
plain JS in `api/src/routes/ops-ui.html` · web-tests (vitest + Playwright).

## Global Constraints

- Owner decisions (2026-10-29): **USD cash** to the driver; the confirmation email **sends automatically**.
- Money = integer minor units + ISO currency (`USD`). IDs = uuid.
- Allowed `payment_arrangement` values: **`'on_the_day'` only** (no `invoice` until someone needs it — widening the CHECK is a one-line migration).
- Never infer "money taken" from booking status in new code — read the ledger (`paidCents` in `api/src/domain/balance.ts`).
- Migrations are hand-written; journal entry needs idx 77 and `when` > 1792368000000 (use 1792454400000). **Merging a migration is its release** (auto-applies on Render boot: staging on merge to `main`, prod on promote). Owner OK required before merging PR 1.
- Gate before every commit: `cd api && npm run check` and `cd web-tests && npm run test:all` (needs `DATABASE_URL_TEST` for the API gate; run `npm run stamp` at repo root after editing any root asset).
- Stage files by path only; never `git add -A`. Work in the worktree `wt-pay-later`, branch per PR off `main`.
- One PR per task group below; each PR leaves `main` green on its own.

## Verified facts this plan rests on (origin/main 169020a9)

| Fact | Where |
|---|---|
| `payment_pending → [paid, awaiting_details, cancelled]` only; `confirmed` only from `paid` | `api/src/domain/status.ts:17-28` |
| Both repos enforce via `assertTransition(from, to)` | `bookingRepo.ts:570` (in-memory), `postgresBookingRepo.ts:80` (`applyBookingStatusTransition`) |
| Fulfilment stage `vehicle_confirmed` mirrors to booking `confirmed` whenever `canTransition` allows | `api/src/routes/ops.ts:97-136` |
| `balanceDueCents` returns 0 for a secured booking with no payment | `api/src/domain/balance.ts:20-23` |
| Trip reminder always shows a **Paid** badge; sent for `paid`/`confirmed` | `notifications.ts:766`, `scheduler.ts:176` |
| Mark paid only from `payment_pending`; then `setStatus('paid')` | `routes/admin.ts:541-600` |
| Tracking flags any succeeded non-`balance` payment without a `→ paid` status event | `services/bookingTracking.ts:238-265` |
| Payment lookup warns `paid_status_without_payment` for confirmed+ with no money | `domain/paymentCase.ts:107,219` |
| Team emails print "Paid" from `amountDueNow`/status, not the ledger | `services/opsNotifications.ts:333, 586-598` |
| No-show email says "the fare isn't refundable" | `notifications.ts:1057-1075` |
| Ops stage for a non-pending booking = fulfilment status, labelled "Paid" by default; Mark paid only shown at `awaiting_payment` | `opsView.ts:107-114`, `ops-ui.html:2139, 4333` |
| `sendBookingConfirmed` (BADGE_CONFIRMED, no money rows) exists but is unused in prod | `notifications.ts:1017`, `devEmails.ts:96` |
| Customer email kinds are a SQL CHECK + TS unions | `schema.ts:670`, `adapters/email.ts:10-25`, `trackingContract.ts:9-25`, `notifications.ts:39-55` |
| Mark booked modal pre-fills from the quote only; booking (with customer + billing) is at `GET /admin/ops/bookings/:id` | `ops-ui.html:11743-11773`, `ops.ts:325-420` |

## Out of scope (surfaced, not fixed here)

- **Existing bug:** a quote marked booked without payment shows "Paid $total" on the customer's pay link (`quotePay.ts:224-226, 328`). Fixed here **only** for pay-on-the-day bookings (Task 5.1); the plain case is a separate fix.
- Analytics "cash to collect" tile, digest "confirmed, cash due" line, promo-hold expiry on pay-later, watchdog `paidDuplicateOf` wording, card payment after confirmation.

## PR order and dependencies

| PR | Contents | Depends on | Release risk |
|---|---|---|---|
| **0** | Modal pre-fill from the pay-attempt booking (UI only) | — | none (can ship first, independently) |
| **1** | Migration 0077 + domain: `paymentArrangement` field, gated transition | — | **migration — owner OK** |
| **2** | Money reads the ledger + guard test + Mark paid on confirmed | 1 | money paths — tests |
| **3** | Mark booked → pay on the day (API) + emails | 1, 2 | customer email |
| **4** | Ops UI: checkbox, labels, Record cash collected | 3 | UI |
| **5** | Customer pay link + manage page for pay-on-the-day | 2, 3 | customer page |

---

## PR 0 — Pre-fill the Mark booked modal

### Task 0.1: Fetch the converted booking and pre-fill

**Files:**
- Modify: `api/src/routes/ops-ui.html` — `renderBookModal` (~11743), the `markWon` handler (~12865)
- Test: `web-tests/unit/ops-book-prefill.test.js` (new), `web-tests/e2e/ops-book-error-message.spec.js` (extend)

**Interfaces:**
- Produces: `bookPrefill(state, booking)` — pure function in ops-ui.html returning
  `{ first, last, email, whatsapp, country, date }`.

- [ ] **Step 1: Write the failing unit test** (pattern: `web-tests/unit/ops-book-error-text.test.js`)

```js
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
const html = readFileSync(new URL('../../api/src/routes/ops-ui.html', import.meta.url), 'utf8');
const m = html.match(/function bookPrefill\(st, booking\) \{[\s\S]*?\n\}/);
const bookPrefill = new Function('isValidEmail', 'isValidPhone', 'return (' + m[0] + ')')(
  (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s), (s) => /^\+?[\d\s-]{7,}$/.test(s));

const st = { firstName: 'Sandy', lastName: '', contact: '+49 1515 642 4312', legs: [{ date: '2026-11-28' }] };
const booking = { input: { customer: { firstName: 'Sandy', lastName: 'Schwarz', email: 'sandy@ts-schwarz.de',
  whatsapp: '+4915156424312', country: 'Germany' } } };

describe('bookPrefill', () => {
  it('prefers what the customer typed on the pay page', () => {
    expect(bookPrefill(st, booking)).toEqual({ first: 'Sandy', last: 'Schwarz', email: 'sandy@ts-schwarz.de',
      whatsapp: '+4915156424312', country: 'Germany', date: '2026-11-28' });
  });
  it('falls back to the quote when there is no booking', () => {
    expect(bookPrefill(st, null)).toEqual({ first: 'Sandy', last: '', email: '',
      whatsapp: '+49 1515 642 4312', country: '', date: '2026-11-28' });
  });
  it('never blanks a quote value with an empty booking value', () => {
    const b = { input: { customer: { firstName: '', lastName: 'Schwarz', email: '', whatsapp: '', country: '' } } };
    expect(bookPrefill(st, b).first).toBe('Sandy');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`m` is null): `cd web-tests && npx vitest run unit/ops-book-prefill.test.js`

- [ ] **Step 3: Implement** — add next to `renderBookModal`:

```js
// What the modal opens with. The customer's own pay-page entry (the converted booking) wins over
// the quote's single contact box; a blank on either side never overwrites a value (2026-10-29).
function bookPrefill(st, booking) {
  var c = (booking && booking.input && booking.input.customer) || {};
  var contact = (st.contact || '').trim();
  function pick(a, b) { return (a && String(a).trim()) || b || ''; }
  return {
    first: pick(c.firstName, st.firstName),
    last: pick(c.lastName, st.lastName),
    email: pick(c.email, isValidEmail(contact) ? contact : ''),
    whatsapp: pick(c.whatsapp, isValidPhone(contact) ? contact : ''),
    country: pick(c.country, ''),
    date: (st.legs[0] && st.legs[0].date) || '',
  };
}
```

Change `renderBookModal()` to read `var p = bookPrefill(state, bookPrefillBooking);` and use
`p.first/p.last/p.email/p.whatsapp/p.country/p.date` as the input values. Add
`var bookPrefillBooking = null;` beside `bookOpen` (~5401). In the `markWon` handler, before
`bookOpen = true; render()`:

```js
bookPrefillBooking = null;
if (state.convertedBookingId) {
  try {
    var r = await api('/admin/ops/bookings/' + encodeURIComponent(state.convertedBookingId));
    var body = r.ok ? await jsonOrNull(r) : null;
    bookPrefillBooking = body && body.booking ? body.booking : null;
  } catch (e) { bookPrefillBooking = null; } // pre-fill is a convenience; never block the modal
}
```

- [ ] **Step 4: Run unit test — expect PASS.** Extend `ops-book-error-message.spec.js` with a case that stubs `**/admin/ops/bookings/b1` returning the Sandy booking, sets `convertedBookingId: 'b1'` on the stubbed quote, opens Mark booked, and asserts `#bk-last` = `Schwarz`, `#bk-country` = `Germany`. Run `cd web-tests && npm run test:all`.
- [ ] **Step 5: Verify in the browser preview**, then commit:

```bash
git add api/src/routes/ops-ui.html web-tests/unit/ops-book-prefill.test.js web-tests/e2e/ops-book-error-message.spec.js
git commit -m "feat(ops): pre-fill Mark booked from the customer's pay-page details"
```

---

## PR 1 — Migration + the gated transition  ⚠️ migration, owner OK before merge

### Task 1.1: Migration 0077

**Files:**
- Create: `api/drizzle/0077_booking_payment_arrangement.sql`
- Modify: `api/drizzle/meta/_journal.json`, `api/src/db/schema.ts` (bookings ~82-100, customer_communications ~670)
- Test: `api/src/db/paymentArrangementMigration.test.ts` (pattern: `detailsReminderMigration.test.ts`, `tripGapsMigration.test.ts`)

- [ ] **Step 1: Write the failing migration test** asserting: the SQL adds `payment_arrangement text` nullable with no default; adds CHECK `bookings_payment_arrangement_valid` `(payment_arrangement is null or payment_arrangement in ('on_the_day'))`; recreates `customer_communications_kind_valid` with **every existing kind** (copy the list from `schema.ts:670`) **plus** `'pay_on_day_confirmed'`; contains no DML/DROP TABLE; journal entry tag `0077_booking_payment_arrangement`, idx 77, `when` 1792454400000 > previous max. Under `describe.skipIf(!process.env.DATABASE_URL_TEST)`: migrate, insert a booking with `'on_the_day'` (ok) and `'later'` (rejects).
- [ ] **Step 2: Run — expect FAIL** (file missing): `cd api && npx vitest run src/db/paymentArrangementMigration.test.ts`
- [ ] **Step 3: Write the migration**

```sql
-- 0077 — Pay on the day (2026-10-29). How the customer will pay when it isn't "now, by card".
-- Null = the normal flow (every existing row). 'on_the_day' = cash to the driver (USD); the only
-- thing that lets a booking go payment_pending → confirmed without a payment (domain/status.ts).
-- Hand-written: drizzle-kit generate needs a TTY. Rollback: drop the column + constraint, restore
-- the previous customer_communications_kind_valid list.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "payment_arrangement" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_payment_arrangement_valid') THEN
    ALTER TABLE "bookings" ADD CONSTRAINT bookings_payment_arrangement_valid
      CHECK (payment_arrangement IS NULL OR payment_arrangement IN ('on_the_day'));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "customer_communications" DROP CONSTRAINT IF EXISTS "customer_communications_kind_valid";
--> statement-breakpoint
ALTER TABLE "customer_communications" ADD CONSTRAINT "customer_communications_kind_valid"
  CHECK ("kind" in ('confirmation', 'details_needed', 'booking_confirmed', 'cancellation', 'refund',
    'no_show_notice', 'trip_reminder', 'review_request', 'payment_recovery', 'payment_failed',
    'deposit_received', 'balance_received', 'schedule_set', 'details_reminder_1', 'details_reminder_2',
    'pay_on_day_confirmed'));
```

(List copied from `schema.ts:670` at 169020a9 — re-check it hasn't grown before writing; the test enforces every existing kind is kept.) Journal:
`{ "idx": 77, "version": "7", "when": 1792454400000, "tag": "0077_booking_payment_arrangement", "breakpoints": true }`.
schema.ts: `paymentArrangement: text('payment_arrangement'),` + the CHECK + the kind added to the list.

- [ ] **Step 4: Run — expect PASS** (incl. `DATABASE_URL_TEST` block). **Step 5: Commit** (paths only).

### Task 1.2: `paymentArrangement` on the Booking + repos

**Files:** `api/src/db/bookingRepo.ts` (NewBooking variants ~46-94, Booking ~97, in-memory insert ~516), `api/src/db/postgresBookingRepo.ts` (build ~213, create ~480), new repo method `setPaymentArrangement`.

**Interfaces — Produces:**
- `type PaymentArrangement = 'on_the_day'` (export from `api/src/domain/paymentMethod.ts`) and `PAYMENT_ARRANGEMENTS = ['on_the_day'] as const`.
- `Booking.paymentArrangement: PaymentArrangement | null`
- `BookingRepo.setPaymentArrangement(id: string, value: PaymentArrangement): Promise<Booking>` — only while status ∈ `PAYER_EDITABLE_STATUSES` (`draft`, `payment_pending`); otherwise throws `IllegalTransitionError`-style `PaymentArrangementLockedError`.

- [ ] Steps (TDD): test in `bookingRepo.test.ts` (in-memory) and the Postgres repo test (skipIf no `DATABASE_URL_TEST`): new booking → `paymentArrangement === null`; `setPaymentArrangement` on payment_pending → `'on_the_day'`; on `paid` → throws. Implement (map `row.paymentArrangement`; guarded `UPDATE … WHERE id = $1 AND status IN ('draft','payment_pending') RETURNING`). Run `npm run check`. Commit.

### Task 1.3: The gated `payment_pending → confirmed` edge

**Files:** `api/src/domain/status.ts`, `status.test.ts`, both repos' `setStatus`, `api/src/routes/ops.ts` (`mirrorToBooking` ~125).

**Interfaces — Produces:**
- `canTransition(from, to, ctx?: { paymentArrangement?: string | null }): boolean`
- `assertTransition(from, to, ctx?)` — same ctx.

- [ ] **Step 1: Failing tests** in `status.test.ts`:

```ts
it('pay-on-the-day bookings may be confirmed without payment', () => {
  expect(canTransition('payment_pending', 'confirmed', { paymentArrangement: 'on_the_day' })).toBe(true);
});
it('an ordinary unpaid booking may NOT be confirmed', () => {
  expect(canTransition('payment_pending', 'confirmed')).toBe(false);
  expect(canTransition('payment_pending', 'confirmed', { paymentArrangement: null })).toBe(false);
});
it('the arrangement opens no other edge', () => {
  for (const to of ['in_progress', 'completed', 'no_show'] as const)
    expect(canTransition('payment_pending', to, { paymentArrangement: 'on_the_day' })).toBe(false);
});
```

And a route test in `api/src/routes/ops.test.ts`: setting fulfilment stage `vehicle_confirmed` on a plain `payment_pending` booking leaves its status `payment_pending` (regression guard for the mirror); on an `on_the_day` one it becomes `confirmed`.

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement**:

```ts
// Edges that exist only for a booking whose money is arranged for later (0077). Kept apart from
// ALLOWED so the ordinary lifecycle stays exactly as it was: status is the trip, the ledger is the money.
const ARRANGED: Partial<Record<BookingStatus, BookingStatus[]>> = { payment_pending: ['confirmed'] };

export function canTransition(from: BookingStatus, to: BookingStatus, ctx?: { paymentArrangement?: string | null }): boolean {
  if (ALLOWED[from].includes(to)) return true;
  return !!ctx?.paymentArrangement && (ARRANGED[from] ?? []).includes(to);
}
export function assertTransition(from: BookingStatus, to: BookingStatus, ctx?: { paymentArrangement?: string | null }): void {
  if (!canTransition(from, to, ctx)) throw new IllegalTransitionError(from, to);
}
```

Both repos pass `{ paymentArrangement: current.paymentArrangement }` (Postgres: read it in the same row select inside `applyBookingStatusTransition`). `mirrorToBooking` passes `{ paymentArrangement: booking.paymentArrangement }`.

- [ ] **Step 4: PASS + `npm run check`.** **Step 5: Commit.** Open PR 1 — PR body flags **"Migration 0077: merging releases it to staging; prod on promote."**

---

## PR 2 — Money reads the ledger

Every task: failing test first, then the fix, `npm run check`, commit.

### Task 2.1: `balanceDueCents` for pay-on-the-day

**File:** `api/src/domain/balance.ts`; test `balance.test.ts`.

```ts
// Pay on the day (0077): the trip goes ahead before any money, so owed = total − ledger, even once
// the trip is over (the driver may hold the cash before ops records it). Cancelled/no-show owe nothing.
if (booking.paymentArrangement && booking.status !== 'cancelled' && booking.status !== 'refunded' && booking.status !== 'no_show') {
  return Math.max(0, booking.total - paidCents(payments));
}
```

(placed first in `balanceDueCents`; add `paymentArrangement?: string | null` to `BookingLike`.)
Tests: confirmed + on_the_day + no payments → `total`; + cash payment of total → 0; completed + no payment → `total`; cancelled → 0; existing deposit tests unchanged.

### Task 2.2: Payment lookup — no false "paid without payment"

**File:** `api/src/domain/paymentCase.ts:219`. Skip `paid_status_without_payment` when the booking has a `paymentArrangement`; instead push `'cash_due_on_the_day'` when `!moneyIn`. Add the copy for it next to `ops-ui.html:3513`: *"Pay on the day — $X cash due to the driver; record it with Mark paid when collected."* Test in `paymentCase.test.ts`.

### Task 2.3: Tracking reconciliation accepts cash recorded after confirmation

**File:** `api/src/services/bookingTracking.ts:238-265`. A succeeded payment with `settlementSource === 'manual'` on a booking with `paymentArrangement` does not require a `→ paid` status event. Test: such a booking reports no `captured_payment_missing_transition`; an ordinary booking still does.

### Task 2.4: Team emails print the ledger

**File:** `api/src/services/opsNotifications.ts:333, 586-598` + callers (`admin.ts:208` cancel route, `bookings.ts:1102` schedule-set, refund, paid). Replace the `paidNow`/`UNPAID_STATUSES` inference with a `paidCents: number` argument computed from `deps.payments.findByBookingId`. Tests: cancelling a confirmed on_the_day booking with no payment → team email has no "Paid" row and no "Refund" line; with cash recorded → "Paid $342".

### Task 2.5: Mark paid on a confirmed pay-on-the-day booking

**File:** `api/src/routes/admin.ts:541-600`; tests in `admin.test.ts` (`makeCashApp`).

- Allowed when `status === 'payment_pending'` **or** (`booking.paymentArrangement` and status ∈ `confirmed | in_progress | completed`). Otherwise `400 not_awaiting_payment` (unchanged).
- Short-circuit (`:541`) becomes: `recorded && booking.status !== 'payment_pending'`.
- `setStatus('paid')` runs **only** when status is `payment_pending`.
- Ledger guard `already_paid` unchanged (blocks double collection). GA4 + `claimWonQuote` unchanged.
- Tests: confirmed on_the_day → 200, status stays `confirmed`, one succeeded `cash` payment, `balanceDueCents` 0; double-click → one payment; plain `confirmed` (no arrangement) → 400; `email.sent` length 0.

### Task 2.6: Guard test — no new money-from-status

**File:** create `api/src/domain/moneyFromStatusArchitecture.test.ts` (pattern: `bookingStatusWriterArchitecture.test.ts`). Scan `api/src/**/*.ts` (not tests) for status comparisons against `'paid'` and status-set constants containing `'paid'`; fail unless the `file:line-pattern` is in an allowlist **each with a one-line reason** (e.g. `status.ts` — the state machine itself; `SCHEDULE_EDITABLE_STATUSES` — not money). New code that infers money from status fails CI with a message pointing at `paidCents`.

Open PR 2.

---

## PR 3 — Mark booked → pay on the day, and the emails

### Task 3.1: `POST /admin/quote/:id/book` accepts `paymentArrangement`

**File:** `api/src/routes/internalQuote.ts` (`BookingDetailsSchema` ~151, route ~1101-1250); tests `internalQuote.test.ts` (`describe` ~1696, helpers `book`, `BODY`, `sentQuote`).

- Schema: `paymentArrangement: z.enum(PAYMENT_ARRANGEMENTS).optional()`.
- New booking path: after `payment_pending`, if `paymentArrangement` → `setPaymentArrangement` then `setStatus(id, 'confirmed', undefined, { source: 'quote_conversion', actorType: 'staff', actorId, requestId, reason: 'pay_on_the_day', relatedEntityType: 'quote', relatedEntityId: quote.id })`.
- Re-book path (the customer's own pay-attempt booking, e.g. Sandy's CH-D9GR2): same two steps after `refreshPayerDetails`, only if `prior.status === 'payment_pending'`.
- Then `claimWonQuote`-equivalent patch already happens (quote → won). Send the email (Task 3.2) via the notification log claim `'pay_on_day_confirmed'` so a retry never sends twice.
- Tests: with `paymentArrangement:'on_the_day'` → 201, `status:'confirmed'`, `paymentArrangement:'on_the_day'`, no payment rows, status events `[→payment_pending, →confirmed reason pay_on_the_day]`, one email; re-book of a prior payment_pending booking → same; retry → still one email; without the field → unchanged behaviour (`payment_pending`, no email).

### Task 3.2: The "You're confirmed — pay on the day" email

**Files:** `api/src/services/notifications.ts` (new `sendPayOnDayConfirmed`), `adapters/email.ts` kind union, `domain/trackingContract.ts` + its test, `notifications.ts` `trackingDefaults` (`{ templateKey: 'booking-pay-on-day', source: 'quote_conversion', actorType: 'staff' }`), `db/notificationLogRepo.ts` kind union, `routes/devEmails.ts` preview entry. Test `notifications.test.ts`.

Built from `sendBookingConfirmed` (BADGE_CONFIRMED, `ticketCard`, `infoBox`, `cancellationPolicy`, manage button). Subject: `You're confirmed — ${reference}`. Money via `totalBlock('To pay on the day', money(total))` and the line **"Please pay $342.00 in US dollars, cash, to your driver at pickup."** Must **not** contain "paid"/"Total paid". Tests assert html + text contain `To pay on the day`, `$342.00`, `US dollars`, and do not match `/paid/i`.

### Task 3.3: Trip reminder — badge and cash line from the ledger

**Files:** `notifications.ts:750` `sendTripReminder(booking, email, links, opts?: { cashDueCents?: number })`; `scheduler.ts:176` computes `cashDueCents = balanceDueCents(b, payments)` when `b.paymentArrangement` (payments already loaded at `:142`). Badge: `BADGE_CONFIRMED` + "Have $X in US dollars cash ready for your driver" when `cashDueCents > 0`; `BADGE_PAID` otherwise. Tests: on_the_day unpaid → no "Paid", has cash line; paid booking → unchanged.

### Task 3.4: No-show notice wording

**File:** `notifications.ts:1057`. When `booking.paymentArrangement` and nothing was paid, drop "the fare isn't refundable"; say the booking is closed as a no-show. Caller passes `paidCents`. Test both variants.

Open PR 3.

---

## PR 4 — Ops UI

### Task 4.1: Row carries the arrangement and cash due

**File:** `api/src/services/opsView.ts` (`toOpsRow` ~106-130). Add `paymentArrangement` and `cashDueCents` (= `balanceCents` when arrangement set). Stage logic unchanged. Test `opsView.test.ts`.

### Task 4.2: Labels, reason, Record cash collected

**File:** `api/src/routes/ops-ui.html`. Tests: `web-tests/unit/ops-booking-views.test.js`, `api/src/routes/opsUi.balance.test.ts` (`reason()` table), e2e `ops-mark-paid.spec.js` (extend).

- `stageLabel(t)`: when `t.paymentArrangement && !t.paid` and stage is `paid`, label **"Confirmed · cash due"** (drawer header pill, queue pill, pipeline step 2161/2359/2621/4165/4314).
- `reason(t)`: `t.cashDueCents>0 && t.date===TODAY` → **"Collect $X cash — travels today"**; before that date → **"Cash on the day — $X"**.
- Drawer: show the Mark paid row (`#paidmethod` + button) when `isPending || (t.paymentArrangement && !t.paid)`, button text **"Record cash collected"** in the latter case; confirm copy "Record $X received in cash. Status stays as it is."
- Payment section note (4426): for pay-on-the-day, "Pay on the day — $X USD cash to the driver" instead of the pay-link text.
- No-show confirm copy (4887): drop "isn't refundable" when nothing was paid.

### Task 4.3: Mark booked modal — "Customer pays cash on the day" checkbox

**File:** `ops-ui.html` `renderBookModal`, `bookQuote` (send `paymentArrangement: 'on_the_day'` when ticked), success toast "Booked — confirmed, cash on the day; confirmation emailed". e2e: tick → request body carries the field.

Verify in the browser preview (screenshot to owner). Open PR 4.

---

## PR 5 — Customer pay link + manage page

### Task 5.1: Pay link shows "pay on the day", never "Paid"

**Files:** `api/src/routes/quotePay.ts` `stateFor` (~212-230, 314-330), `pay.html` `renderPaid` (~764). New state `'pay_on_day'` when the converted booking has `paymentArrangement` and no succeeded payment: "You're booked — pay $X in US dollars cash to your driver". Tests: `quotePay.test.ts` + `web-tests/unit/pay-page-*.test.js`.

### Task 5.2: Manage page balance

**File:** `manage.html` (~555, 587). With Task 2.1 the `/view` `balanceDueCents` is now `total`; label the row **"To pay on the day (cash, USD)"** when the booking has `paymentArrangement` (add the field to the `/view` projection in `routes/bookings.ts`). Test: `web-tests/unit/manage-*.test.js`.

Open PR 5.

---

## For Sandy (CH-D9GR2) meanwhile

Her trip is 28 Nov. **Don't press Mark booked until PR 3 ships**: once the quote is `won` the
button disappears, and her booking would sit in `payment_pending` with no way to switch it to pay on
the day (this plan doesn't add a "switch existing booking" action). After PR 3–4: open Q-J4MHH →
Mark booked → tick cash on the day → she's confirmed and emailed. Settle the $342 vs $312 question first.
