# Promo Code Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer type a promo code on the booking page's Payment step, see the discount, and book at the discounted price. All of it stays behind a switch that is off.

**Architecture:** The code rides inside the existing `/quote/v2/estimate` intent, so the page's current estimate machinery (signature, fetch, cache, re-price shimmer) re-checks it on every change. The server's promo answer is stored **on the estimate it came with**. `calcTotal()` stays the full price, and a new `payableTotal()` feeds every figure the customer pays or sees as Total/Due now. The booking POST carries the code only while the current estimate accepted it.

**Tech Stack:** Plain browser JS (`booking.js` is a classic, non-module script) + `booking.html` markup/`<style>`. Tests: Vitest + jsdom (`web-tests/unit/`), Playwright (`web-tests/e2e/`).

**Spec:** `docs/superpowers/specs/2026-09-24-promo-code-field-design.md` (approved 2026-09-27, including its §9 calls). **Mockup:** `docs/superpowers/specs/2026-09-24-promo-code-field-mockup.html`.

## Global Constraints

- Switch: `const PROMO_FIELD_ENABLED = false;` in `booking.js`. With it off (and no test override) the page must behave exactly as today: no link, no row, no `promoCode` in any request.
- Test override: `window.CH_PROMO_FIELD === true`, set **before** `booking.js` runs. It is only for tests. `PROMO_CODES_ENABLED` on the API still refuses every code.
- Never for shared seats (`isShared`): the field isn't drawn and no code is sent.
- `calcTotal()` stays the FULL price. Nothing that feeds the summary's vehicle row (`calcTotal() − extras`, `booking.js:2202`) may change.
- The discount comes only from the server's promo block (`promoCode: { code, discountCents, totalBeforeDiscountCents, totalCents }` on the estimate). The client never computes a discount.
- Customer copy, verbatim (typographic apostrophes, as `booking.js` already uses):
  - `promo_code_invalid` → `That code isn’t valid.`
  - `promo_code_not_started` → `That code isn’t active yet.`
  - `promo_code_expired` → `That code has expired.`
  - `promo_code_used_up` → `That code has been fully used.`
  - `promo_code_not_eligible` → `That code can’t be used on this booking.`
  - could not check → `We couldn’t check your code just now, please try again.`
  - link `Have a promo code?` · label `Promo code` · placeholder `Enter code` · button `Apply` / `Checking…` · chip `<CODE> applied` + `Remove` · summary `Promo <CODE>` / `−$9` / `Doesn’t apply`
  - booking-time refusal overlay: `<message> Your total is now the full price.`
- No API, pricing, schema, migration, config or `site.css` changes.
- Gate before every commit: the web-tests suite that covers the change passes; before the PR, `npm --prefix <worktree>/web-tests run test:all` (vitest + Playwright) and `cd api && npm run check`, both green, read from the runner's own summary line.

## Working environment (read once)

- Worktree: `/Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec`, branch `docs/promo-code-field-spec` (holds the spec + mockup commit `1e65d3f7`). All work stays on this branch, and the PR carries spec, plan and code together.
- This Mac's `/usr/bin/git` is blocked by the Xcode licence. Use `/Library/Developer/CommandLineTools/usr/bin/git` (below: `$GIT`). Run `gh` with `--repo ceylonhop/ceylon-hop`.
- Start every shell chain with `cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec || exit 1`, because a failed `cd` would otherwise run the rest in the shared tree.
- Stage files by path only. Never `git add -A`.

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `booking.js` | switch, promo state, intent, totals, answer handling, UI render + handlers, booking-time refusal | 1–5 |
| `booking.html` | promo markup in the Payment step, summary row, promo styles in the page `<style>` | 4 |
| `web-tests/unit/booking-promo.test.js` (new) | jsdom unit tests of the logic | 1–3 |
| `web-tests/e2e/booking-promo-code.spec.js` (new) | Playwright: the field in the real page, mocked API | 4–5 |
| `docs/superpowers/specs/2026-09-24-promo-code-field-design.md` | one refinement (Task 3, Step 7) | 3 |

---

### Task 0: Worktree ready to test

**Files:** none changed.

- [ ] **Step 1: Install dependencies in the worktree**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec || exit 1
npm --prefix web-tests ci && npm --prefix api ci
```
Expected: both finish with `added N packages`.

- [ ] **Step 2: Baseline, the booking unit tests are green before any change**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec/web-tests || exit 1
npx vitest run unit/booking-intent.test.js; echo "exit=$?"
```
Expected: `Test Files  1 passed`, `exit=0`.

---

### Task 1: Switch, promo state, and the code in the estimate intent

**Files:**
- Modify: `booking.js:254` (after `const sharedCorridorId …`), `booking.js:1488` (after `let estimatePending …`), `booking.js:1542` (`buildEstimateIntent`), `booking.js:1603` (`adoptEngineEstimate`)
- Create: `web-tests/unit/booking-promo.test.js`

