# Quote Payment Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ops can mint a payment link on a `ready`/`sent` quote; the customer pays via a branded ticket page through PayHere; the booking is created at pay-commit and the quote flips to `won` only when money settles.

**Architecture:** Stateless signed URL over `{quoteId, revision}` → static `pay.html` → two thin public API routes (`/quotes/pay/view`, `/quotes/pay/start`) → the existing `/bookings/:id/checkout` + webhook settlement. New pure modules for copy generation and the won-flip; small hooks in webhook/mark-paid/watchdog. Spec: `docs/superpowers/specs/2026-07-31-quote-payment-link-design.md`.

**Tech Stack:** Hono routes + Zod (api), vanilla static page on site.css (front end), Vitest, Playwright offline specs.

## Global Constraints

- Quote status is NEVER changed by minting or by `/start` — only settlement (webhook or mark-paid) flips it to `won` (spec D3/D6).
- Booking is priced at `quote.totalCents`, never re-priced (spec D5); idempotency key `pay:quote:{quoteId}:r{revision}`.
- `/quotes/pay/view` must never echo `result`, `rateCardJson`, `marginCents`, or hot-zone meta (spec §5).
- Token secret is `BOOKING_LINK_SECRET`; verify with `timingSafeEqual` (reuse `signedBody`/`verifiedPayload` in `bookingToken.ts`).
- Button copy exactly: `Pay with PayHere`; reassurance line: `Pay securely to confirm. {usd} — no extra fees.` (spec D10).
- State precedence: paid → revised → payable → unavailable (spec §4).
- All new code ES-modules TypeScript in `api/src`, ES5-style vanilla JS in `pay.html` (matches manage.html).
- Work in an isolated worktree off `origin/main`; never touch the shared tree; stage by path.

---

### Task 1: payPageCopy — deterministic customer copy

**Files:**
- Create: `api/src/quote/payPageCopy.ts`
- Test: `api/src/quote/payPageCopy.test.ts`

**Interfaces:**
- Consumes: `SavedQuote` shape (`db/quoteRepo.ts`), tool payload `request.tool.legs[] {from,to,date,category,stops?}`, engine `request.engine {product, firstDate?, lastDate?}`.
- Produces:
```ts
export type PayPageProduct = 'single' | 'multi' | 'chauffeur';
export interface PayPageCopy {
  product: PayPageProduct;
  greetingName: string | null;      // first word of customerName, or null → omit greeting
  title: string;                    // per D11
  subtitle: string;                 // per D10 sublines
  facts: { k: string; v: string; sub?: string }[];   // ticket rows (single + chauffeur)
  legs: { route: string; date: string | null }[] | null; // multi only, date preformatted 'THU 20 AUG' or null
  includedText: string;
  totalLabel: string;               // 'Total' | 'Total · all N journeys' | 'Total · N days'
}
export function payPageCopy(quote: {
  customerName: string | null; vehicle: string | null;
  request: unknown; totalCents: number;
}): PayPageCopy;
```
- Rules (from spec D11): product = engine.product `chauffeur` → chauffeur; else 1 driving leg with 2 stops → single; else multi. Span for chauffeur = `daySpan(firstDate,lastDate)` (copy the UTC maths from `quoteToBooking.ts` `daySpan`). Number words two…twelve, digits beyond. Vehicle label: `car`→`Car`, `van_*`→`Van`, `custom`→`Vehicle`. Multi with undated legs → title drops the date clause. Fallback title on any unresolvable shape: `${firstStop} → ${lastStop}`.

- [ ] **Step 1: failing tests** — cases: chauffeur 6-day (“Six days across Sri Lanka”, totalLabel `Total · 6 days`, facts include `Days` row `6 with your driver`), single (route title, journey fact), multi 3 legs dated (“Three journeys, 20–24 August”), multi undated (“Three journeys”), 18-day chauffeur (digits: “18 days across Sri Lanka”), no customerName → greetingName null, stay_day legs excluded from multi leg list, chauffeur facts = Trip/Days/Travellers/Starts exactly 4.
- [ ] **Step 2:** `npx vitest run src/quote/payPageCopy.test.ts` → FAIL (module missing).
- [ ] **Step 3:** implement (pure; no repo imports; ~120 lines).
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5:** `git add api/src/quote/payPageCopy.* && git commit -m "feat(pay-link): deterministic customer copy for the pay page"`

