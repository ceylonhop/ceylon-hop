# Ops booking pane PR 2: order, folds, wider pane, severity colours. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the job before the money. Money owed or due shows as one coloured line under the name; contact, payment, pickup toggles, history and refund/cancel fold away; team notes show in full; and the pane gets wider with two columns on large screens.

**Architecture:** One file changes, `api/src/routes/ops-ui.html` (single inline-script page). Three new pure helpers join PR 1's `/* @sheet-job:start */ … /* @sheet-job:end */` block and are unit-tested by extraction: `sheetException`, `paymentWord`, `noteParts`. `sheetHeadHtml` gains an `alert` slot, and the booking sheet stops drawing the stepper. `renderSheet`'s body is regrouped into two column wrappers. Folds are `<details class="block fold" data-fold="…">` whose open state lives in `state.folds`, so a diff-render (`morphSheet`) can't snap them shut. The width is CSS only.

**Tech Stack:** plain browser JS + CSS in `ops-ui.html`, Vitest (unit, block extraction), Playwright (e2e, stubbed `/admin/**`).

## Global Constraints

- Front end only (owner, 2026-11-12). No API, schema, migration, pricing or config change.
- Spec: `docs/superpowers/specs/2026-11-12-ops-booking-pane-info-priority-design.md`. This plan is **PR 2** of four (Risks section): order, folded sections, the wider two-column pane, and the amber/red rules. **Not in PR 2:** the map (PR 3), the ride-board pane (PR 4), any change to the sticky foot buttons or to what the status buttons do.
- **Stacked on PR 1** (ceylonhop/ceylon-hop#1169, branch `feat/ops-booking-pane-priority`). Build on a new branch cut from that branch. **Do not open the PR until #1169 has merged.** Then rebase this branch onto `origin/main` and open the PR against `main`, never against PR 1's branch (memory: stacked PRs merge into nothing).
- Colour means severity (spec decision 11), exactly:
  - **Amber** for an expected state that needs handling:
    - balance due
    - cash on the day
    - flexible date
    - unpaid with more than 48 hours to travel
    - every unpaid **website** booking
  - **Red** only for an unpaid booking from **any channel other than the website** with travel within 48 hours (start date, plus pickup time when set). The vehicle-not-on-record cell is already red from PR 1. Closed bookings are **grey**.
- Exception copy, exactly:
  - website unpaid → **"Checkout not completed · $X"**
  - other unpaid → **"Not paid · $X"**, or **"Not paid · travels within 48 hours · $X"** when red
  - balance → **"Balance due · $X"**
  - cash → **"Cash due at the first pickup · $X"**
  - closed → **"Completed"**, **"Cancelled"**, **"Refunded"**, **"No-show"**
- The owner rule (2026-10-29, CH-NQ66B): don't chase abandoned or declined website checkouts. Nothing in the copy may tell ops to chase a website checkout.
- No information is lost. Only duplicates go: the Trip block's When and Guests rows (the header has both; the Change / Set date button moves under the itinerary), the Payment block's Status row (the fold summary carries it), and the stepper (the pill carries it).
- Folds: `<details>`/`<summary>`, closed by default, reset each time a booking is opened. Payment opens by itself when there is an exception. A refresh never changes a fold the operator opened or closed.
- Wide layout: `.sheet` is 780px when the viewport is at least 900px. There are two columns: left holds Next up and the itinerary; right holds the customer's note, team notes, interests and the folds. Below 900px the pane keeps one column in this order: Next up, customer's note, itinerary, team notes, interests, folds. The ≤700px phone rule is unchanged.
- Escape every booking-sourced or operator-typed string with `esc()`.
- Ride-board sheet (`boardSheetHtml`) unchanged.
- `ops-ui.html` is the hot file: one commit per task, stage by path, never `git add -A`. Test dates via `web-tests/dates.js` only (no literal calendar dates).
- Gate before every commit: `cd web-tests && npx vitest run` plus the task's e2e specs, and `cd api && npx vitest run src/routes/opsUi`. Before the PR: `cd web-tests && npm run test:all` and `cd api && DATABASE_URL_TEST=postgresql://postgres:postgres@localhost:5432/ceylonhop_test npm run check`, judged by the runners' own summary lines and exit codes. Never point `DATABASE_URL_TEST` at `api/.env`'s `DATABASE_URL` (that's prod).

---

### Task 0: Branch setup

**Files:** none

- [ ] **Step 1: Cut the PR 2 branch from PR 1's branch**

```bash
cd /private/tmp/claude-501/-Users-roshenw--claude-spares-spare-n5EXYY/cc699db8-29f2-42b6-93be-eb1e01cddbd3/scratchpad/wt-ops-pane
git fetch origin
git switch -c feat/ops-booking-pane-pr2 origin/feat/ops-booking-pane-priority
git log --oneline -3
```
Expected: HEAD is PR 1's head (currently `8917ac5e`, or newer if Auto-fix pushed). If #1169 has already merged, use `git switch -c feat/ops-booking-pane-pr2 origin/main` instead.

---

### Task 1: Pure helpers `sheetException`, `paymentWord`, `noteParts`

**Files:**
- Modify: `api/src/routes/ops-ui.html`: append three functions inside the `@sheet-job` block, just above `/* @sheet-job:end */`
- Modify: `web-tests/unit/ops-sheet-job.test.js`: the loader's return list, plus new `describe` blocks

**Interfaces:**
- Produces:
  - `sheetException(t, isCashDue: boolean, now: number /* ms */) → null | {kind: 'closed'|'checkout'|'unpaid'|'balance'|'cash', tone: 'grey'|'amber'|'red', text: string, amount: number|null, openPayment: boolean}`, where `t` is a ticket with `stage, chan, date, time, amount, paid, balance, cashDue`
  - `paymentWord(t, isCashDue: boolean) → 'Paid'|'Deposit paid'|'Cash due on the day'|'Awaiting payment'`
  - `noteParts(line: string) → {at: string|null, text: string}`, which parses ops notes stored as `"[YYYY-MM-DD HH:MM] text"` (`nowStamp()` at `ops-ui.html:2107`)

