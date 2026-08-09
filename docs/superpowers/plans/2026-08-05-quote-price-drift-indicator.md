# Quote price-drift indicator (Slice 1) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show ops, beside the quote total, what the customer was last quoted — so a silent price
change can't reach a customer unnoticed.

**Architecture:** Three nullable columns on `quotes` record the quote total at each
customer-facing moment (mark-sent, pay-link mint). The ops builder renders one quiet line beside
the total whenever that baseline differs from the live price. No new tables, no transactions, no
new endpoints.

**Tech Stack:** TypeScript, Hono, Drizzle (Postgres), Vitest (`api/`), Vitest + Playwright
(`web-tests/`). The ops UI is hand-written vanilla JS in one HTML file.

**Spec:** `docs/superpowers/specs/2026-08-05-quote-history-design.md` — read §9 and §11 first.
This plan is **Slice 1 only**. Slice 2 (the `quote_revisions` table, the `/revisions` endpoint and
the history panel) is deliberately not here and gets its own plan.

## Global Constraints

- The baseline stores **`quote.totalCents`** — the quote total at that moment — **never the amount
  a partial link charged**. A partial-leg link charges less by design, so stamping the charged
  amount shows permanent false drift on every quote that ever had one (spec §9).
- **The indicator's absence is the all-clear.** It must never be suppressed for any reason other
  than "the baseline equals the live total". No "hide while estimating", no "hide on partial".
- Stamping is **additive to existing patches** — it must not touch `status`, `sentAt`, `revision`
  or the assignee.
- Migration is `0039`, and **it needs a `drizzle/meta/_journal.json` entry**. Without one the
  migration silently never runs and every select against the new columns 500s on boot.
- Amounts are integer USD cents.
- `cd api && npx vitest run` for API tests; `cd web-tests && npx vitest run unit/` for web units.
- Commit per task. Work in an isolated worktree off `origin/main` — never in the shared tree.

## File Structure

| File | Responsibility |
| --- | --- |
| `api/drizzle/0039_customer_total_baseline.sql` (new) | the three additive columns |
| `api/drizzle/meta/_journal.json` | the entry that makes 0039 actually run |
| `api/src/db/schema.ts` | Drizzle column definitions |
| `api/src/db/quoteRepo.ts` | `SavedQuote` / `QuotePatch` fields; in-memory behaviour |
| `api/src/db/postgresQuoteRepo.ts` | row mapper + `patch()` spreads |
| `api/src/routes/internalQuote.ts` | stamp on status→`sent`; stamp on pay-link mint |
| `api/src/routes/ops-ui.html` | the indicator, its CSS, and state hydration |

---

### Task 1: The baseline columns

**Files:**
- Create: `api/drizzle/0039_customer_total_baseline.sql`
- Modify: `api/drizzle/meta/_journal.json`
- Modify: `api/src/db/schema.ts` (the `quotes` table)
- Modify: `api/src/db/quoteRepo.ts` (`SavedQuote`, `QuotePatch`, `InMemoryQuoteRepo`)
- Modify: `api/src/db/postgresQuoteRepo.ts` (`quoteRowToSaved`, `patch`)
- Test: `api/src/db/quoteRepo.test.ts`

**Interfaces:**
- Produces: `SavedQuote.customerTotalCents: number | null`, `SavedQuote.customerTotalAt: Date | null`,
  `SavedQuote.customerTotalVia: 'sent' | 'pay_link' | null`; the same three as optional fields on
  `QuotePatch`.

- [ ] **Step 1: Write the failing test**