### Task 2: quote pay token

**Files:**
- Modify: `api/src/lib/bookingToken.ts` (append; reuse `signedBody`/`verifiedPayload`)
- Test: `api/src/lib/bookingToken.test.ts` (extend existing)

**Interfaces — Produces:**
```ts
export function signQuotePayToken(quoteId: string, revision: number, secret: string): string;
export function verifyQuotePayToken(token: string | undefined, secret: string)
  : { quoteId: string; revision: number } | null;   // null on any tamper/shape issue
```
Payload `{ v:1, purpose:'quote-pay', q, r }`. No expiry (dies with quote state, spec D7).

- [ ] Steps: failing tests (round-trip, wrong secret, tampered body, checkout token rejected as pay token and vice versa) → red → implement → green → commit `feat(pay-link): signed revision-pinned quote pay token`.

### Task 3: claimWonQuote

**Files:**
- Modify: `api/src/services/quoteOutcome.ts`
- Test: `api/src/services/quoteOutcome.test.ts` (extend)

**Interfaces — Produces:**
```ts
// Best-effort mirror of releaseWonQuote: flips the quote behind a paid booking to won.
export async function claimWonQuote(bookingId: string, deps: { quotes?: QuoteRepo })
  : Promise<boolean>;  // true if a flip happened
```
Rules: find via `findByConvertedBookingId`; flip only from `ready`|`sent` (won → no-op true-ish? return false; lost/expired → never touch); `updatedBy: 'system:payment-settled'`; try/catch best-effort.

- [ ] Steps: failing tests (flips from sent; flips from ready; idempotent second call; never touches lost; no repo → false; repo throws → false, no throw) → red → implement → green → commit `feat(pay-link): claimWonQuote — won means money arrived`.

### Task 4: mint route — POST /admin/quote/:id/pay-link

**Files:**
- Modify: `api/src/routes/internalQuote.ts` (new route after `/:id/book`), deps `+ payBaseUrl?: string; linkSecret?: string; payhereMode?: 'sandbox'|'live'|'off'`
- Modify: `api/src/app.ts` (pass `payBaseUrl: deps.bookingBaseUrl ?? config.APP_BASE_URL`, `linkSecret`, `payhereMode` — derive: no merchant creds → `'off'`, else `config.PAYHERE_MODE`)
- Test: `api/src/routes/internalQuote.test.ts` (extend)

**Interfaces — Produces:** `POST /admin/quote/:id/pay-link` (CSRF + `quote:manage`) →
`{ url, payhereMode }` 200; 409 `not_linkable` for status ∉ {ready,sent}; 409 `not_linkable` for shell/legacy/shared (reuse the `/book` gate logic: channel `ops`, engine present, product ≠ shared, `!isUnpricedShell`); 404 unknown.
URL = `${payBaseUrl}/pay.html?t=${signQuotePayToken(id, quote.revision, linkSecret)}`.

- [ ] Steps: failing tests (200 from ready and sent with identical URL twice; quote status/sentAt/assignedTo unchanged after mint; 409 from each of draft/pending_review/changes_requested/won/lost/expired; 409 for shell; response carries payhereMode) → red → implement → green → commit `feat(pay-link): mint a stateless pay link from a ready or sent quote`.

### Task 5: public routes — /quotes/pay/view + /quotes/pay/start

**Files:**
- Create: `api/src/routes/quotePay.ts`
- Test: `api/src/routes/quotePay.test.ts`
- Modify: `api/src/app.ts`: `app.use('/quotes/pay/*', rateLimit(rl));` next to the other public limiters; mount `app.route('/quotes/pay', quotePayRoutes({ quotes, bookings, payments, linkSecret: bookingLinkSecret, checkoutNow }))`.