**Interfaces:**
- Produces: `PROMO_FIELD_ENABLED` (const bool), `promoFieldOn` (const bool), `let promoCode` (string|null), `let promoConfirmed` (bool), `let promoApplyError` (string|null), `let promoOpen` (bool), `itineraryIntent()` (the old `buildEstimateIntent` body), `buildEstimateIntent()` (adds `promoCode`), `engineEst.promo` (the estimate's `promoCode` block or `undefined`).

- [ ] **Step 1: Write the failing tests**

Create `web-tests/unit/booking-promo.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// ────────────────────────────────────────────────────────────────────────────
//  booking.js promo code field (spec docs/superpowers/specs/
//  2026-09-24-promo-code-field-design.md).
//
//  Same harness as booking-intent.test.js: the real booking.html and its real
//  scripts in jsdom, reached through w.eval (booking.js is a classic script with
//  no exports). `promo: true` sets the test switch BEFORE booking.js runs, the
//  way the e2e spec's init script does — PROMO_FIELD_ENABLED itself stays false.
//  Live pricing is unplugged after load: every test adopts its estimate answer by
//  hand, so nothing asynchronous can land mid-test.
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const HTML = readFileSync(path.join(ROOT, 'booking.html'), 'utf8');
const DEPS = ['site.js', 'ta-data.js', 'routes-data.js', 'transfers-data.js', 'decline-help.js', 'checkout-handoff.js', 'ch-map.js', 'ch-pricing.js', 'route-estimate.js']
  .map((f) => readFileSync(path.join(ROOT, f), 'utf8'));
const BOOKING_SRC = readFileSync(path.join(ROOT, 'booking.js'), 'utf8');

const SINGLE = 'mode=private&from=cmb-airport&to=kandy&vehicle=car&price=90&rawPrice=90&ad=1';
const TRIP = 'mode=trip&stops=Colombo|Kandy|Ella&nights=1,2&dates=,,&kms=&gaps=&vehicle=car&price=200&ad=2';
const SHARED = 'mode=shared&from=cmb-airport&to=kandy&price=19&times=07:30&corridor=airport-cultural&days=3,6&pax=1';

function loadBooking(query, { promo = true } = {}) {
  const url = 'https://example.test/booking.html?' + query;
  const dom = new JSDOM(HTML, { url, runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  window.scrollTo = () => {};
  if (promo) window.CH_PROMO_FIELD = true;
  [...DEPS, BOOKING_SRC].forEach((src) => {
    const el = window.document.createElement('script');
    el.textContent = src;
    window.document.body.appendChild(el);
  });
  window.eval('window.CH_PRICING = null; estimatePending = false;');
  return window;
}

function ev(w, expr) {
  return JSON.parse(w.eval(`JSON.stringify((function(){ return (${expr}); })())`) ?? 'null');
}

// An estimate answer shaped like POST /quote/v2/estimate's (api/src/routes/quote.ts:325-349): the
// top-level total is always the FULL price; a code only adds the promoCode block beside it.
const FULL = { totalCents: 9000, amountDueNowCents: 9000, estimated: false, legs: [] };
const OK = { code: 'SAVE10', discountCents: 900, totalBeforeDiscountCents: 9000, totalCents: 8100 };

// Applies `code`, then lands `promo` as the engine's answer for the trip as it now stands.
function applyWith(w, code, promo) {
  w.eval(`promoCode = ${JSON.stringify(code)}; promoConfirmed = false;`);
  const est = promo === undefined ? FULL : { ...FULL, promoCode: promo };
  w.eval(`adoptEngineEstimate(${JSON.stringify(est)}, currentIntentSig())`);
}

describe('promo switch + estimate intent', () => {
  it('is off by default: no code ever enters the intent', () => {
    const w = loadBooking(SINGLE, { promo: false });
    w.eval("promoCode = 'SAVE10'");
    expect(ev(w, 'buildEstimateIntent()')).not.toHaveProperty('promoCode');
  });

  it('carries the applied code, and only while one is applied', () => {
    const w = loadBooking(SINGLE);
    expect(ev(w, 'buildEstimateIntent()')).not.toHaveProperty('promoCode');
    w.eval("promoCode = 'SAVE10'");
    expect(ev(w, 'buildEstimateIntent()').promoCode).toBe('SAVE10');
  });

  it('never turns on for a shared seat', () => {
    const w = loadBooking(SHARED);
    expect(ev(w, 'promoFieldOn')).toBe(false);
  });

  it('keeps the promo answer on the adopted estimate', () => {
    const w = loadBooking(SINGLE);
    applyWith(w, 'SAVE10', OK);
    expect(ev(w, 'engineEst.promo')).toEqual(OK);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec/web-tests || exit 1
npx vitest run unit/booking-promo.test.js; echo "exit=$?"
```
Expected: FAIL. `promoCode is not defined` / `promoFieldOn is not defined`, `exit=1`.

- [ ] **Step 3: Add the switch** after `booking.js:254` (`const sharedCorridorId = …`):

```js
// ---- promo code field (spec docs/superpowers/specs/2026-09-24-promo-code-field-design.md) ----
// Off until the owner turns codes on: setting PROMO_FIELD_ENABLED to true IS the go-live. The
// window override exists only so web-tests can drive the field while it is off; it unlocks
// nothing on the server, where PROMO_CODES_ENABLED still refuses every code.
const PROMO_FIELD_ENABLED = false;
// Shared seats never take a code (POST /bookings/shared refuses one), so the field never draws there.
const promoFieldOn = (PROMO_FIELD_ENABLED || window.CH_PROMO_FIELD === true) && !isShared;
```

- [ ] **Step 4: Add the promo state** after `booking.js:1488` (`let estimatePending = false; …`):

```js
// The code the customer applied (trimmed, upper-cased), or null. While set it rides in every
// estimate intent, so each re-price re-checks it (spec §4.2).
let promoCode = null;
// True once an estimate has accepted the current code. Until then a refusal drops the code (a
// typo stays a typo); after it, a refusal keeps it applied as "doesn't apply" (spec §9.1).
let promoConfirmed = false;
// Why the open field is showing a message (an API error code, or 'promo_unchecked'), and
// whether the customer has opened the field at all.
let promoApplyError = null;
let promoOpen = false;
```

- [ ] **Step 5: Split the intent builder.** At `booking.js:1542` rename `function buildEstimateIntent(){` to `function itineraryIntent(){` (body unchanged). Directly after that function's closing `}` add:

```js
// The intent POST /quote/v2/estimate prices: the itinerary, plus the applied code. The API lifts
// promoCode off before pricing (api/src/routes/quote.ts:298-308), so the top-level total is the
// same with or without it; only the promoCode block in the answer differs.
function buildEstimateIntent(){
  const intent = itineraryIntent();
  if(intent && promoFieldOn && promoCode) intent.promoCode = promoCode;
  return intent;
}
```

- [ ] **Step 6: Keep the promo answer on the estimate.** In `adoptEngineEstimate` (`booking.js:1603`), add `promo` to the object it builds:

```js
function adoptEngineEstimate(est, sig){
  if(!est) return;
  engineEst = {
    totalCents: est.totalCents,
    amountDueNowCents: est.amountDueNowCents,
    estimated: est.estimated,
    legs: est.legs,
    // The promo answer lives ON the estimate it came with, so a discount is only ever taken off
    // the full price it was computed for — it goes stale together with that price (spec §4.1).
    promo: est.promoCode,
    intentSig: sig
  };
}
```

- [ ] **Step 7: Run the new tests and the existing booking unit tests**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec/web-tests || exit 1
npx vitest run unit/booking-promo.test.js unit/booking-intent.test.js; echo "exit=$?"
```
Expected: `Test Files  2 passed`, `exit=0`.

- [ ] **Step 8: Commit**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec || exit 1
GIT=/Library/Developer/CommandLineTools/usr/bin/git
$GIT add booking.js web-tests/unit/booking-promo.test.js
$GIT commit -m "feat(booking): promo code rides in the estimate intent (switch off)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: What the customer pays (`payableTotal`)

**Files:**
- Modify: `booking.js:1841` (`amountDueNow`), `booking.js:1336` (`add_payment_info`), `booking.js:2241` (summary Total), `booking.js:2479` (`payment_initiated`), `booking.js:2518-2521` (final price check), `booking.js:2871` (`quotedTotal`)
- Test: `web-tests/unit/booking-promo.test.js`

(Line numbers are as on `origin/main` @ `ea28bd72`. Task 1 adds about 30 lines above most of them, so find each by the quoted code, not the number.)

**Interfaces:**
- Consumes: `promoFieldOn`, `promoCode`, `engineEst.promo` (Task 1).
- Produces: `heldPromo()` → the successful promo block `{code, discountCents, totalBeforeDiscountCents, totalCents}` on the estimate `calcTotal()` reads from, or `null`. `payableTotal()` → number (USD). `amountDueNow()` now falls back to `payableTotal()`.

- [ ] **Step 1: Write the failing tests.** Append to `web-tests/unit/booking-promo.test.js`:

```js
// Captures the JSON body createApiBooking() posts to `endpoint` ('/bookings/single' or '/bookings/trip').
async function bookingBody(query, endpoint, setup) {
  const w = loadBooking(query);
  setup(w);
  w.eval(`
    window.CEYLON_HOP_API = 'https://api.test';
    window.__body = null;
    window.fetch = function(url, init){
      if(String(url).indexOf(${JSON.stringify(endpoint)}) !== -1) window.__body = JSON.parse(init.body);
      return Promise.resolve({ ok: true, status: 200, json: function(){ return Promise.resolve({ quoteId: 'q1' }); } });
    };
    window.__done = createApiBooking();
  `);
  await w.__done;
  return ev(w, 'window.__body');
}

describe('payableTotal', () => {
  it('takes the discount from the estimate while calcTotal() stays the full price', () => {
    const w = loadBooking(SINGLE);
    applyWith(w, 'SAVE10', OK);
    expect(ev(w, 'calcTotal()')).toBe(90);
    expect(ev(w, 'payableTotal()')).toBe(81);
    expect(ev(w, 'amountDueNow()')).toBe(81);
  });

  it('ignores a discount priced for a different trip', () => {
    const w = loadBooking(SINGLE);
    applyWith(w, 'SAVE10', OK);
    w.eval('state.ad = 2');
    expect(ev(w, 'heldPromo()')).toBe(null);
    expect(ev(w, 'payableTotal()')).toBe(ev(w, 'calcTotal()'));
  });

  it('is the booking’s own total once the booking exists', () => {
    const w = loadBooking(SINGLE);
    applyWith(w, 'SAVE10', OK);
    w.eval('adoptServerQuote({ total: 7700, amountDueNow: 7700 })');
    expect(ev(w, 'payableTotal()')).toBe(77);
  });

  it('ignores a promo block while the switch is off', () => {
    const w = loadBooking(SINGLE, { promo: false });
    applyWith(w, 'SAVE10', OK);
    expect(ev(w, 'payableTotal()')).toBe(90);
  });

  it('sends the discounted figure as quotedTotal', async () => {
    const body = await bookingBody(SINGLE, '/bookings/single', (w) => applyWith(w, 'SAVE10', OK));
    expect(body.quotedTotal).toBe(8100);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec/web-tests || exit 1
npx vitest run unit/booking-promo.test.js; echo "exit=$?"
```
Expected: FAIL. `payableTotal is not defined` / `heldPromo is not defined`, and `amountDueNow()` returns 90. `exit=1`.

- [ ] **Step 3: Add `heldPromo` and `payableTotal`, and point `amountDueNow` at it.** Replace the line `function amountDueNow(){ if(serverQuote) return serverQuote.dueNow; return calcTotal(); }` with:

```js
function amountDueNow(){ if(serverQuote) return serverQuote.dueNow; return payableTotal(); }
// The successful promo answer on the SAME estimate calcTotal() is reading from — mirroring its
// order: a parked raise holds engineEst, a live estimate wins, a re-price in flight holds
// engineEst. The local formula never carries one, and once the booking exists its own total
// (serverQuote) already includes the discount.
function heldPromo(){
  if(!promoFieldOn || !promoCode || serverQuote) return null;
  const est = (state.pendingReprice && state.pendingReprice.engineRaise) ? engineEst
    : (currentEngineEst() || (repricing() ? engineEst : null));
  const p = est && est.promo;
  return (p && !p.error && typeof p.totalCents === 'number' && typeof p.discountCents === 'number') ? p : null;
}
// What the customer pays (spec §4.3). calcTotal() stays the FULL price on purpose: the summary's
// vehicle row is calcTotal() − extras, and a discount folded in there would shrink the car's own
// line. Total, Due now, quotedTotal and the final price check read this instead.
function payableTotal(){
  if(serverQuote) return serverQuote.total;
  const p = heldPromo();
  return p ? p.totalCents/100 : calcTotal();
}
```

- [ ] **Step 4: Summary Total.** In `render()`, change

```js
  setNum(totalEl, busy ? PRICING_LABEL : (curEst && curEst.estimated ? '~' : '') + money(calcTotal()));
```
to
```js
  setNum(totalEl, busy ? PRICING_LABEL : (curEst && curEst.estimated ? '~' : '') + money(payableTotal()));
```

- [ ] **Step 5: `quotedTotal`.** In `createApiBooking()`, change

```js
  const quotedTotal = calcTotal() > 0 ? Math.round(calcTotal() * 100) : undefined;
```
to
```js
  const quotedTotal = payableTotal() > 0 ? Math.round(payableTotal() * 100) : undefined;
```

- [ ] **Step 6: Final price check.** In `runPayment()`, change

```js
  const shownBeforeAdopt = calcTotal();
  adoptServerQuote(booking);
  if(shownEngineEst && Math.abs(calcTotal()-shownBeforeAdopt) > 1){
    return phShowFinalRepriceGate(booking, shownBeforeAdopt, calcTotal());
  }
```
to
```js
  // payableTotal(), not calcTotal(): with a code the booking comes back DISCOUNTED, so comparing
  // it with the full price would stop every discounted booking with a false "price changed".
  const shownBeforeAdopt = payableTotal();
  adoptServerQuote(booking);
  if(shownEngineEst && Math.abs(payableTotal()-shownBeforeAdopt) > 1){
    return phShowFinalRepriceGate(booking, shownBeforeAdopt, payableTotal());
  }
```

- [ ] **Step 7: Analytics report what the customer pays.** In `window.setPayPlan`, change `value:calcTotal()` in the `add_payment_info` call to `value:payableTotal()`. In `runPayment()`, change `value:calcTotal()` in the `payment_initiated` call to `value:payableTotal()`. Leave `reprice_accepted`, the WhatsApp "Quoted" line and the post-booking `purchase` events alone. The last already read `serverQuote.total`.

- [ ] **Step 8: Run tests**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec/web-tests || exit 1
npx vitest run unit/booking-promo.test.js unit/booking-intent.test.js unit/booking-create-error.test.js; echo "exit=$?"
```
Expected: `Test Files  3 passed`, `exit=0`.

- [ ] **Step 9: Commit**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec || exit 1
GIT=/Library/Developer/CommandLineTools/usr/bin/git
$GIT add booking.js web-tests/unit/booking-promo.test.js
$GIT commit -m "feat(booking): payableTotal — Total, Due now and quotedTotal take the code's discount

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Settling the answer, and sending the code

**Files:**
- Modify: `booking.js` (`adoptEngineEstimate`, `requestEstimate`'s `onUnavailable`, new helpers after `payableTotal`, `createApiBooking` payloads at the `routeVariant:` / `routeVariants:` lines)
- Modify: `docs/superpowers/specs/2026-09-24-promo-code-field-design.md` (§3.2, §4.7)
- Test: `web-tests/unit/booking-promo.test.js`

**Interfaces:**
- Consumes: Task 1 state, `heldPromo()` (Task 2), `lastRequestedSig` (`booking.js:1692`).
- Produces:
  - `PROMO_MESSAGES` (object: error code → message, plus `promo_unchecked`)
  - `promoMessage(err)` → string
  - `settlePromoAnswer()` and `settlePromoUnavailable()` → void
  - `dropPromo()` → void: forgets the code and re-keys the held estimate
  - `sendablePromoCode()` → string|undefined
  - `promoUiState()` → one of `'hidden'|'collapsed'|'open'|'checking'|'applied'|'off'`
  - `promoOffReason()` → error code, `'promo_unchecked'`, or `null`

- [ ] **Step 1: Write the failing tests.** Append:

```js
describe('the answer to a code', () => {
  it('confirms a code the estimate accepted', () => {
    const w = loadBooking(SINGLE);
    applyWith(w, 'SAVE10', OK);
    expect(ev(w, 'promoConfirmed')).toBe(true);
    expect(ev(w, 'promoUiState()')).toBe('applied');
    expect(ev(w, 'sendablePromoCode()')).toBe('SAVE10');
  });

  it('drops a code refused on Apply and keeps the price it had, without fetching it again', () => {
    const w = loadBooking(SINGLE);
    applyWith(w, 'NOPE', { error: 'promo_code_invalid' });
    expect(ev(w, 'promoCode')).toBe(null);
    expect(ev(w, 'promoApplyError')).toBe('promo_code_invalid');
    expect(ev(w, 'currentEngineEst() && currentEngineEst().totalCents')).toBe(9000);
    expect(ev(w, 'lastRequestedSig === currentIntentSig()')).toBe(true);
    expect(ev(w, 'sendablePromoCode()')).toBe(null);
  });

  it('keeps a confirmed code that stops applying after the trip changes', () => {
    const w = loadBooking(SINGLE);
    applyWith(w, 'SAVE10', OK);
    w.eval('state.ad = 2');
    w.eval(`adoptEngineEstimate(${JSON.stringify({ ...FULL, promoCode: { error: 'promo_code_not_eligible' } })}, currentIntentSig())`);
    expect(ev(w, 'promoCode')).toBe('SAVE10');
    expect(ev(w, 'promoUiState()')).toBe('off');
    expect(ev(w, 'promoOffReason()')).toBe('promo_code_not_eligible');
    expect(ev(w, 'payableTotal()')).toBe(90);
    expect(ev(w, 'sendablePromoCode()')).toBe(null);
  });

  it('says "checking" while the code’s estimate is in flight', () => {
    const w = loadBooking(SINGLE);
    w.eval("promoCode = 'SAVE10'; estimatePending = true;");
    expect(ev(w, 'promoUiState()')).toBe('checking');
  });

  it('forgets an unconfirmed code whose check could not run, and keeps the price shown', () => {
    const w = loadBooking(SINGLE);
    w.eval(`adoptEngineEstimate(${JSON.stringify(FULL)}, currentIntentSig())`);
    w.eval("promoCode = 'SAVE10'; settlePromoUnavailable();");
    expect(ev(w, 'promoCode')).toBe(null);
    expect(ev(w, 'promoApplyError')).toBe('promo_unchecked');
    expect(ev(w, 'calcTotal()')).toBe(90);
    expect(ev(w, 'lastRequestedSig === currentIntentSig()')).toBe(true);
  });

  it('dropPromo re-keys the held price for the trip without the code', () => {
    const w = loadBooking(SINGLE);
    applyWith(w, 'SAVE10', OK);
    w.eval('dropPromo()');
    expect(ev(w, 'promoCode')).toBe(null);
    expect(ev(w, 'currentEngineEst() !== null')).toBe(true);
    expect(ev(w, 'currentEngineEst().promo')).toBe(null);
    expect(ev(w, 'payableTotal()')).toBe(90);
  });

  it('has its own message for every refusal', () => {
    const w = loadBooking(SINGLE);
    const codes = ['promo_code_invalid', 'promo_code_not_started', 'promo_code_expired', 'promo_code_used_up', 'promo_code_not_eligible', 'promo_unchecked'];
    expect(ev(w, `${JSON.stringify(codes)}.map(promoMessage)`)).toEqual([
      'That code isn’t valid.',
      'That code isn’t active yet.',
      'That code has expired.',
      'That code has been fully used.',
      'That code can’t be used on this booking.',
      'We couldn’t check your code just now, please try again.',
    ]);
  });
});

describe('the code on the booking', () => {
  it('goes with a single booking the estimate accepted it for', async () => {
    const body = await bookingBody(SINGLE, '/bookings/single', (w) => applyWith(w, 'SAVE10', OK));
    expect(body.promoCode).toBe('SAVE10');
  });

  it('goes with a trip booking', async () => {
    const body = await bookingBody(TRIP, '/bookings/trip', (w) => applyWith(w, 'SAVE10', OK));
    expect(body.promoCode).toBe('SAVE10');
  });

  it('stays off a booking once the code stopped applying', async () => {
    const body = await bookingBody(SINGLE, '/bookings/single', (w) => {
      applyWith(w, 'SAVE10', OK);
      w.eval(`adoptEngineEstimate(${JSON.stringify({ ...FULL, promoCode: { error: 'promo_code_used_up' } })}, currentIntentSig())`);
    });
    expect(body).not.toHaveProperty('promoCode');
    expect(body.quotedTotal).toBe(9000);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec/web-tests || exit 1
npx vitest run unit/booking-promo.test.js; echo "exit=$?"
```
Expected: FAIL. `promoUiState is not defined`, `sendablePromoCode is not defined`, and so on. `exit=1`.

- [ ] **Step 3: Add the helpers** directly after `payableTotal()` (Task 2):

```js
const PROMO_MESSAGES = {
  promo_code_invalid: 'That code isn’t valid.',
  promo_code_not_started: 'That code isn’t active yet.',
  promo_code_expired: 'That code has expired.',
  promo_code_used_up: 'That code has been fully used.',
  promo_code_not_eligible: 'That code can’t be used on this booking.',
  promo_unchecked: 'We couldn’t check your code just now, please try again.',
};
function promoMessage(err){ return PROMO_MESSAGES[err] || PROMO_MESSAGES.promo_code_invalid; }

// Settles the promo answer on the estimate just adopted (spec §3.2). The FIRST answer for a code
// decides whether it sticks: accepted → confirmed; refused → dropped, its message shown and the
// typed text left in the field. Once confirmed, a later refusal (the trip changed) keeps the code
// applied, so the summary can say "Doesn't apply" and the discount returns if the trip qualifies.
function settlePromoAnswer(){
  if(!promoCode || promoConfirmed || !engineEst || engineEst.intentSig !== currentIntentSig()) return;
  const p = engineEst.promo;
  if(p && !p.error){ promoConfirmed = true; promoApplyError = null; return; }
  promoApplyError = (p && p.error) || 'promo_code_invalid';
  dropPromo();
}
// The check for a code nobody has confirmed yet could not run. Pricing the trip "with a code" by
// the local formula would put a different, never-shown figure on screen — so forget the code and
// say so; the held engine answer for the trip without it is current again.
function settlePromoUnavailable(){
  if(!promoCode || promoConfirmed) return;
  promoCode = null;
  promoApplyError = 'promo_unchecked';
  if(currentEngineEst()) lastRequestedSig = currentIntentSig();
}
// Forgets the applied code. The estimate's full price never depends on the code (the API lifts it
// off the intent before pricing), so the answer held for "this trip + code" IS the answer for
// "this trip": re-key it rather than fetch the same price again and shimmer the Total for it.
function dropPromo(){
  const cur = currentEngineEst();
  promoCode = null;
  promoConfirmed = false;
  if(cur){
    delete cur.promo;
    cur.intentSig = currentIntentSig();
    lastRequestedSig = cur.intentSig;
  }
}
// The code a booking may carry: only while the estimate priced for THIS trip accepted it
// (spec §4.5) — never in the doesn't-apply, couldn't-check or local-fallback states.
function sendablePromoCode(){
  const cur = currentEngineEst();
  const p = cur && cur.promo;
  return (promoFieldOn && promoCode && p && !p.error) ? p.code : undefined;
}
// Why an applied code is taking nothing off right now, or null when it is.
function promoOffReason(){
  const cur = currentEngineEst();
  if(!cur) return 'promo_unchecked';
  const p = cur.promo;
  return (p && !p.error) ? null : ((p && p.error) || 'promo_code_invalid');
}
// Which face the field shows (spec §3.2).
function promoUiState(){
  if(!promoFieldOn) return 'hidden';
  if(!promoCode) return promoOpen ? 'open' : 'collapsed';
  if(currentEngineEst()) return promoOffReason() ? 'off' : 'applied';
  return (estimatePending || state.pendingReprice) ? 'checking' : 'off';
}
```

- [ ] **Step 4: Settle on adoption.** In `adoptEngineEstimate`, after the `engineEst = { … };` assignment and before the closing `}`, add:

```js
  settlePromoAnswer();
```

- [ ] **Step 5: Settle when the check can't run.** In `requestEstimate()`, make `settlePromoUnavailable()` the first statement of `onUnavailable`:

```js
    onUnavailable: function(reason){
      estimatePending = false;
      if(sig===currentIntentSig()) settlePromoUnavailable();
```
(The rest of the handler is unchanged.)

- [ ] **Step 6: Send the code.** In `createApiBooking()`, add a line after `routeVariants: …` in the **trip** payload:

```js
      routeVariants: (state.svc!=='chauffeur' && tripLocalWires().length) ? tripStops.slice(1).map((_,i)=>tripRoadAt(i)) : undefined,
      // Only while the estimate for THIS trip accepted it (spec §4.5); undefined drops the key.
      promoCode: sendablePromoCode()
```
and after `routeVariant: …` in the **single** payload:

```js
      routeVariant: bookRoad==='no_tolls' ? 'no_tolls' : undefined,
      promoCode: sendablePromoCode()
```
Leave the shared payload alone.

- [ ] **Step 7: Record the refinement in the spec.** In `docs/superpowers/specs/2026-09-24-promo-code-field-design.md`:
  - In the §3.2 table, replace the **Price check unavailable** row with:
    `| **Price check unavailable** | On Apply: the code is not kept; the field stays open with the typed text and the grey message "We couldn’t check your code just now, please try again." For a code already applied: the muted chip reads "SAVE10 · couldn’t be checked just now". | No discount; the price already shown stays (Apply) or the page's offline price (later re-price) |`
  - Replace §4.7's body with:
    `When the engine can't be reached while a code is being applied, the code is not kept: the page keeps the full engine price it already had (it does not fall to the local formula for "the trip with a code"), and the field shows the message with the typed text so Apply retries. If a code that was already accepted can't be re-checked after a later trip change, it stays applied but muted ("couldn’t be checked just now"), nothing is taken off, and the page is on its offline price exactly as it is today without codes. No code is sent in either case.`

- [ ] **Step 8: Run tests**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec/web-tests || exit 1
npx vitest run unit/booking-promo.test.js unit/booking-intent.test.js unit/booking-create-error.test.js; echo "exit=$?"
```
Expected: `Test Files  3 passed`, `exit=0`.

- [ ] **Step 9: Commit**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec || exit 1
GIT=/Library/Developer/CommandLineTools/usr/bin/git
$GIT add booking.js web-tests/unit/booking-promo.test.js docs/superpowers/specs/2026-09-24-promo-code-field-design.md
$GIT commit -m "feat(booking): settle each code answer and send an accepted code with the booking

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The field and the summary row on the page

**Files:**
- Modify: `booking.html:483` (styles, after `.pay-summary-row .amt small{…}`), `booking.html:968-969` (markup between the trust line and `#pay-due`), `booking.html:1017` (summary row after `#sum-addons`)
- Modify: `booking.js` (`renderPromo()` + a call from `render()`, and the handlers)
- Create: `web-tests/e2e/booking-promo-code.spec.js`

**Interfaces:**
- Consumes: everything from Tasks 1–3. Also existing: `acEsc(s)` (HTML-escape, already used in `render()`), `money(n)`, `render()`, `lastRequestedSig`.
- Produces: DOM ids `#promo`, `#promo-toggle`, `#promo-form`, `#promo-input`, `#promo-apply`, `#promo-chip`, `#promo-chip-text`, `#promo-remove`, `#promo-msg`, `#sum-promo`, `#sum-promo-label`, `#sum-promo-amt`. The e2e specs rely on these.

- [ ] **Step 1: Write the failing e2e spec.** Create `web-tests/e2e/booking-promo-code.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact } from './_stubs.js';

// The promo code field on booking.html (spec docs/superpowers/specs/2026-09-24-promo-code-field-design.md).
// The estimate stub answers like POST /quote/v2/estimate (api/src/routes/quote.ts:325-349): the
// top-level total is always the FULL price ($100 here), and a code only adds a promoCode block.
// PROMO_FIELD_ENABLED stays false; each test turns the field on with the test switch.

const FULL = 10000;
const SAVE10 = { code: 'SAVE10', discountCents: 1000, totalBeforeDiscountCents: FULL, totalCents: 9000 };
const acceptSave10 = (intent) => (intent.promoCode === 'SAVE10' ? SAVE10 : { error: 'promo_code_invalid' });
const SHARED_QUERY = 'mode=shared&from=cmb-airport&to=kandy&price=19&times=07:30&corridor=airport-cultural&days=3,6&pax=1';

// promo(intent) returns either a promoCode block, or a full stub answer when it has `status`.
function estimateStub(promo) {
  return { respond: (intent) => {
    if (!intent.promoCode) return { totalCents: FULL };
    const p = promo(intent);
    return p && p.status ? p : { totalCents: FULL, promoCode: p };
  } };
}

async function openPayment(page, { promo = acceptSave10, on = true, bookingTotal = 9000 } = {}) {
  if (on) await page.addInitScript(() => { window.CH_PROMO_FIELD = true; });
  const handles = await gotoBooking(page, { estimate: estimateStub(promo), bookingTotal });
  await expect(page.locator('#sum-total')).toHaveText('$100');
  await fillContact(page);
  return handles;
}

async function applyCode(page, code) {
  await page.click('#promo-toggle');
  await page.fill('#promo-input', code);
  await page.click('#promo-apply');
}

function bookingBody(page) {
  return page.waitForRequest('**/bookings/single').then((r) => JSON.parse(r.postData()));
}

test('nothing shows, and no code is sent, while the switch is off', async ({ page }) => {
  const bodies = [];
  page.on('request', (r) => { if (r.url().includes('/quote/v2/estimate')) bodies.push(JSON.parse(r.postData() || '{}')); });
  await openPayment(page, { on: false });
  await expect(page.locator('#promo')).toBeHidden();
  await expect(page.locator('#sum-promo')).toBeHidden();
  expect(bodies.every((b) => !('promoCode' in b))).toBe(true);
});

test('a shared seat never shows the field', async ({ page }) => {
  // The logic is pinned by the unit test (promoFieldOn is false for a shared seat); this guards
  // the page: with the switch on, the Payment step still draws no field.
  await page.addInitScript(() => { window.CH_PROMO_FIELD = true; });
  await gotoBooking(page, { query: SHARED_QUERY });
  await page.evaluate(() => window.goStep(4));
  await expect(page.locator('#promo')).toBeHidden();
  await expect(page.locator('#promo-toggle')).toBeHidden();
});

test('an accepted code discounts Total and Due now, and goes with the booking', async ({ page }) => {
  const { checkoutBodies } = await openPayment(page);
  await applyCode(page, 'save10');
  await expect(page.locator('#promo-chip')).toBeVisible();
  await expect(page.locator('#promo-chip-text')).toHaveText('SAVE10 applied');
  await expect(page.locator('#sum-promo-label')).toHaveText('Promo SAVE10');
  await expect(page.locator('#sum-promo-amt')).toHaveText('−$10');
  await expect(page.locator('#sum-adamt')).toHaveText('$100'); // the car keeps its own price
  await expect(page.locator('#sum-total')).toHaveText('$90');
  await expect(page.locator('#pay-due .amt')).toHaveText('$90');

  const bodyP = bookingBody(page);
  await page.click('#pay-btn');
  const body = await bodyP;
  expect(body.promoCode).toBe('SAVE10');
  expect(body.quotedTotal).toBe(9000);
  // The booking comes back at $90, the figure shown, so the page goes straight on to checkout —
  // without Task 2's payableTotal() in the final price check it would stop on a false
  // "your price changed" and never ask for checkout.
  await expect.poll(() => checkoutBodies.length).toBe(1);
});

test('a refused code shows why, keeps the typed text and the full price, and is never sent', async ({ page }) => {
  await openPayment(page);
  await applyCode(page, 'NOPE');
  await expect(page.locator('#promo-msg')).toHaveText('That code isn’t valid.');
  await expect(page.locator('#promo-input')).toHaveValue('NOPE');
  await expect(page.locator('#sum-promo')).toBeHidden();
  await expect(page.locator('#sum-total')).toHaveText('$100');

  const bodyP = bookingBody(page);
  await page.click('#pay-btn');
  expect(await bodyP).not.toHaveProperty('promoCode');
});

test('Remove brings back the full price and an empty field', async ({ page }) => {
  await openPayment(page);
  await applyCode(page, 'SAVE10');
  await expect(page.locator('#sum-total')).toHaveText('$90');
  await page.click('#promo-remove');
  await expect(page.locator('#sum-total')).toHaveText('$100');
  await expect(page.locator('#promo-input')).toHaveValue('');
  await expect(page.locator('#promo-chip')).toBeHidden();
  await expect(page.locator('#sum-promo')).toBeHidden();
});

test('a code that stops applying after a trip change stays, says so, and comes back', async ({ page }) => {
  // Eligible for one traveller only — standing in for the vehicle minimum leaving no room.
  await openPayment(page, { promo: (intent) => (intent.pax > 1 ? { error: 'promo_code_not_eligible' } : SAVE10) });
  await applyCode(page, 'SAVE10');
  await expect(page.locator('#sum-total')).toHaveText('$90');

  await page.evaluate(() => window.goStep(3));
  await page.click('#ad-step .ctrls button:has-text("+")');
  await expect(page.locator('#sum-promo-amt')).toHaveText('Doesn’t apply');
  await expect(page.locator('#sum-total')).toHaveText('$100');

  await page.click('#ad-step .ctrls button:has-text("–")'); // the minus is an en dash (booking.html:915)
  await expect(page.locator('#sum-promo-amt')).toHaveText('−$10');
  await expect(page.locator('#sum-total')).toHaveText('$90');

  await page.evaluate(() => window.goStep(3));
  await page.click('#ad-step .ctrls button:has-text("+")');
  await page.evaluate(() => window.goStep(4));
  await expect(page.locator('#promo-chip')).toHaveClass(/\boff\b/);
  await expect(page.locator('#promo-chip-text')).toHaveText('SAVE10 · can’t be used on this booking');
  const bodyP = bookingBody(page);
  await page.click('#pay-btn');
  expect(await bodyP).not.toHaveProperty('promoCode');
});

test('when the code can’t be checked, it isn’t kept and the price shown stays', async ({ page }) => {
  await openPayment(page, { promo: () => ({ status: 500 }) });
  await applyCode(page, 'SAVE10');
  await expect(page.locator('#promo-msg')).toHaveText('We couldn’t check your code just now, please try again.');
  await expect(page.locator('#promo-input')).toHaveValue('SAVE10');
  await expect(page.locator('#sum-total')).toHaveText('$100');
  await expect(page.locator('#sum-promo')).toBeHidden();
});

test('at 375px the applied chip and the summary row fit without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openPayment(page);
  await applyCode(page, 'SAVE10');
  await expect(page.locator('#promo-chip')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec/web-tests || exit 1
npx playwright test e2e/booking-promo-code.spec.js; echo "exit=$?"
```
Expected: the "switch is off" and "shared seat" tests pass (`#promo` doesn't exist, so it counts as hidden). Every other test fails on `#promo-toggle` not found. `exit=1`.

- [ ] **Step 3: Markup.** In `booking.html`, between the trust line (`<p class="trust-line">…</p>`, line 968) and `<div class="pay-summary-row" id="pay-due"></div>` (line 969), insert:

```html
      <!-- Promo code (spec docs/superpowers/specs/2026-09-24-promo-code-field-design.md). Hidden
           until booking.js's PROMO_FIELD_ENABLED switch is on; renderPromo() owns every state. -->
      <div class="promo" id="promo" hidden>
        <button type="button" class="promo-toggle" id="promo-toggle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.3"/></svg>Have a promo code?</button>
        <div class="promo-form" id="promo-form" hidden>
          <label for="promo-input">Promo code</label>
          <div class="promo-row"><input id="promo-input" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="32" placeholder="Enter code"><button type="button" class="btn btn-primary btn-sm" id="promo-apply">Apply</button></div>
        </div>
        <div class="promo-chip" id="promo-chip" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.3"/></svg><span id="promo-chip-text"></span><button type="button" class="rm" id="promo-remove">Remove</button></div>
        <p class="promo-msg" id="promo-msg" role="status" aria-live="polite"></p>
      </div>
```

After `<div id="sum-addons"></div>` (line 1017) insert:

```html
        <div class="s-row s-promo" id="sum-promo" hidden><span id="sum-promo-label"></span><b id="sum-promo-amt"></b></div>
```

- [ ] **Step 4: Styles.** In `booking.html`'s `<style>`, after the `.pay-summary-row .amt small{…}` rule (line 483), add the styles from the approved mockup:

```css
  /* Promo code (spec 2026-09-24-promo-code-field-design.md; mockup beside it) */
  .promo{margin:0 0 12px}
  .promo[hidden],.promo [hidden]{display:none!important}
  .promo-toggle{background:none;border:none;padding:0;font-size:.88rem;font-weight:600;color:var(--accent-deep);display:inline-flex;align-items:center;gap:.4rem}
  .promo-toggle:hover{text-decoration:underline;text-underline-offset:3px}
  .promo-toggle svg,.promo-chip svg{width:15px;height:15px;flex:none}
  .promo-form label{display:block;font-size:.82rem;font-weight:600;margin-bottom:.4rem;color:var(--ink)}
  .promo-row{display:flex;gap:8px}
  .promo-row input{flex:1;min-width:0;padding:.62rem .9rem;border:1.5px solid var(--line);border-radius:var(--r-sm);font-family:inherit;font-size:.95rem;background:var(--white);color:var(--ink);text-transform:uppercase;letter-spacing:.06em;transition:border .15s, box-shadow .15s}
  .promo-row input::placeholder{text-transform:none;letter-spacing:0}
  .promo-row input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(var(--accent-rgb),.15)}
  .promo-row input[readonly]{background:var(--cream)}
  .promo-form.has-error input{border-color:#f4c9bb}
  .promo-msg{margin:.4rem 0 0;font-size:.84rem;font-weight:500;color:#b13b22}
  .promo-msg:empty{display:none}
  .promo-msg.soft{color:var(--ink-soft)}
  .promo-chip{display:inline-flex;align-items:center;gap:.5rem;flex-wrap:wrap;background:var(--pc-teal);border:1px solid #c6e8de;color:var(--teal-deep);border-radius:999px;padding:.4rem .5rem .4rem .8rem;font-size:.86rem}
  .promo-chip b{color:var(--ink);letter-spacing:.06em}
  .promo-chip .rm{background:none;border:none;padding:.1rem .45rem;border-radius:999px;font-size:.82rem;font-weight:600;color:var(--ink-soft);text-decoration:underline;text-underline-offset:2px}
  .promo-chip.off{display:flex;border-radius:12px;background:var(--cream-deep);border-color:var(--line);color:var(--ink-soft);padding:.5rem .5rem .5rem .8rem}
  .promo-chip.off>span{flex:1;min-width:0;line-height:1.4}
  .promo-chip.off b{color:var(--ink-soft)}
  .s-row.s-promo[hidden]{display:none}
  .s-row.s-promo b{color:var(--teal-deep)}
  .s-row.s-promo.off b{color:var(--ink-soft);font-weight:500}
```

- [ ] **Step 5: `renderPromo()`.** Add after `promoUiState()` (Task 3):

```js
// Short reasons for the muted chip — the message's own words without "That code …".
const PROMO_OFF_REASONS = {
  promo_code_invalid: 'isn’t valid',
  promo_code_not_started: 'isn’t active yet',
  promo_code_expired: 'has expired',
  promo_code_used_up: 'has been fully used',
  promo_code_not_eligible: 'can’t be used on this booking',
  promo_unchecked: 'couldn’t be checked just now',
};
// Draws the field and the summary row for promoUiState() (spec §3.2). The input's value is only
// written while checking — otherwise it holds exactly what the customer typed.
function renderPromo(){
  const box=document.getElementById('promo'), row=document.getElementById('sum-promo');
  if(!box || !row) return;
  const ui=promoUiState();
  box.hidden = ui==='hidden';
  const form=document.getElementById('promo-form'), input=document.getElementById('promo-input');
  const apply=document.getElementById('promo-apply'), chip=document.getElementById('promo-chip');
  const msg=document.getElementById('promo-msg');
  document.getElementById('promo-toggle').hidden = ui!=='collapsed';
  form.hidden = !(ui==='open' || ui==='checking');
  input.readOnly = ui==='checking';
  if(ui==='checking') input.value = promoCode;
  apply.disabled = ui==='checking';
  apply.textContent = ui==='checking' ? 'Checking…' : 'Apply';
  chip.hidden = !(ui==='applied' || ui==='off');
  chip.classList.toggle('off', ui==='off');
  const chipHtml = ui==='applied' ? `<b>${acEsc(promoCode)}</b> applied`
    : ui==='off' ? `<b>${acEsc(promoCode)}</b> · ${PROMO_OFF_REASONS[promoOffReason()] || PROMO_OFF_REASONS.promo_code_invalid}` : '';
  const chipText=document.getElementById('promo-chip-text');
  if(chipText.innerHTML!==chipHtml) chipText.innerHTML=chipHtml;
  const text = (ui==='open' && promoApplyError) ? promoMessage(promoApplyError) : '';
  if(msg.textContent!==text) msg.textContent=text;
  msg.classList.toggle('soft', promoApplyError==='promo_unchecked');
  form.classList.toggle('has-error', ui==='open' && !!promoApplyError && promoApplyError!=='promo_unchecked');
  // Summary row: the discount held with the price on screen (it keeps its figure through a
  // re-price, like the vehicle row), or "Doesn't apply" for a code that stopped applying.
  const held=heldPromo();
  row.hidden = !(ui==='off' || held);
  row.classList.toggle('off', ui==='off');
  document.getElementById('sum-promo-label').textContent = promoCode ? 'Promo '+promoCode : '';
  document.getElementById('sum-promo-amt').textContent = ui==='off' ? 'Doesn’t apply' : held ? '−'+money(held.discountCents/100) : '';
}
```

Call it from `render()`, directly after the `if(choice){ … }` block that follows the `#pay-due` update:

```js
  renderPromo();
```

- [ ] **Step 6: Handlers.** Add directly after `document.getElementById('ph-close').addEventListener(…)` (`booking.js:2733`):

```js
// Promo field controls (spec §3.2). Wired only when the field can show at all.
(function wirePromo(){
  if(!promoFieldOn) return;
  const input=document.getElementById('promo-input');
  function apply(){
    const typed=(input.value||'').trim().toUpperCase();
    if(!typed) return;
    promoApplyError=null;
    promoCode=typed;
    promoConfirmed=false;
    lastRequestedSig=null; // a retry after "couldn't check" must really ask again
    render();
  }
  document.getElementById('promo-toggle').addEventListener('click', ()=>{ promoOpen=true; render(); input.focus(); });
  document.getElementById('promo-apply').addEventListener('click', apply);
  input.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); apply(); } });
  input.addEventListener('input', ()=>{ if(promoApplyError){ promoApplyError=null; render(); } });
  document.getElementById('promo-remove').addEventListener('click', ()=>{
    dropPromo(); promoApplyError=null; promoOpen=true; input.value=''; render(); input.focus();
  });
})();
```

- [ ] **Step 7: Run the e2e spec and the unit tests**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec/web-tests || exit 1
npx playwright test e2e/booking-promo-code.spec.js; echo "exit=$?"
npx vitest run unit/booking-promo.test.js; echo "exit=$?"
```
Expected: `8 passed`, `exit=0`, then `Test Files  1 passed`, `exit=0`.

- [ ] **Step 8: Visual check against the mockup.** The switch must be set before `booking.js` runs, so take the screenshots from Playwright rather than the browser pane:

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec/web-tests || exit 1
npx playwright test e2e/booking-promo-code.spec.js -g "accepted code|375px|stops applying" --screenshot=on; echo "exit=$?"
```
Expected: `3 passed`, `exit=0`. Open the PNGs under `web-tests/test-results/` and compare them with the mockup's §1, §2-F and §4:
- the chip sits between the trust line and Due now;
- the summary row sits between the extras and Total, in teal;
- the muted chip wraps inside its box at 375px.

`test-results/` is git-ignored, so don't commit it.

- [ ] **Step 9: Commit**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec || exit 1
GIT=/Library/Developer/CommandLineTools/usr/bin/git
$GIT add booking.html booking.js web-tests/e2e/booking-promo-code.spec.js
$GIT commit -m "feat(booking): the promo code field and summary row (switch off)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: A code refused when the booking is made

**Files:**
- Modify: `booking.js` `runPayment()` catch block (after the `route_choice_unavailable` branch, `booking.js:2498-2502`)
- Test: `web-tests/e2e/booking-promo-code.spec.js`

**Interfaces:**
- Consumes: `dropPromo()`, `promoMessage()`, `promoApplyError`, `promoOpen` (Task 3–4), `phShowEnd(kind, msg, opts)` (existing).

- [ ] **Step 1: Write the failing test.** Append to `web-tests/e2e/booking-promo-code.spec.js`:

```js
test('a code refused when the booking is made takes no payment and shows the full price', async ({ page }) => {
  await openPayment(page, { bookingTotal: FULL });
  // The first booking attempt meets a code whose last use just went; later ones fall through to
  // gotoBooking's own stub (Playwright runs the newest matching route first).
  let refused = false;
  await page.route('**/bookings/single', (r) => {
    if (refused) return r.fallback();
    refused = true;
    return r.fulfill({ status: 422, contentType: 'application/json', body: '{"error":"promo_code_used_up"}' });
  });
  await applyCode(page, 'SAVE10');
  await expect(page.locator('#sum-total')).toHaveText('$90');

  await page.click('#pay-btn');
  await expect(page.locator('#ph-msg')).toHaveText('That code has been fully used. Your total is now the full price.');
  await expect(page.locator('#ph-retry')).toBeHidden();
  await page.click('#ph-close');

  await expect(page.locator('#promo-msg')).toHaveText('That code has been fully used.');
  await expect(page.locator('#promo-input')).toHaveValue('SAVE10');
  await expect(page.locator('#sum-total')).toHaveText('$100');
  await expect(page.locator('#pay-due .amt')).toHaveText('$100');

  const bodyP = bookingBody(page);
  await page.click('#pay-btn');
  const body = await bodyP;
  expect(body).not.toHaveProperty('promoCode');
  expect(body.quotedTotal).toBe(FULL);
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec/web-tests || exit 1
npx playwright test e2e/booking-promo-code.spec.js -g "refused when the booking"; echo "exit=$?"
```
Expected: FAIL. `#ph-msg` shows the generic "We couldn’t start your booking just now…". `exit=1`.

- [ ] **Step 3: Handle the refusal.** In `runPayment()`'s `catch(e){ … }`, after the `route_choice_unavailable` `if` block and before `return phShowEnd(...bookingCreateFailure(e));`, add:

```js
    // A code the preview accepted can still be refused here — its last use went, or it expired,
    // in between (spec §4.6). Same shape as the road refusal above: forget it, show the full
    // price, and no one-click retry, so the customer presses Pay again at the price they now see.
    if(e && e.status===422 && e.body && /^promo_code_/.test(e.body.error||'')){
      promoApplyError=e.body.error;
      promoOpen=true;
      dropPromo();
      render();
      return phShowEnd('error', promoMessage(e.body.error)+' Your total is now the full price.', {retry:false});
    }
```

- [ ] **Step 4: Run the whole promo spec**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec/web-tests || exit 1
npx playwright test e2e/booking-promo-code.spec.js; echo "exit=$?"
```
Expected: `9 passed`, `exit=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec || exit 1
GIT=/Library/Developer/CommandLineTools/usr/bin/git
$GIT add booking.js web-tests/e2e/booking-promo-code.spec.js
$GIT commit -m "feat(booking): a code refused at booking time takes no payment and shows the full price

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Full gate and PR

**Files:** none changed.

- [ ] **Step 1: The whole web-tests suite (vitest + Playwright)**

```bash
npm --prefix /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec/web-tests run test:all; echo "exit=$?"
```
Expected: vitest `Test Files  N passed`, Playwright `N passed`, `exit=0`. A failure elsewhere in `booking-*.spec.js` means the switch-off path isn't byte-identical to before. Fix that, and don't touch the other spec.

- [ ] **Step 2: API gate** (nothing changed there; this is the project rule)

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec/api || exit 1
npm run check; echo "exit=$?"
```
Expected: typecheck, lint and test pass, `exit=0`. Without `DATABASE_URL_TEST`, the Postgres suites are skipped. Say so in the PR.

- [ ] **Step 3: Diff check.** Only these paths differ from `origin/main`:

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec || exit 1
GIT=/Library/Developer/CommandLineTools/usr/bin/git
$GIT fetch -q origin && $GIT diff --stat origin/main...HEAD
```
Expected: `booking.html`, `booking.js`, `web-tests/unit/booking-promo.test.js`, `web-tests/e2e/booking-promo-code.spec.js`, the spec, the mockup, this plan. Nothing else.

- [ ] **Step 4: Ask the owner before pushing.** The PR merges to `main` (staging). It ships nothing to customers: Pages serves `production`, and the switch is off. Push and open the PR only on the owner's go:

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/promo-field-spec || exit 1
GIT=/Library/Developer/CommandLineTools/usr/bin/git
$GIT push -u origin docs/promo-code-field-spec
gh pr create --repo ceylonhop/ceylon-hop --base main --head docs/promo-code-field-spec \
  --title "feat(booking): promo code field on the Payment step (switch off)" \
  --body-file /private/tmp/claude-501/promo-field-pr.md
```
The PR body contains: what it does, the switch and why it is off, the red→green evidence from Tasks 1–5, the `test:all` and `npm run check` summary lines, a screenshot of the applied state, and the go-live steps (spec §8). End it with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Known edges (accepted, not fixed here)

- **Cached previews:** `ch-pricing.js` caches estimate answers in `sessionStorage` by intent, so a preview can be minutes old. A code that was used up in the meantime is caught at booking time (Task 5).
- **A single-use code after a failed payment:** the customer's own unpaid booking holds the use for 2 hours. If they then change the trip, the fresh preview counts their own hold and says "fully used". A retry of the *same* trip re-sends the same booking (same idempotency key), which the backend honours.