- [ ] **Step 1: Write the failing unit tests**

In `web-tests/unit/ops-sheet-job.test.js`, change the loader's return line to:

```js
  return new Function(m[0] + '\nreturn { shortPlace, roadOf, legRows, jobFacts, sheetException, paymentWord, noteParts };')();
```

and the destructure to:

```js
const { shortPlace, roadOf, legRows, jobFacts, sheetException, paymentWord, noteParts } = load();
```

Then append:

```js
describe('sheetException', () => {
  const NOW = Date.parse(futureIsoDate(0) + 'T12:00:00');
  const tk = (o) => ({ stage: 'paid', chan: 'website', date: futureIsoDate(10), time: '09:00', amount: 3900, paid: true, balance: 0, cashDue: 0, ...o });

  it('is nothing for a booking paid in full', () => {
    expect(sheetException(tk({}), false, NOW)).toBeNull();
  });

  it('keeps an unpaid website checkout amber and factual, even travelling tomorrow', () => {
    expect(sheetException(tk({ stage: 'awaiting_payment', paid: false, date: futureIsoDate(1) }), false, NOW))
      .toEqual({ kind: 'checkout', tone: 'amber', text: 'Checkout not completed', amount: 3900, openPayment: true });
  });

  it('turns an unpaid WhatsApp quote red inside 48 hours', () => {
    expect(sheetException(tk({ stage: 'awaiting_payment', paid: false, chan: 'whatsapp', date: futureIsoDate(1) }), false, NOW))
      .toEqual({ kind: 'unpaid', tone: 'red', text: 'Not paid · travels within 48 hours', amount: 3900, openPayment: true });
  });

  it('keeps an unpaid WhatsApp quote amber when travel is further out', () => {
    expect(sheetException(tk({ stage: 'awaiting_payment', paid: false, chan: 'whatsapp', date: futureIsoDate(10) }), false, NOW))
      .toMatchObject({ kind: 'unpaid', tone: 'amber', text: 'Not paid' });
  });

  it('keeps an undated unpaid quote amber: there is no travel time to measure', () => {
    expect(sheetException(tk({ stage: 'awaiting_payment', paid: false, chan: 'whatsapp', date: null, time: null }), false, NOW))
      .toMatchObject({ tone: 'amber' });
  });

  it('flags a balance owed in amber', () => {
    expect(sheetException(tk({ balance: 16900 }), false, NOW))
      .toEqual({ kind: 'balance', tone: 'amber', text: 'Balance due', amount: 16900, openPayment: true });
  });

  it('flags cash to collect in amber', () => {
    expect(sheetException(tk({ paid: false, cashDue: 5000 }), true, NOW))
      .toEqual({ kind: 'cash', tone: 'amber', text: 'Cash due at the first pickup', amount: 5000, openPayment: true });
  });

  it('names a closed booking’s outcome in grey', () => {
    expect(sheetException(tk({ stage: 'cancelled' }), false, NOW)).toEqual({ kind: 'closed', tone: 'grey', text: 'Cancelled', amount: null, openPayment: false });
    expect(sheetException(tk({ stage: 'no_show' }), false, NOW).text).toBe('No-show');
    expect(sheetException(tk({ stage: 'completed' }), false, NOW).text).toBe('Completed');
    expect(sheetException(tk({ stage: 'refunded' }), false, NOW).text).toBe('Refunded');
  });
});

describe('paymentWord', () => {
  it('matches the Payment block’s old Status row', () => {
    expect(paymentWord({ paid: true, balance: 0 }, false)).toBe('Paid');
    expect(paymentWord({ paid: true, balance: 100 }, false)).toBe('Deposit paid');
    expect(paymentWord({ paid: false, balance: 0 }, true)).toBe('Cash due on the day');
    expect(paymentWord({ paid: false, balance: 0 }, false)).toBe('Awaiting payment');
  });
});

describe('noteParts', () => {
  it('splits the stamp the page writes from the note', () => {
    expect(noteParts('[2026-11-12 15:40] Van confirmed, driver Sunil')).toEqual({ at: '2026-11-12 15:40', text: 'Van confirmed, driver Sunil' });
  });
  it('keeps an unstamped legacy line whole', () => {
    expect(noteParts('child seat needed')).toEqual({ at: null, text: 'child seat needed' });
  });
});
```