Append to `api/src/db/quoteRepo.test.ts` (reuse the file's existing `sample()` fixture):

```ts
describe('customer-facing price baseline (spec 2026-08-05)', () => {
  it('defaults to no baseline', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    expect(q.customerTotalCents).toBeNull();
    expect(q.customerTotalAt).toBeNull();
    expect(q.customerTotalVia).toBeNull();
  });

  it('round-trips a baseline through patch', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    const at = new Date('2026-08-05T10:00:00.000Z');
    const patched = await repo.patch(q.id, {
      customerTotal: { cents: 10900, at, via: 'sent' },
    });
    expect(patched!.customerTotalCents).toBe(10900);
    expect(patched!.customerTotalAt).toEqual(at);
    expect(patched!.customerTotalVia).toBe('sent');
  });

  // The three fields move as ONE unit, like rateLock — a baseline amount with no date, or a date
  // with no amount, would render an indicator that can't say when.
  it('leaves the baseline alone when the patch does not mention it', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    await repo.patch(q.id, { customerTotal: { cents: 10900, at: new Date(), via: 'sent' } });
    await repo.patch(q.id, { status: 'pending_review' });
    expect((await repo.get(q.id))!.customerTotalCents).toBe(10900);
  });

  // An edit must NEVER move the baseline: the whole point is that it records what the customer
  // saw, not what the quote currently says.
  it('survives a content update', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    await repo.patch(q.id, { customerTotal: { cents: 10900, at: new Date(), via: 'sent' } });
    const updated = await repo.update(q.id, sample({ totalCents: 9900 }));
    expect(updated!.customerTotalCents).toBe(10900);
    expect(updated!.totalCents).toBe(9900);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/db/quoteRepo.test.ts -t "baseline"`
Expected: FAIL — `customerTotalCents` is not a known property.

- [ ] **Step 3: Write the migration**

Create `api/drizzle/0039_customer_total_baseline.sql`:

```sql
-- Price-drift indicator (spec 2026-08-05 §9). The quote TOTAL as of the last customer-facing
-- moment, so the ops builder can show "Sent at $109.00 - now $99.00".
--
-- Deliberately the quote total, NOT the amount charged: a partial-leg link charges less than the
-- total by design, so storing the charged amount would show permanent drift on every quote that
-- ever had one. The charged amount already lives in quotes.sold_cents.
ALTER TABLE "quotes" ADD COLUMN "customer_total_cents" integer;
ALTER TABLE "quotes" ADD COLUMN "customer_total_at" timestamptz;
ALTER TABLE "quotes" ADD COLUMN "customer_total_via" text;
```

- [ ] **Step 4: Register it in the journal**

⚠️ Without this the migration never runs. Append to the `entries` array in
`api/drizzle/meta/_journal.json`, copying the shape of the last entry and incrementing `idx` and
`when`:

```json
{ "idx": 39, "version": "7", "when": 1786344000000, "tag": "0039_customer_total_baseline", "breakpoints": true }
```

- [ ] **Step 5: Add the Drizzle columns**

In `api/src/db/schema.ts`, inside the `quotes` table beside `payLinkSelection`:

```ts
  // Price-drift indicator (spec 2026-08-05). The quote TOTAL when the customer was last quoted —
  // via mark-sent or a pay-link mint. Never the amount a partial link charged (see the migration).
  customerTotalCents: integer('customer_total_cents'),
  customerTotalAt: timestamp('customer_total_at', { withTimezone: true }),
  customerTotalVia: text('customer_total_via'),
```

- [ ] **Step 6: Extend the repo types and the in-memory repo**

In `api/src/db/quoteRepo.ts`, add to `SavedQuote`:

```ts
  customerTotalCents: number | null;
  customerTotalAt: Date | null;
  customerTotalVia: 'sent' | 'pay_link' | null;
```

and to `QuotePatch`:

```ts
  // Price-drift baseline (spec 2026-08-05). Moves as a UNIT, like rateLock: `undefined` = leave
  // alone, an object = stamp all three. There is no clear case — a quote that has been shown to a
  // customer has been shown to a customer.
  customerTotal?: { cents: number; at: Date; via: 'sent' | 'pay_link' };
```

In `InMemoryQuoteRepo`: default all three to `null` in `save()`; in `patch()` apply them together
under one `if (patch.customerTotal !== undefined)`; in `update()` **do not touch them** (a content
edit must never move the baseline — that is what the Step 1 test pins).

- [ ] **Step 7: Persist them in Postgres**

In `api/src/db/postgresQuoteRepo.ts`:

- `quoteRowToSaved`: map the three (`customerTotalCents: r.customerTotalCents ?? null`,
  `customerTotalAt: r.customerTotalAt ?? null`,
  `customerTotalVia: (r.customerTotalVia ?? null) as SavedQuote['customerTotalVia']`).
- `patch()`: add one spread alongside the others —

```ts
        ...(patch.customerTotal !== undefined
          ? {
              customerTotalCents: patch.customerTotal.cents,
              customerTotalAt: patch.customerTotal.at,
              customerTotalVia: patch.customerTotal.via,
            }
          : {}),
```

- `update()`: add nothing. The baseline is not content.

- [ ] **Step 8: Run the tests**

Run: `cd api && npx vitest run src/db/quoteRepo.test.ts`
Expected: PASS, including the four new cases.

Then the whole suite, because `SavedQuote` gained required fields:

Run: `cd api && npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: typecheck clean, suite green.

- [ ] **Step 9: Commit**

```bash
git add api/drizzle/0039_customer_total_baseline.sql api/drizzle/meta/_journal.json api/src/db/schema.ts api/src/db/quoteRepo.ts api/src/db/postgresQuoteRepo.ts api/src/db/quoteRepo.test.ts
git commit -m "feat(db): record the quote total at each customer-facing moment"
```

---

### Task 2: Stamp the baseline on mark-sent

**Files:**
- Modify: `api/src/routes/internalQuote.ts` (the `r.patch('/:id')` route, ~line 1153)
- Test: `api/src/routes/internalQuote.test.ts`

**Interfaces:**
- Consumes: `QuotePatch.customerTotal` from Task 1.

- [ ] **Step 1: Hoist the shared fixtures first**

⚠️ `ENGINE3`, `priced()` and `mintSel()` currently live **inside** the
`describe('POST /admin/quote/:id/pay-link with a selection (spec 2026-08-04)')` block
(`internalQuote.test.ts`, from ~line 2650). Tasks 2 and 3 both need them from new top-level
`describe` blocks, so a straight append fails with `priced is not defined`.

Move those three declarations to module scope, immediately **above** that describe block. Nothing
else changes — the existing block keeps using them unqualified.

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: PASS, unchanged count. This is a pure move; if anything goes red, the move was wrong.

- [ ] **Step 2: Write the failing test**

Append to `api/src/routes/internalQuote.test.ts`, now that the helpers are reachable. `priced()`
builds a real priced 3-leg quote and walks it to `ready`.

```ts
describe('price-drift baseline (spec 2026-08-05)', () => {
  const toStatus = (app: App, id: string, status: string) =>
    app.request(`/admin/quote/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: FOUNDER_COOKIE },
      body: JSON.stringify({ status }),
    });

  it('marking a quote sent records the total the customer was quoted', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await priced(quotes); // walks to 'ready'
    const total = (await quotes.get(id))!.totalCents;
    const app = createApp({ quotes });

    expect((await toStatus(app, id, 'sent')).status).toBe(200);

    const q = await quotes.get(id);
    expect(q!.customerTotalCents).toBe(total);
    expect(q!.customerTotalVia).toBe('sent');
    expect(q!.customerTotalAt).toBeInstanceOf(Date);
  });

  it('a non-sent transition does not stamp it', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await priced(quotes);
    const app = createApp({ quotes });
    await toStatus(app, id, 'draft'); // reopen to edit
    expect((await quotes.get(id))!.customerTotalCents).toBeNull();
  });

  it('re-sending after a re-price moves the baseline to the new number', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await priced(quotes);
    const app = createApp({ quotes });
    await toStatus(app, id, 'sent');
    // Re-price behind the scenes, then walk back round to sent.
    await quotes.patch(id, { status: 'draft' });
    await quotes.update(id, { ...(await quotes.get(id))!, totalCents: 15000 } as never);
    for (const s of ['pending_review', 'ready', 'sent']) await toStatus(app, id, s);
    expect((await quotes.get(id))!.customerTotalCents).toBe(15000);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t "price-drift baseline"`
Expected: FAIL — `customerTotalCents` is null after marking sent.

- [ ] **Step 4: Implement**

In `r.patch('/:id')`, the route already reads the pre-patch row into `current` whenever
`body.status` is present. Add above the `deps.quotes.patch(...)` call:

```ts
    // Price-drift baseline (spec 2026-08-05 §9). Sending a quote IS the moment a customer is
    // quoted a number, so record the total as it stands right now. Read from the STORED row, not
    // the body — only POST /save writes pricing, so a body value here would be a hole.
    const customerTotal: QuotePatch['customerTotal'] =
      body.status === 'sent' && current
        ? { cents: current.totalCents, at: new Date(), via: 'sent' as const }
        : undefined;
```

and pass it through:

```ts
    const updated = await deps.quotes.patch(c.req.param('id'), {
      status: body.status as QuoteStatus | undefined,
      lostReason: body.lostReason,
      notes: body.notes,
      internalNotes: body.internalNotes,
      rateLock,
      assignedTo,
      updatedBy: c.get('identity').email,
      customerTotal,
    });
```

- [ ] **Step 5: Run the tests**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: PASS — the new block plus every existing PATCH test.

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts
git commit -m "feat(ops): record the quoted total when a quote is marked sent"
```

---

### Task 3: Stamp the baseline on a pay-link mint

A pay link is the other way a customer is shown a price — and for many quotes it is the *only*
way, since ops can send a link without ever pressing Mark sent.

**Files:**
- Modify: `api/src/routes/internalQuote.ts` (the `/:id/pay-link` route)
- Test: `api/src/routes/internalQuote.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('pay-link mint stamps the baseline (spec 2026-08-05)', () => {
  it('a full-total mint records the quote total', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await priced(quotes);
    const total = (await quotes.get(id))!.totalCents;
    const app = createApp({ quotes });

    await mintSel(app, id); // bodyless — the classic full-total link

    const q = await quotes.get(id);
    expect(q!.customerTotalCents).toBe(total);
    expect(q!.customerTotalVia).toBe('pay_link');
  });

  // THE trap this task exists for (spec §9). A partial link CHARGES less than the quote total.
  // Storing the charged amount would leave the indicator permanently lit on this quote.
  it('a PARTIAL mint records the quote total, not the amount charged', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await priced(quotes);
    const total = (await quotes.get(id))!.totalCents;
    const app = createApp({ quotes });

    const body = await (await mintSel(app, id, { legIndexes: [0], extraIndexes: [] })).json();
    expect(body.amountCents).toBeLessThan(total); // the link really does charge less

    const q = await quotes.get(id);
    expect(q!.customerTotalCents).toBe(total);
    expect(q!.soldCents).toBe(body.amountCents); // the charged amount is not lost
  });

  // The mint currently patches ONLY when the selection changed, so re-minting an identical
  // selection writes nothing — the baseline must still be there from the first mint.
  it('re-minting the same link leaves the baseline in place', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await priced(quotes);
    const app = createApp({ quotes });
    await mintSel(app, id);
    const first = (await quotes.get(id))!.customerTotalAt;
    await mintSel(app, id);
    expect((await quotes.get(id))!.customerTotalAt).toEqual(first);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t "stamps the baseline"`
Expected: FAIL — the first two cases find `customerTotalCents` null.

- [ ] **Step 3: Implement**

The mint currently patches only when the selection changed. Extend that condition so the baseline
is stamped whenever it is missing or stale, and always with `quote.totalCents`:

```ts
    // Price-drift baseline (spec 2026-08-05 §9). Minting a link is a customer-facing moment, so
    // record the quote TOTAL — deliberately NOT `amountCents`, which for a partial link is less
    // than the total by design and would leave the indicator permanently lit. The charged amount
    // is already persisted as soldCents above.
    const baselineStale = quote.customerTotalCents !== quote.totalCents;
    const customerTotal = baselineStale
      ? { cents: quote.totalCents, at: new Date(), via: 'pay_link' as const }
      : undefined;

    if (changed || customerTotal) {
      await deps.quotes.patch(quote.id, {
        ...(changed
          ? {
              payLinkSelection: selection,
              soldCents: selection ? amountCents : null,
              payLinkSeq: seq,
            }
          : {}),
        ...(customerTotal ? { customerTotal } : {}),
      });
    }
```

Note the existing `const seq = changed ? quote.payLinkSeq + 1 : quote.payLinkSeq;` is unchanged —
stamping a baseline must never bump the seq, or it would retire the link it just minted.

- [ ] **Step 4: Run the tests**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: PASS — including every partial-leg pay-link test from PR #307, especially
"re-minting the same selection returns the identical URL and leaves seq alone".

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts
git commit -m "feat(ops): record the quoted total when a payment link is minted"
```

---

### Task 4: The indicator

**Files:**
- Modify: `api/src/routes/ops-ui.html` (state hydration, `renderSummaryCardBody`, CSS)
- Test: `web-tests/unit/ops-price-drift.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `web-tests/unit/ops-price-drift.test.js`, using the house `loadFn` pattern (extracts the
real function from `ops-ui.html`, so the test can never drift from the page):

```js
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFn(signature) {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const re = new RegExp('function ' + signature.replace(/[()]/g, '\\$&') + ' \\{[\\s\\S]*?\\n\\}');
  const m = html.match(re);
  if (!m) throw new Error(signature + ' not found in ops-ui.html');
  const fmtUsd = (c) => '$' + (c / 100).toFixed(2);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  // eslint-disable-next-line no-new-func
  return new Function('fmtUsd', 'esc', 'return (' + m[0] + ')')(fmtUsd, esc);
}
const priceDriftHtml = loadFn('priceDriftHtml(baselineCents, via, liveCents)');

describe('price-drift indicator', () => {
  it('names the drift when the live total differs', () => {
    const html = priceDriftHtml(10900, 'sent', 9900);
    expect(html).toContain('$109.00');
    expect(html).toContain('$99.00');
    expect(html).toContain('Sent at');
  });

  it('says "Link sent at" when the baseline came from a payment link', () => {
    expect(priceDriftHtml(10900, 'pay_link', 9900)).toContain('Link sent at');
  });

  // Story 2: absence IS the all-clear, so equality must render nothing at all.
  it('renders nothing when the price matches what was quoted', () => {
    expect(priceDriftHtml(10900, 'sent', 10900)).toBe('');
  });

  it('renders nothing when the customer has never been quoted', () => {
    expect(priceDriftHtml(null, null, 9900)).toBe('');
  });

  // A rise is as important as a drop — the customer was quoted less than we now want.
  it('shows an increase too', () => {
    expect(priceDriftHtml(9900, 'sent', 15000)).toContain('$150.00');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web-tests && npx vitest run unit/ops-price-drift.test.js`
Expected: FAIL — `priceDriftHtml(...) not found in ops-ui.html`.

- [ ] **Step 3: Implement the renderer**

Add to `api/src/routes/ops-ui.html`, beside `renderSummaryCardBody`:

```js
/* Price drift (spec 2026-08-05 §9). One quiet line beside the total: what the customer was last
   quoted, against what the quote says now. Owner call — an indicator, NOT a toast and NOT a
   confirmation gate.

   Its ABSENCE is the all-clear, so this returns '' for exactly one reason: the numbers match.
   Never add a "hide while estimating" or "hide when partial" branch — a silent indicator that
   means "I don't know" is indistinguishable from one that means "you're fine", which is the
   failure this whole feature exists to prevent. */
function priceDriftHtml(baselineCents, via, liveCents) {
  if (baselineCents == null || liveCents == null) return '';
  if (baselineCents === liveCents) return '';
  var lead = via === 'pay_link' ? 'Link sent at' : 'Sent at';
  return '<div class="ch-drift">'
    + esc(lead) + ' <b>' + esc(fmtUsd(baselineCents)) + '</b>'
    + ' &middot; now <b>' + esc(fmtUsd(liveCents)) + '</b>'
    + '</div>';
}
```

- [ ] **Step 4: Render it and hydrate the state**

In `renderSummaryCardBody`, immediately after the `ch-total` block is pushed (the priced branch,
around the existing `lastEstimatePartial` note):

```js
  lines.push(priceDriftHtml(state.customerTotalCents, state.customerTotalVia, est.total.cents));
```

Hydrate the two state fields wherever a quote is opened — beside the existing
`state.status = q.status || 'draft';` lines (there are two such sites, the shell branch and the
normal branch):

```js
  state.customerTotalCents = (q.customerTotalCents == null) ? null : Number(q.customerTotalCents);
  state.customerTotalVia = q.customerTotalVia || null;
```

Reset both to `null` in `resetToNew()`, next to the other per-quote fields.

And in `transition()`, where the PATCH response already refreshes state
(`if (res.status) state.status = res.status;`), pick the baseline up too — marking a quote sent
stamps it server-side, and the indicator must reflect that without a reload:

```js
    if (res.customerTotalCents !== undefined) {
      state.customerTotalCents = (res.customerTotalCents == null) ? null : Number(res.customerTotalCents);
      state.customerTotalVia = res.customerTotalVia || null;
    }
```

`GET /admin/quote/:id` and `PATCH /admin/quote/:id` both echo the full `SavedQuote` (minus margin),
so no server-side projection change is needed.

- [ ] **Step 5: Add the CSS**

Beside the existing `.qv .ch-total*` rules:

```css
/* Price drift (2026-08-05): quiet by design — it sits under the total and states a fact. The
   fade matches the total's own colour transition so the pane never snaps. */
.qv .ch-drift { margin-top: 6px; font-size: 12px; color: var(--muted-2); animation: chDriftIn .35s cubic-bezier(.23,.9,.32,1) both; }
.qv .ch-drift b { font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
@keyframes chDriftIn { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
```

- [ ] **Step 6: Run the tests**

```bash
cd web-tests && npx vitest run unit/ops-price-drift.test.js
```
Expected: PASS, 5 tests.

Then confirm the page still parses and nothing else broke:

```bash
cd web-tests && npx vitest run unit/
```
Expected: PASS.

```bash
cd api && npx vitest run src/routes/opsUi
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/src/routes/ops-ui.html web-tests/unit/ops-price-drift.test.js
git commit -m "feat(ops-ui): show when the price has moved since the customer was quoted"
```

---

## Verification before finishing

```bash
cd api && npx tsc --noEmit -p tsconfig.json && npx vitest run
```

```bash
cd web-tests && npm run test:all
```

Known-good baseline: two `ops-ui.spec.js` failures (logout, shareable quote URL) reproduce on
unmodified `main` — pre-existing, not regressions. The `ops-addleg`/`ops-trip-calendar` e2e
failures are parallel-load flakes and pass when re-run serially.

Manual check on staging, since this is a UI signal: open a private quote, mark it sent, edit a fee
chip, and confirm the line reads **"Sent at $X · now $Y"** — then re-send and confirm it vanishes.

## Rollout

Additive migration, additive columns, additive UI. Every existing quote simply has no baseline
until its next send or pay-link mint, and shows nothing until then. `main` → staging automatically;
migrations apply on boot fail-closed, so merging `0039` is its release. Prod follows via the usual
promote PR.

**Slice 2 — `quote_revisions`, the `/revisions` endpoint and the history panel — is not in this
plan** and should be planned separately once this is settled.
