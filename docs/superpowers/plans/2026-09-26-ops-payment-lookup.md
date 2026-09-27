# Ops payment lookup (slice 1) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to carry out this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A founder- and finance-only **Lookup** surface in the ops tool. Given a booking or quote
ref, it shows the customer, a verdict naming one of nine payment situations, a merged payment
timeline, and the recording gaps.

**Spec:** `docs/superpowers/specs/2026-09-26-ops-payment-lookup-design.md`. Read it first; this plan
does not repeat its reasoning.

**Architecture:** one read-only endpoint, `GET /admin/ops/cases/:ref`.
- It loads the evidence through repos: five new read methods, plus two repos wired into the ops
  routes.
- A pure domain module turns the evidence into a verdict, a timeline and gap codes.
- `ops-ui.html` gains a `lookup` route that draws that answer and turns codes into words.

**Tech stack:** Node 20, TypeScript strict, Hono, Zod, Drizzle + Postgres, Vitest; vanilla JS in
`ops-ui.html`; Playwright + Vitest (jsdom) in `web-tests/`.

## Global constraints

- **Read-only.** No INSERT, UPDATE or DELETE anywhere in this change. No migration, no pricing
  change, no config/env change, no generated file.
- **Capability `payments:act`** on the endpoint (403 otherwise), on the nav item, and on the
  drawer link.
- **The verdict judges card money from `payment_events.provider_status_code`**, plus the checkout
  log for timing. It never reads `payments.status` for card money, and never reads
  `booking.status` for any money.
  - Manual money is judged from the payment row's provenance: `settlement_source = 'manual'`.
  - Rows settled as `legacy_backfill` count as card money.