(`futureIsoDate` is already imported in this file.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd web-tests && npx vitest run unit/ops-sheet-job.test.js`
Expected: FAIL with `sheetException is not defined`.

- [ ] **Step 3: Add the helpers**

Insert immediately above `/* @sheet-job:end */` in `api/src/routes/ops-ui.html`:

```js
/* The one line that must stand out under the name (spec 2026-11-12 decision 11). Amber marks an
   expected state that needs handling; red marks only what blocks the trip. An unpaid WEBSITE
   booking is an abandoned or declined checkout, and the owner's rule is not to chase those
   (2026-10-29, CH-NQ66B), so it stays amber and is worded as a fact. `now` is ms since epoch. */
function sheetException(t,isCashDue,now){
  const closed={completed:'Completed',cancelled:'Cancelled',refunded:'Refunded',no_show:'No-show'}[t.stage];
  if(closed)return {kind:'closed',tone:'grey',text:closed,amount:null,openPayment:false};
  if(t.stage==='awaiting_payment'){
    if(t.chan==='website')return {kind:'checkout',tone:'amber',text:'Checkout not completed',amount:t.amount,openPayment:true};
    const hm=/^\d\d:\d\d$/.test(t.time||'')?t.time:'00:00';
    const start=t.date?Date.parse(t.date+'T'+hm+':00'):NaN;
    const soon=Number.isFinite(start)&&start-now<=48*3600e3;
    return {kind:'unpaid',tone:soon?'red':'amber',text:soon?'Not paid · travels within 48 hours':'Not paid',amount:t.amount,openPayment:true};
  }
  if(t.paid&&t.balance>0)return {kind:'balance',tone:'amber',text:'Balance due',amount:t.balance,openPayment:true};
  if(isCashDue)return {kind:'cash',tone:'amber',text:'Cash due at the first pickup',amount:t.cashDue,openPayment:true};
  return null;
}
function paymentWord(t,isCashDue){
  return t.paid?(t.balance>0?'Deposit paid':'Paid'):isCashDue?'Cash due on the day':'Awaiting payment';
}
/* Ops notes are stored one per line as "[YYYY-MM-DD HH:MM] text" (nowStamp). */
function noteParts(line){
  const m=/^\[(\d{4}-\d\d-\d\d \d\d:\d\d)\]\s*([\s\S]*)$/.exec(String(line??''));
  return m?{at:m[1],text:m[2]}:{at:null,text:String(line??'')};
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web-tests && npx vitest run unit/ops-sheet-job.test.js`
Expected: PASS (all). Then `npx vitest run` (whole unit suite), whose summary must show 0 failed.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/ops-ui.html web-tests/unit/ops-sheet-job.test.js
git commit -m "feat(ops): pure helpers for the booking pane's exception line, payment word and notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Header: no stepper; one exception line; amber "Flexible"

**Files:**
- Modify: `api/src/routes/ops-ui.html`: `sheetHeadHtml` (accepts `o.alert`), `renderSheet`'s `sheetHeadHtml(t,{…})` call, `bookingStubHtml`'s When value, CSS
- Create: `web-tests/e2e/ops-sheet-exception.spec.js`
- Modify: `web-tests/e2e/ops-balance.spec.js`, `web-tests/e2e/ops-cash-due.spec.js`, `web-tests/e2e/ops-mark-paid.spec.js` (selectors that read the stepper or the header balance tag)

**Interfaces:**
- Consumes: `sheetException`, `cashDue(t)` (page global, `ops-ui.html:2234`), `money({amount,currency})`
- Produces: `[data-testid="sheet-exception"]` with class `sh-exc tone-<amber|red|grey>` inside `.sheet-h`, only when `sheetException` returns non-null. `.sheet-h .pipe` is no longer drawn for booking sheets.

- [ ] **Step 1: Write the failing e2e spec**

Create `web-tests/e2e/ops-sheet-exception.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { futureIsoDate } from '../dates.js';

// Drives the REAL ops shell (api/src/routes/ops-ui.html) offline (stubbed API, no DB).
//
// Spec 2026-11-12 decision 11 (booking pane PR 2): money only rises when there is something to do,
// as ONE line under the name. Amber = expected and needs handling; red = blocks the trip. An unpaid
// website checkout is never red (owner: don't chase abandoned checkouts, 2026-10-29).

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const CUSTOMER = { whatsapp: '+94 77 000 0000', email: 'c@example.com', country: 'Spain' };

const row = (id, ref, extra = {}) => ({
  id, reference: ref, channel: 'website', customerName: 'Alpha Customer', customerFirstName: 'Alpha',
  mode: 'single', route: 'A → B', travelDate: futureIsoDate(10), travelTime: '09:00', pax: 2,
  amount: 3900, currency: 'USD', stage: 'paid', paymentStatus: 'succeeded',
  vehiclePhotoReceived: false, customerUpdated: false, opsNotes: '', source: 'booking', board: null, ...extra,
});
const detail = (id, ref, status, date) => ({
  payLink: null, vehicle: 'car',
  booking: { id, reference: ref, currency: 'USD', status, mode: 'single', createdAt: '2026-09-01T00:00:00Z',
    input: { customer: CUSTOMER, from: 'A, x', to: 'B, y', date, time: '09:00', vehicleType: 'car', adults: 2, children: 0, bags: 1 } },
  ops: { updatedAt: '2026-09-02T00:00:00Z' },
  payments: [], refunds: [],
});

const CASES = {
  paid: [row('paid', 'CH-0001'), detail('paid', 'CH-0001', 'paid', futureIsoDate(10))],
  webunpaid: [row('webunpaid', 'CH-0002', { stage: 'awaiting_payment', paymentStatus: 'pending', travelDate: futureIsoDate(1) }), detail('webunpaid', 'CH-0002', 'payment_pending', futureIsoDate(1))],
  quotesoon: [row('quotesoon', 'CH-0003', { channel: 'whatsapp', stage: 'awaiting_payment', paymentStatus: 'pending', travelDate: futureIsoDate(1) }), detail('quotesoon', 'CH-0003', 'payment_pending', futureIsoDate(1))],
  quotelater: [row('quotelater', 'CH-0004', { channel: 'whatsapp', stage: 'awaiting_payment', paymentStatus: 'pending', travelDate: futureIsoDate(10) }), detail('quotelater', 'CH-0004', 'payment_pending', futureIsoDate(10))],
  cancelled: [row('cancelled', 'CH-0005', { stage: 'cancelled' }), detail('cancelled', 'CH-0005', 'cancelled', futureIsoDate(10))],
};

async function boot(page) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/bookings/*/refunds', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json(Object.values(CASES).map(([rw]) => rw))));
  for (const [id, [, d]] of Object.entries(CASES)) await page.route(`**/admin/ops/bookings/${id}`, (r) => r.fulfill(json(d)));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'founder', caps: ['bookings:operate', 'payments:act'] })));
  await page.goto(OPS_FILE + '#bookings');
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
}
async function open(page, id) {
  // Closed bookings file under a closed group; search finds every row regardless of group.
  const tk = page.locator(`.tk[data-act="open"][data-id="${id}"]`);
  if (!(await tk.count())) await page.locator('[data-group="all"], [data-group="closed"]').last().click().catch(() => {});
  await tk.click();
  await page.waitForSelector('.sheet-b:not(.skel)', { timeout: 10000 });
}
const exc = (page) => page.locator('#sheet .sheet-h [data-testid="sheet-exception"]');

test('a booking paid in full shows no money line and no stepper', async ({ page }) => {
  await boot(page);
  await open(page, 'paid');
  await expect(exc(page)).toHaveCount(0);
  await expect(page.locator('#sheet .sheet-h .pipe')).toHaveCount(0);
  await expect(page.locator('#sheet .sheet-h .idrow .pill').first()).toBeVisible();
});

test('an unpaid website checkout is amber and factual, even travelling tomorrow', async ({ page }) => {
  await boot(page);
  await open(page, 'webunpaid');
  await expect(exc(page)).toHaveText('Checkout not completed · $39');
  await expect(exc(page)).toHaveClass(/tone-amber/);
});

test('an unpaid WhatsApp quote travelling within 48 hours is red', async ({ page }) => {
  await boot(page);
  await open(page, 'quotesoon');
  await expect(exc(page)).toHaveText('Not paid · travels within 48 hours · $39');
  await expect(exc(page)).toHaveClass(/tone-red/);
});

test('an unpaid WhatsApp quote further out is amber', async ({ page }) => {
  await boot(page);
  await open(page, 'quotelater');
  await expect(exc(page)).toHaveText('Not paid · $39');
  await expect(exc(page)).toHaveClass(/tone-amber/);
});

test('a cancelled booking names its outcome in grey', async ({ page }) => {
  await boot(page);
  await open(page, 'cancelled');
  await expect(exc(page)).toHaveText('Cancelled');
  await expect(exc(page)).toHaveClass(/tone-grey/);
});
```

Note for the implementer: if the queue hides the cancelled row by default, read how `web-tests/e2e/ops-cancel-refund.spec.js` opens a closed booking and use the same steps in `open()`. Replace the `if (!(await tk.count()))` line with them, and keep the rest of the test.

- [ ] **Step 2: Run to verify it fails**

Run: `cd web-tests && npx playwright test e2e/ops-sheet-exception.spec.js`
Expected: FAIL. `[data-testid="sheet-exception"]` doesn't exist, and `.pipe` is still drawn.

- [ ] **Step 3: `sheetHeadHtml` gets an alert slot**

In `sheetHeadHtml(t,o)`, change the idrow close and pipe line from:

```js
        <span class="pill${o.pillCls||''}"><span class="pd"></span>${esc(o.pill)}</span>${o.tag||''}
      </div>${pipe}
```

to:

```js
        <span class="pill${o.pillCls||''}"><span class="pd"></span>${esc(o.pill)}</span>${o.tag||''}
      </div>${o.alert||''}${pipe}
```

- [ ] **Step 4: The booking sheet passes the exception, drops the stepper and the balance tag**

In `renderSheet`, replace the whole `const head=sheetHeadHtml(t,{ … });` statement with:

```js
  /* One line under the name when money or the outcome needs attention (spec 2026-11-12 decision
     11); it replaces the old balance/cash tag. The six-step stepper is gone: ops don't press
     status buttons, and the pill beside the ref still says where the booking is. */
  const exc=sheetException(t,cashDue(t),Date.now());
  const head=sheetHeadHtml(t,{
    ey:`<span class="chan ${chanClass(t.chan)}" style="width:22px;height:22px;border-radius:6px">${chanIcon(t.chan)}</span> ${chanLabel(t.chan)} · ${MODE[t.mode]||esc(t.mode)}`,
    title:t.cust,pill:stageLabel(t),pillCls:t.stage==='paid'&&cashDue(t)?' pill-bal':'',stub:bookingStubHtml(t,d),pipe:false,idx,
    action:waDigits.length>=8?`<a class="sh-wa" href="https://wa.me/${waDigits}" target="_blank" rel="noopener" aria-label="Message on WhatsApp" title="Message on WhatsApp">${ICON.wa}</a>`:'',
    alert:exc?`<div class="sh-exc tone-${exc.tone}" data-testid="sheet-exception">${esc(exc.text)}${exc.amount!=null?' · '+esc(money({amount:exc.amount,currency:t.currency})):''}</div>`:''});
```

- [ ] **Step 5: "Flexible" in amber in the When cell**

In `bookingStubHtml`, the two places that render the When value `'Flexible'` (the Next-leg branch when `f.when.date` is null, and the plain When branch when `!t.date`) render `'<span class="stub-flex">Flexible</span>'` instead. Only the literal changes.

- [ ] **Step 6: CSS**

Add near the `.idrow` rules:

```css
  .sh-exc{margin-top:10px;padding:7px 11px;border-radius:10px;font-weight:700;font-size:.86rem;border:1px solid transparent}
  .sh-exc.tone-amber{background:var(--wait-bg);color:var(--wait);border-color:color-mix(in srgb,var(--wait) 30%,transparent)}
  .sh-exc.tone-red{background:var(--alert-bg);color:var(--alert);border-color:var(--alert-line)}
  .sh-exc.tone-grey{background:var(--idle-bg);color:var(--idle)}
  .stub .stub-flex{color:var(--wait)}
```

- [ ] **Step 7: Run the new spec**

Run: `cd web-tests && npx playwright test e2e/ops-sheet-exception.spec.js`
Expected: PASS (5).

- [ ] **Step 8: Update the specs that read the stepper or the old header tag**

- `web-tests/e2e/ops-balance.spec.js:72`: change `const headTag = (page) => page.locator('#sheet .sheet-h .pill.pill-bal');` to `const headTag = (page) => page.locator('#sheet .sheet-h [data-testid="sheet-exception"]');`.
  - Change each `toHaveText('Balance $169')` on `headTag` (lines 98, 117) to `toHaveText('Balance due · $169')`.
  - The `.idrow .pill` count assertions (lines 100, 130) become `toHaveCount(1)`, since only the stage pill is left in the idrow.
  - Leave the queue-row `.tk .pill-bal` assertions (44, 50, 58) alone: the queue is unchanged.
- `web-tests/e2e/ops-cash-due.spec.js:63-64`: replace the two `.pstep` lines with `await expect(page.locator('#sheet [data-testid="sheet-exception"]')).toContainText('Cash due at the first pickup');`. Line 129 (`.sheet-h .pill.pill-bal` count 0) is still true; leave it.
- `web-tests/e2e/ops-mark-paid.spec.js:121` and `:147`: replace `sheet.locator('.pstep.cur')` with `sheet.locator('.sheet-h .idrow .pill').first()`. Expect `toHaveText('Awaiting payment')` and then `toHaveText('Paid', { timeout: BOOKINGS_TIMEOUT })`. If the pill's text differs, read `stageLabel()` and use its exact strings.

Run: `cd web-tests && npx playwright test e2e/ops-sheet-exception.spec.js e2e/ops-balance.spec.js e2e/ops-cash-due.spec.js e2e/ops-mark-paid.spec.js e2e/ops-sheet-job.spec.js`
Expected: PASS. Then `grep -rln -E "\.pstep|\.pipe\b|pill-bal" web-tests/e2e`. For each hit that targets `#sheet`, confirm it still passes or apply the same mapping. `ops-analytics.spec.js` and `mobile-ux.spec.js` use other `pipe`/`psteps` elements; run them to confirm.

- [ ] **Step 9: Commit**

```bash
git add api/src/routes/ops-ui.html web-tests/e2e/ops-sheet-exception.spec.js web-tests/e2e/ops-balance.spec.js web-tests/e2e/ops-cash-due.spec.js web-tests/e2e/ops-mark-paid.spec.js
git commit -m "feat(ops): booking pane shows one coloured money/outcome line instead of the stepper

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Body order, folded sections, all team notes

**Files:**
- Modify: `api/src/routes/ops-ui.html`: `renderSheet` body template, `buildActivity` (drop notes), a delegated `toggle` listener, CSS
- Create: `web-tests/e2e/ops-sheet-folds.spec.js`
- Modify: e2e specs that click controls now inside a closed fold (Step 7 lists the method)

**Interfaces:**
- Consumes: `sheetException`, `paymentWord`, `noteParts` (Task 1); `exc` from Task 2's `renderSheet` code
- Produces:
  - Folds as `details.block.fold[data-fold="contact"|"payment"|"pickup"|"history"|"refund"]`, each `summary` holding `<h4>Title</h4><span class="fold-sum">…</span>`
  - `state.folds` (object, key → boolean) and `state.foldsFor` (ticket id)
  - The team-notes block `[data-testid="sheet-team-notes"]`
  - Body wrappers `.sb-cols > .sb-main` / `.sb-side` (Task 4 styles them)

- [ ] **Step 1: Write the failing e2e spec**

Create `web-tests/e2e/ops-sheet-folds.spec.js`. Copy `row`, `detail`, `boot`, `open` and the `CASES` object from `web-tests/e2e/ops-sheet-exception.spec.js` (Task 2) verbatim, and add `opsNotes` to the paid row: `row('paid','CH-0001',{ opsNotes: '[2026-11-10 09:12] Customer asked for a child seat\n[2026-11-11 15:40] Van confirmed, driver Sunil' })`. Then the tests:

```js
const fold = (page, k) => page.locator(`#sheet details.fold[data-fold="${k}"]`);

test('contact, payment, pickup, history and refund/cancel are folded on a paid booking', async ({ page }) => {
  await boot(page);
  await open(page, 'paid');
  for (const k of ['contact', 'payment', 'pickup', 'history', 'refund']) {
    await expect(fold(page, k)).toHaveCount(1);
    await expect(fold(page, k)).not.toHaveAttribute('open', '');
  }
  await expect(fold(page, 'payment').locator('summary .fold-sum')).toHaveText('Paid');
  await expect(fold(page, 'contact').locator('summary .fold-sum')).toContainText('+94 77 000 0000');
});

test('payment opens by itself when money needs handling', async ({ page }) => {
  await boot(page);
  await open(page, 'quotelater');
  await expect(fold(page, 'payment')).toHaveAttribute('open', '');
});

test('a fold the operator opened survives a refresh', async ({ page }) => {
  await boot(page);
  await open(page, 'paid');
  await fold(page, 'history').locator('summary').click();
  await expect(fold(page, 'history')).toHaveAttribute('open', '');
  // A toggle on the pickup switch re-renders the sheet through morphSheet.
  await fold(page, 'pickup').locator('summary').click();
  await page.locator('#sheet [data-act="toggle"][data-k="photo"]').click();
  await expect(fold(page, 'history')).toHaveAttribute('open', '');
  await expect(fold(page, 'pickup')).toHaveAttribute('open', '');
});

test('every team note shows, oldest first, with its time', async ({ page }) => {
  await boot(page);
  await open(page, 'paid');
  const notes = page.getByTestId('sheet-team-notes').locator('.tn');
  await expect(notes).toHaveCount(2);
  await expect(notes.nth(0)).toContainText('Customer asked for a child seat');
  await expect(notes.nth(0).locator('.tn-at')).toHaveText('2026-11-10 09:12');
  await expect(notes.nth(1)).toContainText('Van confirmed, driver Sunil');
  // Said once: History no longer repeats the notes.
  await fold(page, 'history').locator('summary').click();
  await expect(fold(page, 'history')).not.toContainText('child seat');
});

test('the duplicate When, Guests and Status rows are gone; the date control stays', async ({ page }) => {
  await boot(page);
  await open(page, 'paid');
  await expect(page.locator('#sheet .sheet-b .kv .k', { hasText: /^(When|Guests|Status)$/ })).toHaveCount(0);
  await expect(page.locator('#sheet [data-act="schedopen"]')).toBeVisible();
});

test('order in one column: note, then itinerary, then team notes', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await boot(page);
  await open(page, 'paid');
  const ys = await page.evaluate(() => ['[data-testid="sheet-customer-note"]', '[data-testid="sheet-itinerary"]', '[data-testid="sheet-team-notes"]']
    .map((s) => document.querySelector('#sheet ' + s).getBoundingClientRect().top));
  expect(ys[0]).toBeLessThan(ys[1]);
  expect(ys[1]).toBeLessThan(ys[2]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web-tests && npx playwright test e2e/ops-sheet-folds.spec.js`
Expected: FAIL. There are no `details.fold` elements yet.

- [ ] **Step 3: Fold state that survives diff-renders**

Add, next to the other delegated sheet listeners (search `document.addEventListener('click'` near the `case 'advance'` handler and put it after that listener's closing):

```js
/* Folded sections remember what the operator opened or closed for as long as this booking stays
   open; a refresh re-renders through morphSheet, which would otherwise reset `open` from the
   template. `toggle` doesn't bubble, so listen in the capture phase. */
document.addEventListener('toggle',e=>{
  const el=e.target;
  if(!(el instanceof HTMLDetailsElement)||!el.matches('#sheet details.fold[data-fold]'))return;
  state.folds=state.folds||{};
  state.folds[el.dataset.fold]=el.open;
},true);
```

- [ ] **Step 4: Rebuild the body**

In `renderSheet`:

(a) Right after `const d=state.detailData;`, add:

```js
  if(state.foldsFor!==t.id){state.foldsFor=t.id;state.folds={};}
```

(b) After the `noteBlock` const, add:

```js
  /* Folded sections (spec 2026-11-12): closed by default, open when the operator opened them, and
     Payment opens by itself when the header's exception line asks for money. */
  const isOpen=(k,dflt)=>(state.folds&&k in state.folds)?state.folds[k]:!!dflt;
  const fold=(k,title,sum,body,dflt)=>`<details class="block fold" data-fold="${k}"${isOpen(k,dflt)?' open':''}><summary><h4>${title}</h4><span class="fold-sum">${sum}</span></summary>${body}</details>`;
  /* Every team note, oldest first, with its time: the one that matters ("child seat", "same
     driver") is often an older one, so never only the latest. */
  const noteRows=t.notes.map(n=>{const p=noteParts(n);return `<div class="tn">${p.at?`<span class="tn-at">${esc(p.at)}</span>`:''}<span class="tn-text">${esc(p.text)}</span></div>`;}).join('');
  const teamNotes=`<div class="block" data-testid="sheet-team-notes"><h4>Team notes${t.notes.length?' · '+t.notes.length:''}</h4>${noteRows||'<p class="muted" style="padding:0;margin:0">No notes yet.</p>'}
        <div class="notebox"><input id="noteinput" placeholder="Add an internal note…"><button class="btn btn-go" data-act="addnote" data-id="${esc(t.id)}">Add</button></div></div>`;
  const phoneTxt=String(cust?.whatsapp||'').trim();
  const contactSum=esc([phoneTxt||'No WhatsApp',cust?.country].filter(Boolean).join(' · '));
  const pickupSum=`${t.photo?'photo in':'photo not in'} · ${t.updated?'pickup confirmed':'pickup not confirmed'}`;
  const history=buildActivity(t,d);
  const isTrip=d?.booking?.mode==='trip';
```

(c) Replace the whole `morphSheet(sh,head+\`…\`+sheetFootHtml(t,nx));` call with:

```js
  morphSheet(sh,head+`
    <div class="sheet-b">
      <div class="sb-cols">
        <div class="sb-main">
          ${pendingBlock?`<div class="ord-0">${pendingBlock}</div>`:''}
          <div class="block ord-2" data-testid="sheet-itinerary"><h4>${isTrip?'Itinerary':'Route'}</h4>
            <div style="margin-bottom:6px">${legsHtmlFor(d)}</div>
            ${extrasRow}
            ${canSchedule?`<div class="sched-row"><button class="btn" data-act="schedopen" data-id="${esc(t.id)}">${t.date?'Change date &amp; time':'Set date &amp; time'}</button></div>`:''}
            ${canSchedule&&state.schedOpen===t.id?scheduleFormHtml(t,d):''}
          </div>
        </div>
        <div class="sb-side">
          <div class="ord-1">${noteBlock}</div>
          <div class="ord-3">${teamNotes}</div>
          ${interestBlock?`<div class="ord-4">${interestBlock}</div>`:''}
          <div class="ord-5">
            ${fold('contact','Contact',contactSum,`
              <div class="kv"><span class="k">WhatsApp</span><span class="v">${memberPhoneHtml(cust?.whatsapp)}</span></div>
              <div class="kv"><span class="k">Email</span><span class="v">${esc(cust?.email||'—')}</span></div>
              <div class="kv"><span class="k">Country</span><span class="v">${esc(cust?.country||'—')}</span></div>`)}
            ${fold('payment','Payment',esc(paymentWord(t,cashDue(t))),`
              ${t.paid&&t.balance>0?`<div class="followup bal-card"><div>
                <b>Balance due · ${money({amount:t.balance,currency:t.currency})}</b>
                <div style="margin-top:3px;font-size:.82rem;color:var(--ink-soft)">Deposit of ${money({amount:t.paidCents,currency:t.currency})} paid.${d.balancePayLink?' The customer pays the rest on the link they already have.':''}</div>
                ${d.balancePayLink?`<div style="margin-top:10px"><button class="btn btn-go" data-act="balancelink" data-id="${esc(t.id)}" title="The customer's own pay link — it now shows the balance">${ICON.copy} Balance payment link</button></div>`:''}
              </div></div>`:''}
              <div class="kv"><span class="k">Amount</span><span class="v">${money(t)}</span></div>
              ${promoRow}
              ${t.paid&&t.balance>0?`<div class="kv"><span class="k">Paid so far</span><span class="v">${money({amount:t.paidCents,currency:t.currency})}</span></div>`:''}
              <div class="kv"><span class="k">Channel</span><span class="v">${chanLabel(t.chan)}</span></div>
              ${cashDue(t)?`<p style="margin:10px 0 0;font-size:.84rem;color:var(--ink-soft)">Pay on the day — ${money({amount:t.cashDue,currency:t.currency})} in US dollars cash to the Ceylon Hop team, at the first pickup. ${canSettle?"Record it here when it's collected.":"A founder or finance records it when it's collected."}</p>${settle?`<div class="sheet-actions">${settle}</div>`:''}`
              :!t.paid?`<p style="margin:10px 0 0;font-size:.84rem;color:var(--ink-soft)">Not received yet — it can still arrive through the payment link, or be paid directly and ${recordedBy}.</p>`:''}
              ${canSettle?`<div class="lk-act"><button class="btn" data-act="lookup" data-ref="${esc(t.ref)}">Payment history →</button></div>`:''}
              ${paymentAttemptsHtmlFor(d)}`,exc&&exc.openPayment)}
            ${fold('pickup','Vehicle &amp; pickup',pickupSum,`
              <div class="kv"><span class="k">Assigned</span><span class="v">${idx>=STAGES.indexOf('vehicle_confirmed')?'<span style="color:var(--ok);font-weight:700">Vehicle confirmed</span>':'<span style="color:var(--alert);font-weight:700">Not yet</span>'}</span></div>
              <div class="togg"><span>Vehicle photo received</span><button class="switch ${t.photo?'on':''}" data-act="toggle" data-id="${esc(t.id)}" data-k="photo"></button></div>
              <div class="togg"><span>Customer contacted · pickup confirmed</span><button class="switch ${t.updated?'on':''}" data-act="toggle" data-id="${esc(t.id)}" data-k="updated"></button></div>`)}
            ${fold('history','History',`${history.length} ${history.length===1?'entry':'entries'}`,history.map(a=>`<div class="act"><div class="at">${esc(a[0])}</div><div class="am">${esc(a[1])}</div></div>`).reverse().join('')||'<p class="muted" style="padding:0">No activity yet.</p>')}
          </div>
        </div>
      </div>
      ${fold('refund','Refund or cancel','',`${refundHtmlFor(t,d)}${reverseActionsFor(t,d)}`)}
    </div>`+sheetFootHtml(t,nx));
```

Notes on this step:
- The "Follow up with the customer using the **payment reminder**" sentence is dropped from the unpaid paragraph (owner: don't chase website checkouts). The sticky foot's reminder button is unchanged.
- Delete the now-unused `const acts=…` line near the top of `renderSheet`.
- In `pendingBlock` (the "Next up" block), the sentence ends "… Nudge them if it's overdue." Keep that sentence only when `t.chan!=='website'`. A website checkout must not tell ops to chase (owner rule, Global Constraints). Write it as `${t.chan==='website'?'':" Nudge them if it's overdue."}` in place of the fixed text.
- Leave `extrasRow` as it is: it now sits under the legs.

(d) In `buildActivity`, delete the line `  t.notes.forEach(n=>acts.push(['Note',n]));`. Then run `grep -n "buildActivity(" api/src/routes/ops-ui.html`. If any caller other than `renderSheet` exists, keep the notes for that caller by adding a second parameter instead: `buildActivity(t,d,{notes:true})`. Report which you did.

- [ ] **Step 5: CSS**

```css
  details.fold{padding:0;border-bottom:1px solid var(--line-soft)}
  details.fold>summary{list-style:none;cursor:pointer;display:flex;align-items:baseline;gap:10px;padding:13px 0}
  details.fold>summary::-webkit-details-marker{display:none}
  details.fold>summary h4{margin:0;flex:none}
  details.fold>summary .fold-sum{flex:1;min-width:0;color:var(--ink-soft);font-size:.84rem;overflow-wrap:anywhere}
  details.fold>summary::after{content:"";flex:none;width:8px;height:8px;border-right:2px solid var(--ink-faint);border-bottom:2px solid var(--ink-faint);transform:rotate(45deg);margin-right:4px;align-self:center}
  details.fold[open]>summary::after{transform:rotate(-135deg)}
  details.fold>summary:focus-visible{outline:2px solid var(--teal);outline-offset:2px;border-radius:6px}
  details.fold[open]{padding-bottom:14px}
  .tn{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;padding:4px 0;font-size:.88rem}
  .tn-at{color:var(--ink-faint);font-size:.76rem;font-variant-numeric:tabular-nums;padding-top:2px}
  .tn-text{overflow-wrap:anywhere;white-space:pre-line}
  .sched-row{margin-top:8px}
  .sb-cols{display:flex;flex-direction:column}
  .sb-main,.sb-side{display:contents}
  .ord-0{order:0}.ord-1{order:1}.ord-2{order:2}.ord-3{order:3}.ord-4{order:4}.ord-5{order:5}
```

(One column is the default: the wrappers use `display:contents` and the `order` classes give Next up, note, itinerary, team notes, interests, folds. Task 4 adds the wide two-column rule.) `.ord-2` is on the itinerary `.block` itself, the others on wrappers. That's fine, since they are all flex children of `.sb-cols` once the wrappers are `contents`.

- [ ] **Step 6: Run the new spec**

Run: `cd web-tests && npx playwright test e2e/ops-sheet-folds.spec.js e2e/ops-sheet-job.spec.js e2e/ops-sheet-exception.spec.js e2e/ops-sheet-customer-note.spec.js`
Expected: PASS.

- [ ] **Step 7: Open folds in the specs that drive folded controls**

Run the specs that touch the sheet:
`cd web-tests && npx playwright test $(grep -l -E "#sheet|\.sheet-b|data-act=\"(toggle|addnote|lookup|markpaid|paylink|balancelink|refund|cancel)" e2e/*.spec.js | tr '\n' ' ')`

For every failure where the control or text is inside a fold that's closed in that test's booking, add one line before the first interaction: `await page.locator('#sheet details.fold[data-fold="<key>"] > summary').click();`. Use the fold that holds the control:

| Control / text | Fold |
|---|---|
| `[data-act="toggle"]`, "Assigned" | `pickup` |
| refund rows, `Refund`/`Cancel booking` buttons, `refundHtmlFor` / `reverseActionsFor` content | `refund` |
| `Payment history →`, payment attempts, Amount/Channel rows on a **paid** booking | `payment` |
| email / country text | `contact` |
| activity entries | `history` |

Add nothing for unpaid, deposit or cash bookings: Payment is already open there. Specs that wait for the sheet via `h4` `/^Customer$/` (`ops-lookup.spec.js:185,274,289`, `ops-payment-attempts.spec.js:45`) now find "Contact". Change those matchers to `{ hasText: /^Contact$/ }`. `#noteinput` / `addnote` stay visible (Team notes isn't folded). Re-run until green, and list every spec you touched in the report.

- [ ] **Step 8: Commit**

```bash
git add api/src/routes/ops-ui.html web-tests/e2e/ops-sheet-folds.spec.js <each spec touched in Step 7, by path>
git commit -m "feat(ops): booking pane leads with the job; contact, payment, pickup, history and refunds fold away

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wider pane with two columns on large screens

**Files:**
- Modify: `api/src/routes/ops-ui.html`: CSS only
- Modify: `web-tests/e2e/ops-sheet-folds.spec.js` (append)

**Interfaces:**
- Consumes: `.sb-cols`, `.sb-main`, `.sb-side`, `.ord-*` (Task 3)

- [ ] **Step 1: Append the failing tests**

```js
test('on a large screen the pane is 780px with the itinerary left and notes right', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await open(page, 'paid');
  const w = await page.locator('#sheet').evaluate((el) => el.getBoundingClientRect().width);
  expect(Math.round(w)).toBe(780);
  const box = async (s) => page.locator('#sheet ' + s).boundingBox();
  const itin = await box('[data-testid="sheet-itinerary"]');
  const note = await box('[data-testid="sheet-customer-note"]');
  expect(note.x).toBeGreaterThan(itin.x + itin.width - 1); // note sits in the right column
  expect(Math.abs(note.y - itin.y)).toBeLessThan(40);       // side by side, not stacked
});

test('below 900px the pane keeps today’s width and one column', async ({ page }) => {
  await page.setViewportSize({ width: 880, height: 900 });
  await boot(page);
  await open(page, 'paid');
  const w = await page.locator('#sheet').evaluate((el) => el.getBoundingClientRect().width);
  expect(Math.round(w)).toBe(500);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd web-tests && npx playwright test e2e/ops-sheet-folds.spec.js -g "large screen|below 900"`
Expected: the first FAILS (width 500); the second passes.

- [ ] **Step 3: CSS**

Add after the `.sheet{…}` and `.sheet.show` rules (keep the existing `@media(max-width:700px)` phone rule as is):

```css
  /* Spec 2026-11-12 decision 8: the scrim already covers the queue, so 500px saved nothing. On a
     large screen the booking sheet (not the ride-board one, which has no .sb-cols) gets two
     columns: the job left, the note, team notes and folds right. */
  @media(min-width:900px){
    .sheet:has(.sb-cols){width:780px}
    .sb-cols{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:0 26px;align-items:start}
    .sb-main,.sb-side{display:block;min-width:0}
  }
```

Only the booking sheet has `.sb-cols`, so the ride-board sheet keeps 500px (Global Constraints: ride-board sheet unchanged). Add one assertion to the "large screen" test's spec file only if a ride-board fixture is easy to add; otherwise check the board sheet's width in the Task 5 visual check.

- [ ] **Step 4: Run**

Run: `cd web-tests && npx playwright test e2e/ops-sheet-folds.spec.js e2e/ops-sheet-job.spec.js e2e/ops-sheet-exception.spec.js`
Expected: PASS. Also run any spec that measures the sheet's width or position: `grep -rln -E "#sheet.*(boundingBox|getBoundingClientRect|width)" web-tests/e2e`.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/ops-ui.html web-tests/e2e/ops-sheet-folds.spec.js
git commit -m "feat(ops): booking pane is 780px with two columns on large screens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Full gate, visual check, PR (after #1169 merges)

- [ ] **Step 1: Full gate on the branch as built**

```bash
cd web-tests && npm run test:all; echo "exit=$?"
cd ../api && DATABASE_URL_TEST=postgresql://postgres:postgres@localhost:5432/ceylonhop_test npm run check; echo "exit=$?"
```
Expected: both runners' summary lines show 0 failed, and `exit=0`. Under heavy load (`uptime` above ~30), rerun any timed-out file alone before calling it a failure, and report both runs.

- [ ] **Step 2: Visual check**

Use the throwaway screenshot method from PR 1. Copy the folds spec's fixtures into a temporary `web-tests/e2e/zz-shots.tmp.spec.js`, shoot `#sheet`, then delete the file. Cover:
- paid, at 1440×900 and 880×900
- the WhatsApp quote travelling soon (red line)
- the website checkout (amber)
- cancelled (grey)
- phone at 390×844

Check by eye:
- the two columns align at the top
- no fold summary is cut off
- the red/amber/grey lines are legible in light and dark (`:root[data-theme="dark"]`)
- the note appears before the itinerary in one column

- [ ] **Step 3: Wait for #1169, then rebase**

Check with `gh pr view 1169 --json state,mergedAt`. Only once it's `MERGED`:

```bash
git fetch origin && git rebase origin/main
```

PR 1's commits drop out as already merged. If `ops-ui.html` conflicts, keep main's version of PR 1's code and re-apply this branch's hunks. Then re-run Step 1.

- [ ] **Step 4: Push and open the PR against `main`**

Open it with `gh pr create --base main`. The body covers:
- what changed: the exception line and its colour rules, the stepper removed, the order, folds, all team notes, and the 780px two-column layout
- what's not in it: the map, the ride board
- TDD evidence, and the gate summary lines

End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Then bind it with the ccd_pr tools. Merging to `main` deploys staging; prod needs the owner's promote.

---

## Self-review notes

- **Spec coverage for PR 2:**
  - decision 1 (order) and items 0–6 of "Body" → Task 3
  - decision 2 (money only rises), the exceptions line, and decision 11 (colours) → Tasks 1–2
  - decision 5 (pill stays, stepper goes) → Task 2
  - decision 7 (duplicates go) → Task 3
  - decision 8 (wider pane) → Task 4
  - folds via `<details>` that survive diff-renders → Task 3 Steps 3–4
  - "Flexible" in amber → Task 2 Step 5
- **Deliberately not here:** the map (PR 3), the ride-board pane (PR 4), and "May not fit" (still needs the rate card checked on the bookings view).
- **Interim behaviour:** a closed booking's job details are not greyed. The spec says "greyed"; the grey outcome line carries it in PR 2. Greying the body is a CSS tweak to add if the owner wants it after seeing the screenshots.