**Interfaces — Produces:**
```
GET /quotes/pay/view?t=…  → 200 always (soft states):
  { state:'payable'|'paid'|'revised'|'unavailable',
    copy?: PayPageCopy,                    // payable only
    totals?: { usd:string; cents:number; lkr:string },
    prefill?: { firstName, lastName, email, whatsapp, country }, // best-effort from quote
    paid?: { reference, firstName, amountUsd, when } }           // paid only
POST /quotes/pay/start  body { t, customer: CustomerInput } →
  201/200 { bookingId, checkoutToken }   (200 on idempotent replay)
  409 { error:'quote_revised'|'already_paid'|'quote_unavailable' }
  400 { error:'bad_request', message }    (CustomerInput errors, path-joined like /book)
```
State derivation (spec §4 precedence): linked booking's payments contain `succeeded` OR quote.status==='won' → paid; token.revision ≠ quote.revision → revised; status ready|sent → payable; else unavailable. Prefill: split `customerName`; `customerContact` → email if it matches `/@/`, else whatsapp. `/start`: `quoteToBooking(quote, {customer, vehicleType: quote.vehicle?.startsWith('van')?'van':'car', pax/bags from request.tool, date: first dated leg, time: undefined})`; `bookings.create(..., { idempotencyKey: 'pay:quote:'+id+':r'+revision })` with `total/amountDueNow = quote.totalCents`, `channel:'whatsapp'`; `draft→payment_pending` (guarded like `/book`); `quotes.patch(id,{convertedBookingId})` **without status**; return `signCheckoutToken(booking.id, linkSecret, checkoutNow())`.

- [ ] Steps: failing tests — view: payable shape for the three products (copy.product), margin fields absent (`JSON.stringify(res)` contains neither `marginCents` nor `hotZone` nor `rateCardJson`), revised, unavailable (draft/lost/expired/garbage token), paid (via succeeded payment AND via quote won); start: creates booking once at frozen total + convertedBookingId set + quote stays `sent`; double-tap → same bookingId; revised → 409; after mark-paid → 409 already_paid; checkoutToken works against `POST /bookings/:id/checkout` (fake adapter 200) → red → implement → green → commit `feat(pay-link): public pay view + start routes — booking born at pay-commit`.

### Task 6: settlement hooks — the won flip

**Files:**
- Modify: `api/src/routes/webhooks.ts` (deps `+ quotes?: QuoteRepo`; inside `outcome.kind === 'settled'` add `await claimWonQuote(paid.id, deps)` best-effort)
- Modify: `api/src/app.ts` (pass `quotes` into webhookRoutes)
- Modify: `api/src/routes/admin.ts` mark-paid: after `markSucceededManually`+status step add `await claimWonQuote(booking.id, deps)`
- Tests: `api/src/routes/webhooks.test.ts`, `api/src/routes/admin.test.ts` (extend)

- [ ] Steps: failing tests (webhook settle on a pay-link booking flips its quote sent→won; mark-paid flips ready→won; settle on a booking with no quote → no error; flip failure (throwing repo) never 500s the webhook) → red → implement → green → commit `feat(pay-link): settlement claims the quote — won only when money lands`.

### Task 7: watchdog re-arm

**Files:**
- Modify: `api/src/services/watchdog.ts` stuck-pending filter:
```ts
if (b.channel === 'whatsapp' && !(await hasPendingGatewayPayment(b.id))) return false;
```
where `hasPendingGatewayPayment` = payments row `status==='pending' && (provider==='payhere'||provider==='fake')`. (Needs the filter loop to become async — refactor `filter` to a `for` push loop.)
- Test: `api/src/services/watchdog.test.ts` (extend)

- [ ] Steps: failing tests (whatsapp booking with pending payhere payment now alerts + recovery email; whatsapp booking with no payments stays exempt; hand-settled stays exempt) → red → implement → green → commit `fix(watchdog): a link-initiated checkout is watched even on the whatsapp channel`.

### Task 8: pay.html — the customer page

**Files:**
- Create: `pay.html` (web root; pattern = manage.html: GTM+consent+error beacon head, `window.CEYLON_HOP_API`, site.css, noindex; plus `<script src="https://www.payhere.lk/lib/payhere.js">`)
- Test: `web-tests/e2e/pay-page.spec.js` (offline, stubbed `/quotes/pay/*`; serial file, act-then-verify — the ops-trip-calendar pattern)