- **Constants:**
  - `LOG_START = 2026-09-24T19:18:10Z` (promote #774 merged).
  - `DECLINES_START = 2026-09-26T04:06:53Z` (promote #793 merged).
- **Never return:** manage/pay links, checkout tokens, margin, `payload_sha256`, `merchant_id`,
  or any card data.
- **In `ops-ui.html`,** every string goes through `esc()`.
- **Postgres tests go in NEW files,** never `db/postgres.test.ts`: open #785 edits that file.
- **Gates before the PR:**
  - `cd api && DATABASE_URL_TEST=postgresql://postgres:postgres@localhost:5432/ceylonhop_test npm run check`
  - `cd web-tests && npm run test:all`
  - Read the real exit codes.

## Contract (API ⇄ UI) — both sides build to exactly this

`GET /admin/ops/cases/:ref`
- **Errors:** `401` without a session, `403` without `payments:act`, `400 {error:'bad_ref'}`,
  `404 {error:'not_found'}`.
- **`200`** returns:

```ts
interface CaseResponse {
  ref: string;                 // normalised: trimmed, upper-cased, trailing "-MANUAL" removed
  quote: { id: string; reference: string; status: string } | null;
  booking: CaseBooking | null; // null only for a quote with no booking
  verdict: Verdict | null;     // null when booking is null OR unavailable is non-empty
  timeline: CaseRow[];         // oldest first
  gaps: GapCode[];
  unavailable: CaseSource[];   // sources that failed to load (or are not wired)
}
interface CaseBooking {
  id: string; reference: string; status: string; mode: string; channel: 'website' | 'whatsapp';
  createdAt: string;           // ISO
  route: string; travelDate: string | null; travelTime: string | null; pax: number; // from toOpsRow
  total: number; amountDueNow: number | null; currency: string;                     // minor units
  customer: { firstName: string; lastName: string; email: string; whatsapp: string; country: string };
  billing: { firstName?: string; lastName?: string; address?: string; city?: string;
             country?: string; postcode?: string; state?: string } | null;
  termsAcceptedAt: string | null;
  cancellation: { reason: string | null; by: string | null; at: string | null } | null; // null unless cancelled
  isTest: boolean;
  inQueue: boolean;            // status is one the ops queue lists (ops.ts QUEUE_STATUSES)
}
type VerdictKind = 'paid' | 'paid_by_hand' | 'declined' | 'reached_no_answer'
  | 'checkout_no_trace' | 'never_started' | 'paid_elsewhere' | 'paid_twice' | 'money_back';
type WarningCode = 'money_on_unpaid_booking' | 'money_after_cancel' | 'paid_status_without_payment';
interface Verdict {
  kind: VerdictKind;
  at: string | null;           // ISO time of the deciding event, when known
  amount: number | null; currency: string | null;
  checkouts: number;           // checkout/succeeded log rows (before the success, for 'paid')
  declineNotices: number;      // webhook/failed log rows with empty reason (before the success, for 'paid')
  countsComplete: boolean;     // false when the booking was created before LOG_START
  payhere: { code: string; message: string | null; method: string | null; paymentId: string | null } | null;
  manual: { method: string; settledBy: string | null; reference: string | null } | null;
  paidOn: string | null;       // 'paid_elsewhere': the paying booking's reference
  captures: Array<{ via: 'payhere' | 'manual'; id: string | null; method: string | null }> | null; // 'paid_twice'
  refund: { state: 'requested' | 'processing' | 'confirmed' | 'failed';
            refundedCents: number; capturedCents: number } | null;   // set whenever refunds exist
  chargebackAt: string | null;
  cancellation: { by: string | null; reason: string | null } | null; // set when cancelled, except 'paid_elsewhere'
  warnings: WarningCode[];
}
type GapCode = 'no_checkout_log' | 'declines_may_be_missing' | 'no_gateway_report' | 'actor_not_recorded';
type CaseSource = 'payments' | 'payment_events' | 'booking_checkout_event' | 'refunds' | 'notification_log';
type CaseRow =
  | { at: string; source: 'bookings'; kind: 'created' }
  | { at: string; source: 'bookings'; kind: 'cancelled'; by: string | null; reason: string | null; paidOn: string | null }
  | { at: string; source: 'booking_checkout_event'; kind: 'log'; action: string; outcome: string;
      reason: string | null; httpStatus: number | null; attempt: number | null; ua: string | null;
      client: boolean; orderMatchOnly: boolean }
  | { at: string; source: 'payments'; kind: 'payment_created'; orderId: string; amount: number; currency: string }
  | { at: string; source: 'payments'; kind: 'payment_settled'; orderId: string; amount: number; currency: string;
      method: string; settlementSource: 'manual' | 'legacy_backfill'; settledBy: string | null; reference: string | null }
  | { at: string; source: 'payment_events'; kind: 'notice'; code: string; message: string | null;
      method: string | null; paymentId: string; amount: number; currency: string;
      note: 'paid_again' | 'earlier_attempt' | null; repeats: number | null }
  | { at: string; source: 'notification_log'; kind: 'email'; emailKind: string; deliveryTracked: boolean }
  | { at: string; source: 'refunds'; kind: 'refund'; step: 'requested' | 'sent' | 'confirmed' | 'failed' | 'cancelled';
      amount: number; currency: string; by: string | null; ref: string | null; message: string | null; reason: string | null };
```

**Row rules**
- `created` comes from `bookings.created_at`, and is left out when the checkout log has this
  booking's `create/succeeded` row (which says the same and carries the device). `cancelled`
  comes from `cancelled_at`, and
  `paidOn` is parsed with `/paid on (CH-[A-Z0-9]+)/`.
- **Log rows:**
  - Every checkout-log row matched by `booking_id` or `order_id`, **except** webhook rows with
    outcome `settled`, `failed`, `dismissed` or `pending`. Those appear only when
    `payment_events` is unavailable.
  - `client = source === 'client'`.
  - `orderMatchOnly = row.bookingId !== booking.id`.
- **Payment rows:**
  - `payment_created` is written for the gateway row only, at its `created_at` (skipped when that
    is null).
  - `payment_settled` is written for rows settled `manual` or `legacy_backfill`, at `settled_at`.
    Webhook settlement already shows as its `notice`.
- **Notices:**
  - One per `payment_events` row, at `received_at`.
  - `note = 'paid_again'` for a code-2 notice whose payment id differs from the first code-2 id.
  - `note = 'earlier_attempt'` for a non-2, non-(-3) notice received after the first code-2 notice
    with a different payment id.
  - `repeats = N` on the single code -2 row when the log holds `N > 1` decline notices; null
    otherwise.
- **Emails:** `deliveryTracked` is false for `payment_failed` and `deposit_received`, true for the
  rest.
- **Refunds:**
  - `requested` at `requested_at`.
  - `sent` at `api_attempted_at`.
  - `confirmed` at `confirmed_at`.
  - `failed` / `cancelled` at `updated_at`, when the status is `api_failed` / `cancelled`.

**Gaps**
- `no_checkout_log`: created before `LOG_START`.
- `declines_may_be_missing`: created before `DECLINES_START`.
- `no_gateway_report`: verdict `checkout_no_trace`.
- `actor_not_recorded`: cancelled with no `cancelled_by`.

## Verdict algorithm (domain, pure)

Classification:
- **Manual row:** `provenance.settlementSource === 'manual'`. Every other row is a gateway row.
- **Card paid:** at least one code-2 notice on a gateway row, or a gateway row with
  `settlementSource === 'legacy_backfill'`.
- **Manual paid:** a manual row with status `succeeded`.

Decide in this order:

1. **`paid_twice`:** two or more distinct code-2 payment ids, **or** card paid and manual paid.
2. **`money_back`:** any code -3 notice, **or** any refund whose status is not `cancelled`.
   - The refund state is `processing` if any row is `api_processing`, else `requested` if any is
     `manual_pending`, else `confirmed` if any is `manual_confirmed` or `api_confirmed`, else
     `failed`.
   - `refundedCents` is the sum of confirmed rows. `capturedCents` is the gateway amount (if card
     paid) plus the manual amount (if manual paid).
3. **`paid`:** card paid.
   - `at` is the first code-2 notice (or `settledAt` for `legacy_backfill`).
   - `payhere` comes from that notice.
   - `checkouts` and `declineNotices` count log rows before `at`.
4. **`paid_by_hand`:** manual paid. `manual = { method: provider, settledBy, reference: gatewayPaymentId }`,
   and `at` is `settledAt`.
5. **`paid_elsewhere`:** `cancelledBy === 'system:duplicate-close'`.
6. **The unpaid kinds.** Let `lastCheckout` be the latest `checkout/succeeded` log row (it may be
   null). PayHere's answers since then are:
   - webhook log rows after `lastCheckout` with outcome `failed` (reason null → code -2),
     `dismissed` (-1) or `pending` (0);
   - plus `payment_events` notices received after `lastCheckout`.

   With no `lastCheckout`, every answer counts. Take the latest answer:
   - **`declined`** if its code is -2 or -1. `payhere` is the latest stored -2/-1 notice; when only
     log evidence exists, `{ code, message: null, method: null, paymentId: null }`.
   - Otherwise **`reached_no_answer`** if, after `lastCheckout`, there is a `gateway/opened` row,
     any `return` row, or a latest answer with code 0.
   - Otherwise **`checkout_no_trace`** if a gateway row exists or `lastCheckout` exists.
   - Otherwise **`never_started`**.

Cross-cutting fields:
- **Warnings**, with money = card paid or manual paid; the capture time is the earliest `at` among
  the captures:
  - money while `status` is `draft` or `payment_pending` → `money_on_unpaid_booking`;
  - money, a set `cancelledAt`, and a capture time after it → `money_after_cancel`;
  - no money while `status` is `paid`, `confirmed`, `in_progress`, `completed`, `no_show` or
    `refunded` → `paid_status_without_payment`.
- **`refund`** is filled whenever refund rows exist, whatever the kind.
- **`cancellation`** is filled when cancelled, except for `paid_elsewhere`.
- **`countsComplete`** is `createdAt >= LOG_START`.

## File map

| File | Change |
|---|---|
| `api/src/db/bookingRepo.ts`, `postgresBookingRepo.ts` | + `findByReference(ref)` |
| `api/src/db/quoteRepo.ts`, `postgresQuoteRepo.ts` | + `findByReference(ref)` (hides soft-deleted, like `get`) |
| `api/src/db/notificationLogRepo.ts`, `postgresNotificationLogRepo.ts` | + `listByBookingId(id): Promise<{kind, sentAt}[]>`. The in-memory repo keeps `sentAt` (a Set becomes a Map) |
| `api/src/db/bookingCheckoutEventRepo.ts`, `postgresBookingCheckoutEventRepo.ts` | + optional `listByOrderId?(orderId)`, newest first |
| `api/src/db/paymentRepo.ts`, `postgresPaymentRepo.ts` | + `provenanceFor(paymentId): Promise<PaymentProvenance \| null>` |
| `api/src/domain/paymentCase.ts` (+ test) | NEW. Types, constants, `paymentVerdict`, `caseTimeline`, `caseGaps`, `normaliseCaseRef` |
| `api/src/services/paymentCase.ts` | NEW. `loadPaymentCase(deps, rawRef)`: the loading and the per-source `unavailable` |
| `api/src/routes/ops.ts` (+ `ops.cases.test.ts`) | + `GET /cases/:ref`. `OpsDeps` gains `paymentEvents?`, `refunds?` |
| `api/src/app.ts` | `AppDeps.paymentEvents?`. One event repo is shared by the in-memory settlement default and `opsRoutes`; `refunds` is passed to `opsRoutes` |
| `api/src/server.ts` | `paymentEvents: new PostgresPaymentEventRepo(db)` |
| `api/src/db/postgresPaymentLookup.test.ts` | NEW. Postgres tests for the five reads (skipped without `DATABASE_URL_TEST`) |
| `api/src/routes/ops-ui.html` | `lookup` route, nav item, `viewLookup()`, word maps, drawer link |
| `web-tests/e2e/ops-lookup.spec.js`, `web-tests/unit/ops-lookup-words.test.js` | NEW |

## Task 1 — Repo reads (TDD, `api/`)

**Interfaces produced:**
```ts
BookingRepo.findByReference(reference: string): Promise<Booking | null>;
QuoteRepo.findByReference(reference: string): Promise<SavedQuote | null>;
NotificationLogRepo.listByBookingId(bookingId: string): Promise<Array<{ kind: NotificationKind; sentAt: Date }>>; // oldest first
BookingCheckoutEventRepo.listByOrderId?(orderId: string): Promise<BookingCheckoutEvent[]>;        // newest first
export interface PaymentProvenance { createdAt: Date | null; settledAt: Date | null;
  settlementSource: 'webhook' | 'legacy_backfill' | 'manual' | null; settledBy: string | null; gatewayPaymentId: string | null }
PaymentRepo.provenanceFor(paymentId: string): Promise<PaymentProvenance | null>;
```

- [ ] Write the failing in-memory tests in the existing repo test files, one `it` per method. Run
  them (`npx vitest run src/db/<file>`) and see them fail.
- [ ] Implement the in-memory versions, then the Postgres versions:
  - `findByReference` is `where(eq(bookings.reference, ref))` followed by `assemble`.
  - The quote version adds `isNull(quotes.deletedAt)` and uses the existing row mapper.
  - The notification list selects `kind`, `sent_at` ordered by `sent_at`.
  - `listByOrderId` mirrors `listByBookingId`.
  - `provenanceFor` selects the five columns. In memory, keep a `createdAt` map filled in
    `create()`.
- [ ] Write `api/src/db/postgresPaymentLookup.test.ts`. Use
  `describe.skipIf(!process.env.DATABASE_URL_TEST)` and the setup of `postgresBookingRepo.list.test.ts`.
  It holds one test per Postgres method. Run it with `DATABASE_URL_TEST` set and confirm it
  passes.
- [ ] Commit: `feat(api): read-only repo lookups for the payment lookup page`.

## Task 2 — Domain: verdict, timeline, gaps (TDD, `api/src/domain/paymentCase.ts`)

**Interfaces produced:**
```ts
export const LOG_START: Date; export const DECLINES_START: Date;
export function normaliseCaseRef(raw: string): { kind: 'booking' | 'quote'; ref: string } | null;
export interface CaseEvidence {
  booking: { id: string; reference: string; status: string; createdAt: Date;
             cancelledAt: Date | null; cancelledBy: string | null; cancellationReason: string | null };
  payments: Array<Payment & PaymentProvenance>;
  notices: PaymentEvent[];              // all payments' events
  log: BookingCheckoutEvent[];          // by booking id ∪ by order id, deduped by id
  refunds: Refund[];
  emails: Array<{ kind: string; sentAt: Date }>;
  unavailable: CaseSource[];
}
export function paymentVerdict(e: CaseEvidence): Verdict | null;   // null when unavailable non-empty
export function caseTimeline(e: CaseEvidence): CaseRow[];
export function caseGaps(e: CaseEvidence, verdict: Verdict | null): GapCode[];
```

- [ ] Write `paymentCase.test.ts` first, with an evidence builder helper. Cases (each an `it`):
  - one per verdict kind (9);
  - paid twice plus a refund → `paid_twice` with `refund` set;
  - a chargeback on a paid booking → `money_back`;
  - a decline then a new checkout with no answer → `checkout_no_trace`, and with a `return` row →
    `reached_no_answer`;
  - a pay-link booking in `payment_pending` with no payment row → `never_started`;
  - a pre-log booking with a pending gateway row and no events → `checkout_no_trace`, gaps
    include `no_checkout_log`;
  - -1 → `declined`; a code-0 notice → `reached_no_answer`;
  - repeated declines collapsed in `payment_events` but three in the log → `declineNotices: 3`,
    `repeats: 3`;
  - the duplicate-close ref parsed;
  - a manual row with null `settledBy`;
  - each of the three warnings, including "cancelled before paid" → no warning;
  - `unavailable` → `null`;
  - timeline order, the webhook-row filtering (and its opposite when `payment_events` is
    unavailable), `orderMatchOnly`, `paid_again`, `earlier_attempt`;
  - `normaliseCaseRef` for `' ch-ab12c-manual '` → `{booking,'CH-AB12C'}`, `'q-7f3kx'`, and bad
    input → null.
- [ ] Run the tests and see them fail (the module is missing). Implement. Run them green.
- [ ] Commit: `feat(api): payment case verdict, timeline and gaps`.

## Task 3 — Loader, route, wiring (TDD)

- [ ] Write `api/src/routes/ops.cases.test.ts` first, with the `ops.checkoutEvents.test.ts` harness
  and `opsUsers: 'f@x.com:founder,fin@x.com:finance,o@x.com:ops'`. It covers:
  - 401 without a session; 403 for ops; 200 for founder and for finance;
  - 400 for `hello`; 404 for an unknown `CH-`; lower-case input works; the `-MANUAL` suffix works;
  - a draft booking is found with `inQueue: false`;
  - a `Q-` ref resolves to its converted booking; a `Q-` ref with no booking gives
    `booking: null, verdict: null` and the quote set;
  - a settled in-memory payment shows up as `paid`, which proves the shared event repo is wired;
  - a throwing refunds repo gives `unavailable: ['refunds']` and `verdict: null` with a 200;
  - no manage/pay link, token or `payload_sha256` anywhere in the body.
- [ ] Implement `services/paymentCase.ts`:
  - Normalise the ref.
  - Resolve the booking; for a `Q-` ref, go through the quote to `convertedBookingId`.
  - Then run a `Promise.all` of per-source loaders, each wrapped in a catch that records the
    source in `unavailable`. A missing optional dep counts as unavailable.
  - Build the `CaseBooking` with `toOpsRow`.
- [ ] Add the route in `ops.ts`, `requireCap('payments:act')`. `inQueue` comes from
  `QUEUE_STATUSES`.
- [ ] Wiring:
  - `app.ts`: `const paymentEvents = deps.paymentEvents ?? new InMemoryPaymentEventRepo()`. Use it
    in the default settlement repo and pass `paymentEvents` and `refunds` to `opsRoutes`.
  - `server.ts`: `paymentEvents: new PostgresPaymentEventRepo(db)`.
- [ ] Run everything green, then commit: `feat(api): GET /admin/ops/cases/:ref`.

## Task 4 — UI (`ops-ui.html`) and web-tests

Integration points, all following the `analytics` pattern:
- `routeStateFromUrl`: when `?case=` is present, or the hash is `#lookup`, and the caps include
  `payments:act` → `{route:'lookup', routeCaseRef}`. `?booking=` still wins.
- `syncUrl`: `#lookup`. Set `case` only on `lookup`; delete it elsewhere.
- `setShellRoute`: carry `opts.caseRef` into `state.routeCaseRef`.
- The nav click handler and the `render()` bounce: without `payments:act`, go to `tickets`.
- `setNav`: a **Lookup** button (`data-route="lookup"`, `data-testid="lookup-nav"`), placed after
  Quotes and before Analytics, with a magnifier icon in `NAV_ICONS.lookup`.
- `viewLookup()`:
  - The search form, with a submit handler calling `setShellRoute('lookup',{caseRef})`.
  - Empty state.
  - A skeleton while loading, with a stale-response guard: ignore the answer unless the route is
    still `lookup` and the ref is unchanged.
  - `api.get('/cases/'+encodeURIComponent(ref))`.
  - Errors: `api 404` → "No booking or quote with that reference". `api 400` → "Enter a booking
    ref (CH-…) or a quote ref (Q-…)". Anything else → "Couldn't load — check the connection".
- **Result layout:**
  - A header block: ref, status, mode, channel, test badge, customer with a `wa.me` link, billing,
    route and date, amount, and "Open in queue" (`openDetail(id)`) or "Not in the queue (draft)".
  - The verdict block, with warnings.
  - The timeline, in `.pa-row` style rows. Log rows use `paLabel()`; other rows use
    `lookupRowLabel()`. The detail line holds reason, code, message, method, payment id, actor
    and UA. The UTC ISO time goes in `title`.
  - The gaps block, the unavailable block, and a static email footnote.
- **Word maps** are pure functions, so the unit test can eval them: `lookupVerdictText(v)`,
  `lookupRowLabel(row)`, `lookupGapText(code)`.
- **Drawer:** in the Payment block, add `<button class="btn" data-act="lookup" data-ref="…">Payment
  history →</button>`, only with `payments:act`. Its handler is `setShellRoute('lookup',{caseRef})`.

Tests:
- [ ] Write `web-tests/unit/ops-lookup-words.test.js` first. It evals the three functions out of
  the page source, the way `unit/ops-day-groups.test.js` does. It covers one sentence per verdict
  kind, the warnings, and every row kind.
- [ ] Write `web-tests/e2e/ops-lookup.spec.js`, stubbed and offline the way
  `ops-payment-attempts.spec.js` is. It covers:
  - the founder sees the nav and ops doesn't;
  - searching `ch-0001` shows the header, verdict and timeline in order;
  - `?case=CH-0001#lookup` survives a reload;
  - a 404 message;
  - `unavailable` shows "Incomplete";
  - the drawer link opens the case;
  - markup inside the reason and message is escaped.
- [ ] Run `npx vitest run unit/ops-lookup-words.test.js` and
  `npx playwright test e2e/ops-lookup.spec.js`: red first, then implement, then green.
- [ ] Commit: `feat(ops-ui): payment lookup page`.

## Task 5 — Gates and PR

- [ ] `cd api && DATABASE_URL_TEST=… npm run migrate:test && npm run check`. The exit code must
  be 0, with the Postgres suites running rather than skipped.
- [ ] `cd web-tests && npm run test:all`. Exit 0.
- [ ] Look at it in the browser pane: the lookup page with stubbed data, desktop and phone width.
- [ ] Push `feat/ops-payment-lookup` and open the PR. The body carries the red→green evidence and
  the sign-off list (spec §14). **Do not merge;** that is the owner's call.

## Slice 2 — the customer's other bookings (spec §15)

**Contract addition** (additive: every existing field is unchanged):
```ts
interface CaseResponse { /* …slice 1 fields… */
  otherBookings: { rows: CasePersonBooking[]; truncated: boolean } | null; // null: failed to load, or a quote with no booking
}
interface CasePersonBooking {
  id: string; reference: string; status: string; mode: string; channel: 'website' | 'whatsapp';
  createdAt: string; route: string; travelDate: string | null; travelTime: string | null; pax: number;
  total: number; currency: string; paid: boolean; isTest: boolean;
}
```

**Tasks** (TDD, one PR):
1. `BookingRepo.listByPersonKey(personKey, limit)`:
   - Newest first, at most `limit` rows.
   - In-memory: filter by `personKeyFor(email)`.
   - Postgres: join `customers` on `person_key`, order by `created_at` desc, then `assembleMany`.
   - Tests in `paymentLookupReads.test.ts` and `postgresPaymentLookup.test.ts`.
2. Loader:
   - Ask for 51 rows, drop the booking itself, keep 50, and set `truncated`.
   - `paid` comes from `findByBookingIds`.
   - The route test covers: same email in a different case, drafts and cancelled included, itself
     excluded, the paid flag, test flag, truncation at 50, and a failing read giving `null` while
     the verdict stays set.
3. UI:
   - A `lookupOtherBookingsHtml(list)` block after Payment.
   - Each ref is a `data-lkcase` button that opens that booking's lookup.
   - An empty state, a null state ("Couldn’t load …") and a truncated note.
   - Unit and e2e tests.
4. Gates: API check with `DATABASE_URL_TEST`, then web-tests `test:all`. Open the PR.