Implements spec D8–D10 (approved mockups): ticket card + perforated stub, `.btn .btn-cta` **“Pay with PayHere”**, paysub + card badges, greeting/title/subtitle from `copy`, three product bodies (facts | legs rail | shape facts), details step (only missing CustomerInput fields, prefilled), then `/start` → `/bookings/:id/checkout` → `payhere.startPayment` (sandbox flag from checkoutUrl regex, exactly `booking.js startPayHere`); `onCompleted` → poll `/view` every 2s up to 60s until `state==='paid'` → render keepsake (tick, “You're booked, {name}”, reference chip, what-next list); `onDismissed` → re-enable button; fake-gateway URL (non-payhere) → `location.href = checkoutUrl`. Paid/revised/unavailable states render per mockups. Desktop: content column `max-width:470px` centred.

- [ ] Steps: write page; write 6 offline specs (payable-single renders title+button copy exactly `Pay with PayHere`; multi renders 6 leg rows; chauffeur renders 4 facts and no leg rows; details step shows only missing fields; paid state shows reference and no button; revised state shows no button) → run `npx playwright test pay-page --retries=0` ×3 green → commit `feat(pay-link): the customer pay page — a ticket, not a checkout`.

### Task 9: ops UI — Create payment link

**Files:**
- Modify: `api/src/routes/ops.ts` whoami: add `payhereMode` (deps `+ payhereMode?: string`, wired in app.ts same derivation as Task 4)
- Modify: `api/src/routes/ops-ui.html` quote view: in the reopen/actions area for `ready`|`sent` quotes add button `data-action="mintPayLink"`; handler POSTs `/admin/quote/{id}/pay-link`, shows the URL in a copyable row + `navigator.clipboard`; when `payhereMode!=='live'` render amber chip `SANDBOX — test cards only` beside the link (never block: sandbox is what staging tests with).
- Test: `api/src/routes/opsUi.paylink.test.ts` (string-contract: button markup, sandbox chip markup, handler wiring), `web-tests/e2e/ops-pay-link.spec.js` (offline stub: button visible on ready, hidden on draft; click → link row appears)

- [ ] Steps: failing tests → red → implement → green → commit `feat(pay-link): ops mints and copies the link; sandbox is labelled`.

### Task 10: full gates + PR

- [ ] `cd api && npm run check` → 0 errors, all tests green.
- [ ] `cd web-tests && npm run test:unit` green; `npx playwright test pay-page ops-pay-link ops-trip-calendar --retries=0` green ×2.
- [ ] Push branch `feat/quote-pay-links`, PR to main titled “Payment links for ops quotes: link at ready, booking on pay, won on money”, body maps commits → spec decisions; note shipping gate `PAYHERE_MODE=live`.

### Task 11: sandbox test rig for the owner

- [ ] Recreate `devserve.ts` (uncommitted) in the worktree wiring the REAL `PayHerePaymentAdapter` from `api/.env`'s sandbox `PAYHERE_MERCHANT_ID/SECRET` (mode `'sandbox'`, notifyUrl placeholder) + in-memory repos; seed one ready quote per product (reuse seed-demo.sh pattern via /admin/quote/save + patches).
- [ ] Boot on 8790; verify `/ops` mints a link; open the link; confirm the PayHere **sandbox popup** opens with the right amount. Document the one local limit: PayHere's notify can't reach localhost, so local payments stay `payment_pending`; the full settle→won loop is tested on **staging** after merge (public notify URL). Hand the owner: ops URL, dev-login, a pay link, and PayHere's sandbox test card note.

## Self-review

- Spec coverage: D1 (checkout API — Tasks 5/8), D2 (stateless mint — T4), D3 (status untouched — T4 tests), D4 (frozen total — T5), D5 (booking at commit — T5), D6 (won on settle — T3/T6), D7 (token — T2), D8 states (T5/T8), D9/D10 (T8), D11 (T1), watchdog (T7), ops UI + sandbox flag (T9), §6 testing (each task + T10), §7 gate (T10/T11). No gaps.
- No placeholders; interfaces named consistently (`payPageCopy`, `signQuotePayToken`, `claimWonQuote`, `quotePayRoutes`).
- Types: `PayPageCopy` consumed by T5's view response and T8's rendering; `claimWonQuote(bookingId, deps)` signature identical at both hook sites.
