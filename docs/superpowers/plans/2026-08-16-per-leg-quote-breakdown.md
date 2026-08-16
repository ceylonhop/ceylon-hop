# Per-journey prices on the quote page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let ops reveal a per-journey price breakdown on an individual customer quote, off by default, so a customer deciding which journeys to keep can see what each one costs.

**Architecture:** A new `quotes.show_leg_prices` column gates the feature per quote. `customerQuoteView` projects the engine's own `lineItems` into a display-only `legPrices` block on the lead option; `quote.html` renders it into the DAY BY DAY rail. Displayed leg prices are whole dollars and a computed remainder row guarantees the column sums to the charged total.

**Tech Stack:** Node 20 · TypeScript (strict) · Hono · Drizzle + Postgres · Vitest · Playwright (web-tests).

Design spec: `docs/superpowers/specs/2026-08-16-per-leg-quote-breakdown-design.md`.

## Global Constraints

- Money is integer minor units. Never floats.
- `customerQuoteView` is margin-safe: it must never echo `result`, `request`, `rateCardJson`, or any `lineItem.meta`. The existing "never emits margin on any path" test guards this and must keep passing.
- The breakdown appears **only** on the lead (priced) option, and **only** when the priced product is `private`. Chauffeur gets nothing.
- The Total shown is always the stored `totalCents` — what the pay link charges. Display rounding may never change it.
- Prices come from the stored `result.lineItems`. Never from `quoteBreakdown()` — that would let the customer's figures drift from the ops timeline's.
- Styles for this feature go in `quote.css`. Never `ticket.css` — `pay.html` shares `.hop` and must be unaffected.
- Editing any root asset (`quote.html`, `quote.css`) requires `npm run generate` from the repo root to restamp `?v=`, or CI goes red.
- `cd api && npm run check` and `cd web-tests && npm run test:all` must pass before every commit.

## File Structure

| File | Responsibility |
|---|---|
| `api/drizzle/0046_quote_show_leg_prices.sql` | **Create.** The additive column. |
| `api/drizzle/meta/_journal.json` | **Modify.** Journal entry for the migration. |
| `api/src/db/schema.ts` | **Modify.** Column definition. |
| `api/src/db/quoteRepo.ts` | **Modify.** `SavedQuote` + `QuotePatch` fields. |
| `api/src/db/postgresQuoteRepo.ts` | **Modify.** Map the column in get/list/save/patch. |
| `api/src/routes/internalQuote.ts` | **Modify.** Accept `showLegPrices` on PATCH. |
| `api/src/routes/ops-ui.html` | **Modify.** The ops checkbox. |
| `api/src/quote/customerQuoteView.ts` | **Modify.** `legPrices` projection + the reconciliation invariant. |
| `quote.html` | **Modify.** Render prices into the DAY BY DAY rail. |
| `quote.css` | **Modify.** Rail price + summary styles. |

Task order puts the customer-visible change **last**: nothing a customer can see changes until Task 4.

---

### Task 1: The column

**Files:**
- Create: `api/drizzle/0046_quote_show_leg_prices.sql`
- Modify: `api/drizzle/meta/_journal.json`
- Modify: `api/src/db/schema.ts:548` (beside `requestedService`)
- Modify: `api/src/db/quoteRepo.ts:112` (`SavedQuote`), `:164` (`QuotePatch`)
- Modify: `api/src/db/postgresQuoteRepo.ts:70`, `:115`, `:472`
- Test: `api/src/db/postgresQuoteRepo.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SavedQuote.showLegPrices: boolean` (never null — the column is `NOT NULL DEFAULT false`), and `QuotePatch.showLegPrices?: boolean`.

- [ ] **Step 1: Add the column to the schema**

In `api/src/db/schema.ts`, directly after the `requestedService` block:

```ts
  // Per-journey price breakdown (spec 2026-08-16). A DISPLAY setting, not a pricing input:
  // when true the customer quote page lists what each journey costs. Off by default and set
  // only by an explicit ops tick — a customer sees it only when they asked for it. NOT NULL
  // with a default so every existing quote is off without a backfill.
  showLegPrices: boolean('show_leg_prices').notNull().default(false),
```

Add `boolean` to the `drizzle-orm/pg-core` import at the top of the file if it is not already imported.

- [ ] **Step 2: Generate the migration**

Run: `cd api && npm run db:generate`

Expected: a new `api/drizzle/00NN_<random_name>.sql` containing an `ALTER TABLE "quotes" ADD COLUMN "show_leg_prices" boolean DEFAULT false NOT NULL;` and a new entry appended to `api/drizzle/meta/_journal.json`.

- [ ] **Step 3: Rename it to the repo's descriptive convention**

Every migration here is named for what it does (`0041_quote_offer_validity.sql`), not drizzle's random word pair. Rename the generated file to `api/drizzle/0046_quote_show_leg_prices.sql` and change that entry's `"tag"` in `api/drizzle/meta/_journal.json` to `"0046_quote_show_leg_prices"`. Leave `idx`, `when`, `version` and `breakpoints` exactly as generated.

Then prepend the comment header the other migrations carry:

```sql
-- Per-journey price breakdown (spec 2026-08-16). Gates the customer-facing per-leg breakdown
-- on ONE quote. A display setting, deliberately a column rather than a field inside
-- request_json: that blob is what the quote was PRICED from, and quoteDiff plus re-price on
-- reopen both read it, so a cosmetic tick has no business editing it.
--
-- NOT NULL DEFAULT false: every existing quote is off, which is the required default, and the
-- column needs no backfill.
ALTER TABLE "quotes" ADD COLUMN "show_leg_prices" boolean DEFAULT false NOT NULL;
```

- [ ] **Step 4: Write the failing repo round-trip test**

In `api/src/db/postgresQuoteRepo.test.ts`, following the file's existing setup pattern for a saved quote:

```ts
it('defaults show_leg_prices to false and round-trips an explicit true', async () => {
  const saved = await repo.save(newQuoteFixture());
  expect(saved.showLegPrices).toBe(false);

  await repo.patch(saved.id, { showLegPrices: true });
  const reloaded = await repo.get(saved.id);
  expect(reloaded?.showLegPrices).toBe(true);
});
```

Use whatever the file already calls its repo handle and quote fixture — do not invent new helpers.

- [ ] **Step 5: Run it to verify it fails**

Run: `cd api && npx vitest run src/db/postgresQuoteRepo.test.ts -t 'show_leg_prices'`
Expected: FAIL — `showLegPrices` is `undefined`, and `patch` rejects the unknown key.

- [ ] **Step 6: Plumb it through the repo**

In `api/src/db/quoteRepo.ts`, add to `SavedQuote` beside `requestedService: string | null;`:

```ts
  /** Display-only: does this quote's customer page list a price per journey? Never null. */
  showLegPrices: boolean;
```

and to `QuotePatch`:

```ts
  showLegPrices?: boolean;
```

In `api/src/db/postgresQuoteRepo.ts`, add `showLegPrices: r.showLegPrices,` to the row mapper at line ~70, and `showLegPrices: q.showLegPrices ?? false,` at the two insert/return sites (~115, ~472). Add `quotes.showLegPrices` to the column list at ~279 if that select enumerates columns explicitly.

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd api && npx vitest run src/db/postgresQuoteRepo.test.ts -t 'show_leg_prices'`
Expected: PASS

- [ ] **Step 8: Apply the migration locally and run the full gate**

Run: `cd api && npm run migrate && npm run check`
Expected: migration applies; typecheck, lint and the full suite pass.

- [ ] **Step 9: Commit**

```bash
git add api/drizzle/0046_quote_show_leg_prices.sql api/drizzle/meta/_journal.json api/src/db/schema.ts api/src/db/quoteRepo.ts api/src/db/postgresQuoteRepo.ts api/src/db/postgresQuoteRepo.test.ts
git commit -m "feat(quote): add show_leg_prices, the per-quote breakdown gate"
```

**Note for the PR:** this commit carries a migration. Merging it to `main` applies it to staging on the next Render boot. Say so in the PR body.

---

### Task 2: Ops can tick it

**Files:**
- Modify: `api/src/routes/internalQuote.ts` (the quote PATCH handler)
- Modify: `api/src/routes/ops-ui.html`
- Test: `api/src/routes/internalQuote.test.ts`

**Interfaces:**
- Consumes: `QuotePatch.showLegPrices?: boolean` from Task 1.
- Produces: `PATCH /admin/quote/:id` accepting `{ showLegPrices: boolean }`.

- [ ] **Step 1: Write the failing route test**

In `api/src/routes/internalQuote.test.ts`, in the describe block covering the quote PATCH:

```ts
it('accepts showLegPrices and persists it', async () => {
  const app = makeApp();
  const id = await seedQuote(app);

  const res = await app.request(`/admin/quote/${id}`, {
    method: 'PATCH',
    headers: jsonHeaders(),
    body: JSON.stringify({ showLegPrices: true }),
  });

  expect(res.status).toBe(200);
  expect((await quotesRepo.get(id))?.showLegPrices).toBe(true);
});

it('rejects a non-boolean showLegPrices', async () => {
  const app = makeApp();
  const id = await seedQuote(app);

  const res = await app.request(`/admin/quote/${id}`, {
    method: 'PATCH',
    headers: jsonHeaders(),
    body: JSON.stringify({ showLegPrices: 'yes' }),
  });

  expect(res.status).toBe(400);
});
```

Use the file's existing app/seed/header helpers — match the surrounding tests exactly rather than inventing names.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t 'showLegPrices'`
Expected: FAIL — the Zod schema strips or rejects the unknown key, so nothing persists.

- [ ] **Step 3: Accept it in the PATCH schema**

In the quote PATCH's Zod schema in `api/src/routes/internalQuote.ts`, add:

```ts
  // Display-only (spec 2026-08-16). Deliberately NOT a pricing input: setting it must not
  // re-estimate, must not mark the quote dirty, and must not require re-approval.
  showLegPrices: z.boolean().optional(),
```

and pass it through to the repo patch alongside the other optional fields the handler already forwards.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t 'showLegPrices'`
Expected: PASS (both)

- [ ] **Step 5: Add the ops checkbox**

In `api/src/routes/ops-ui.html`, in the quote builder's settings area near the existing `requestedService` controls, add a checkbox bound to `state.showLegPrices`. Follow the file's existing control markup and its `mutate()` convention:

```js
function setShowLegPrices(on) {
  mutate({ showLegPrices: !!on });
}
```

Render it as:

```html
<label class="chk">
  <input type="checkbox" id="showLegPrices" onchange="setShowLegPrices(this.checked)">
  Show price per journey on the customer's quote page
</label>
```

Wire `state.showLegPrices` into the save payload the builder already PATCHes, and hydrate it from the loaded quote so reopening a quote shows the current state.

- [ ] **Step 6: Run the full gate**

Run: `cd api && npm run check`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts api/src/routes/ops-ui.html
git commit -m "feat(ops): tick to show per-journey prices on a quote"
```

---

### Task 3: The projection

**Files:**
- Modify: `api/src/quote/customerQuoteView.ts`
- Test: `api/src/quote/customerQuoteView.test.ts`

**Interfaces:**
- Consumes: `SavedQuote.showLegPrices` from Task 1.
- Produces: `QuoteViewOption.legPrices: QuoteViewLegPrices | null`, where

```ts
export interface QuoteViewLegPrices {
  rows: { label: string; amountUsd: string }[];
  reconcile: { label: string; amountUsd: string } | null;
  discount: { label: string; amountUsd: string } | null;
  totalUsd: string;
}
```

- [ ] **Step 1: Write the failing tests**

Append to `api/src/quote/customerQuoteView.test.ts`:

```ts
describe('per-journey prices', () => {
  const shown = (over: Record<string, unknown> = {}) =>
    customerQuoteView(quote({ showLegPrices: true, ...over }), p2pOnly).options[0].legPrices;

  it('is null unless ops ticked the quote', () => {
    expect(customerQuoteView(quote(), p2pOnly).options[0].legPrices).toBeNull();
  });

  it('is null on a chauffeur-priced quote even when ticked', () => {
    const v = customerQuoteView(
      quote({
        showLegPrices: true,
        request: {
          engine: { product: 'chauffeur', firstDate: '2026-08-20', lastDate: '2026-08-28' },
          tool: { passengerCount: 2, legs: [] },
        },
      }),
      { pointToPoint: null, chauffeur: { totalCents: 118_000 } },
    );
    expect(v.options[0].legPrices).toBeNull();
  });

  it('is null on the secondary option, which is a recompute not the approved total', () => {
    const v = customerQuoteView(quote({ showLegPrices: true, requestedService: 'both' }), both);
    expect(v.options[1].legPrices).toBeNull();
  });

  it('shows one whole-dollar row per journey, named without the vehicle tag', () => {
    const lp = shown({
      result: {
        lineItems: [
          { label: 'Colombo Airport → Sigiriya (car)', amountCents: 4508, meta: { distanceKm: 168 } },
          { label: 'Sigiriya → Kandy (car)', amountCents: 3180, meta: { distanceKm: 92 } },
        ],
      },
      totalCents: 7600,
    });
    expect(lp!.rows).toEqual([
      { label: 'Colombo Airport → Sigiriya', amountUsd: '$45' },
      { label: 'Sigiriya → Kandy', amountUsd: '$32' },
    ]);
  });

  it('folds an attributed extra into its own leg rather than adding a row', () => {
    const lp = shown({
      result: {
        lineItems: [
          { label: 'A → B (car)', amountCents: 5000 },
          { label: 'B → C (car)', amountCents: 5000 },
          { label: 'Sightseeing stops (up to 3h) — A → B', amountCents: 1000, meta: { kind: 'extra', code: 'sightseeing', legIndex: 0 } },
        ],
      },
      totalCents: 11000,
    });
    expect(lp!.rows).toEqual([
      { label: 'A → B', amountUsd: '$60' },
      { label: 'B → C', amountUsd: '$50' },
    ]);
  });

  it('gives an unattributed extra its own row', () => {
    const lp = shown({
      result: {
        lineItems: [
          { label: 'A → B (car)', amountCents: 5000 },
          { label: 'Sightseeing stops (up to 3h)', amountCents: 1000 },
        ],
      },
      totalCents: 6000,
    });
    expect(lp!.rows.map((r) => r.label)).toEqual(['A → B', 'Sightseeing stops (up to 3h)']);
  });

  it('labels a downward remainder as rounded down', () => {
    const lp = shown({
      result: { lineItems: [{ label: 'A → B (car)', amountCents: 36146 }] },
      totalCents: 35900,
    });
    expect(lp!.rows).toEqual([{ label: 'A → B', amountUsd: '$361' }]);
    expect(lp!.reconcile).toEqual({ label: 'Rounded down', amountUsd: '−$2' });
    expect(lp!.totalUsd).toBe('$359');
  });

  it('labels an upward remainder as rounding, not a discount', () => {
    const lp = shown({
      result: { lineItems: [{ label: 'A → B (car)', amountCents: 5040 }] },
      totalCents: 5050,
    });
    expect(lp!.reconcile).toEqual({ label: 'Rounding', amountUsd: '+$1' });
  });

  it('omits the remainder row when it is exactly zero', () => {
    const lp = shown({
      result: { lineItems: [{ label: 'A → B (car)', amountCents: 5000 }] },
      totalCents: 5000,
    });
    expect(lp!.reconcile).toBeNull();
  });

  it('gives a discount its own row instead of burying it in the remainder', () => {
    const lp = shown({
      result: {
        lineItems: [{ label: 'A → B (car)', amountCents: 20000 }],
        discountCents: 5000,
        totalBeforeDiscountCents: 20000,
      },
      totalCents: 15000,
    });
    expect(lp!.discount).toEqual({ label: 'Discount', amountUsd: '−$50' });
    expect(lp!.reconcile).toBeNull();
    expect(lp!.totalUsd).toBe('$150');
  });

  // THE INVARIANT. Whatever rounding and finishing did, the column the customer adds up must
  // land on the figure the pay link charges.
  it('always sums to the charged total', () => {
    const cases = [
      { legs: [4508, 3180, 5917, 5112, 5917, 3623, 7889], total: 35900, discount: 0 },
      { legs: [4999], total: 4999, discount: 0 },
      { legs: [5040], total: 5050, discount: 0 },
      { legs: [20000, 10000], total: 25000, discount: 5000 },
      { legs: [3333, 3333, 3334], total: 9900, discount: 0 },
    ];
    for (const c of cases) {
      const lp = shown({
        result: {
          lineItems: c.legs.map((a, i) => ({ label: `L${i} → M${i} (car)`, amountCents: a })),
          ...(c.discount ? { discountCents: c.discount, totalBeforeDiscountCents: c.total + c.discount } : {}),
        },
        totalCents: c.total,
      })!;
      const parse = (s: string) => Math.round(Number(s.replace(/[$,+]/g, '').replace('−', '-')) * 100);
      const sum =
        lp.rows.reduce((s, r) => s + parse(r.amountUsd), 0) +
        (lp.reconcile ? parse(lp.reconcile.amountUsd) : 0) +
        (lp.discount ? parse(lp.discount.amountUsd) : 0);
      expect(sum, `legs ${c.legs} total ${c.total}`).toBe(c.total);
      expect(parse(lp.totalUsd)).toBe(c.total);
    }
  });

  it('never leaks lineItem meta', () => {
    const lp = shown({
      result: {
        lineItems: [{ label: 'A → B (car)', amountCents: 5000, meta: { hotZone: 'Ella +12%', vehicle: 'car' } }],
      },
      totalCents: 5000,
    });
    expect(JSON.stringify(lp)).not.toMatch(/hotZone|Ella \+12%|vehicle/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && npx vitest run src/quote/customerQuoteView.test.ts -t 'per-journey prices'`
Expected: FAIL — `legPrices` is `undefined` on every option.

- [ ] **Step 3: Implement the projection**

In `api/src/quote/customerQuoteView.ts`, add to `ViewQuote`:

```ts
  showLegPrices?: boolean;
```

add the exported interface beside `QuoteViewOption`:

```ts
/* What each journey costs, for the customer who asked (spec 2026-08-16). Display-only, and
   whole dollars: `reconcile` is the REMAINDER against the charged total, never the engine's own
   `price_adjustment` row — so rows + reconcile + discount === totalCents by construction,
   whatever rounding and finishing did. That is the arithmetic the customer will check. */
export interface QuoteViewLegPrices {
  rows: { label: string; amountUsd: string }[];
  reconcile: { label: string; amountUsd: string } | null;
  discount: { label: string; amountUsd: string } | null;
  totalUsd: string;
}
```

add `legPrices: QuoteViewLegPrices | null;` to `QuoteViewOption`, and add the projection above `customerQuoteView`:

```ts
interface StoredLineItem {
  label: string;
  amountCents: number;
  meta?: { kind?: string; legIndex?: number };
}

// "Colombo Airport → Sigiriya (car)" → "Colombo Airport → Sigiriya". The vehicle tag is an ops
// annotation; the customer already knows what they are travelling in.
const journeyLabel = (label: string): string => label.replace(/\s*\([^()]*\)\s*$/, '');

const wholeDollars = (cents: number): number => Math.round(cents / 100) * 100;

function legPricesFor(
  quote: ViewQuote,
  service: 'private' | 'chauffeur',
  lead: boolean,
  totalCents: number,
  discountOff: number | null,
): QuoteViewLegPrices | null {
  // Lead-only and private-only. The secondary option's total is a recompute with no stored
  // lineItems behind it, so a breakdown there would reconcile to a number that was never
  // approved — the same reason the stored total already outranks the recompute. Chauffeur is
  // priced by the day and has no per-leg price to show at all.
  if (!quote.showLegPrices || !lead || service !== 'private') return null;

  const stored = (quote.result ?? {}) as { lineItems?: StoredLineItem[] };
  const items = Array.isArray(stored.lineItems) ? stored.lineItems : [];
  // Driving legs are the only rows the engine pushes with no meta.kind; extras, the finishing
  // adjustment and the discount all carry one.
  const legs = items.filter((li) => li.meta?.kind === undefined);
  if (!legs.length) return null;

  // An extra attributed to a leg folds into that leg, so the rail stays one row per journey.
  const amounts = legs.map((li) => li.amountCents);
  const loose: StoredLineItem[] = [];
  for (const e of items.filter((li) => li.meta?.kind === 'extra')) {
    const i = e.meta?.legIndex;
    if (i != null && Number.isInteger(i) && i >= 0 && i < amounts.length) amounts[i] += e.amountCents;
    else loose.push(e);
  }

  const rows = [
    ...legs.map((li, i) => ({ label: journeyLabel(li.label), cents: wholeDollars(amounts[i]) })),
    ...loose.map((e) => ({ label: journeyLabel(e.label), cents: wholeDollars(e.amountCents) })),
  ];

  // rows + reconcile − discount === totalCents, solved for reconcile.
  const off = discountOff ?? 0;
  const gap = totalCents + off - rows.reduce((s, r) => s + r.cents, 0);

  return {
    rows: rows.map((r) => ({ label: r.label, amountUsd: usd(r.cents) })),
    reconcile: gap === 0
      ? null
      : { label: gap < 0 ? 'Rounded down' : 'Rounding', amountUsd: `${gap < 0 ? '−' : '+'}${usd(Math.abs(gap))}` },
    discount: off > 0 ? { label: 'Discount', amountUsd: `−${usd(off)}` } : null,
    totalUsd: usd(totalCents),
  };
}
```

Then in `build`, add to the returned object:

```ts
      legPrices: legPricesFor(quote, service, lead, cents, lead ? discountOff : null),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && npx vitest run src/quote/customerQuoteView.test.ts`
Expected: PASS — including the pre-existing "never emits margin on any path" test.

- [ ] **Step 5: Pass the flag through the view route**

`api/src/routes/quoteView.ts:194` already hands the whole quote row to `customerQuoteView`, so `showLegPrices` arrives with it once Task 1 maps it in the repo. Confirm with:

Run: `cd api && npx vitest run src/routes/quoteView.test.ts`
Expected: PASS. No edit to `quoteView.ts` should be needed; if one is, the repo mapping in Task 1 is incomplete.

- [ ] **Step 6: Run the full gate**

Run: `cd api && npm run check`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add api/src/quote/customerQuoteView.ts api/src/quote/customerQuoteView.test.ts
git commit -m "feat(quote): project per-journey prices onto the lead private option"
```

---

### Task 4: The rail

**Files:**
- Modify: `quote.html` (`dayRowHtml` / `daysHtml`, around `:244-263`)
- Modify: `quote.css` (after the `.opts` block, ~`:87`)
- Test: `web-tests/e2e/quote-page.spec.js`

**Interfaces:**
- Consumes: `option.legPrices` from Task 3.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing e2e tests**

In `web-tests/e2e/quote-page.spec.js`, extend the `opt()` fixture with a `legPrices` argument defaulting to `null`, then add:

```js
const PRICED_OPT = opt({ service: 'private', name: 'Private transfers', totalCents: 45_000, lead: true });
PRICED_OPT.legPrices = {
  rows: [
    { label: 'Colombo Airport → Kandy', amountUsd: '$120' },
    { label: 'Kandy → Ella', amountUsd: '$140' },
  ],
  reconcile: { label: 'Rounded down', amountUsd: '−$2' },
  discount: null,
  totalUsd: '$258',
};

test('per-journey prices sit on each journey header, stay days show no charge once', async ({ page }) => {
  const body = { state: 'live', view: view({ options: [PRICED_OPT] }), validUntil: new Date(Date.now() + 7 * 864e5).toISOString() };
  await stubQuoteView(page, body);
  await page.goto(PAGE);

  await expect(page.locator('.hop:not(.is-stay) .hop-p')).toHaveText(['$120', '$140']);
  // DAYS has one stay row between the two journeys; it is priced as no charge, not blank.
  await expect(page.locator('.hop.is-stay .hop-p')).toHaveText(['no charge']);
  await expect(page.locator('.hop-sum .r').first()).toContainText('Rounded down');
  await expect(page.locator('.hop-sum .r.tot')).toContainText('$258');
});

test('no prices anywhere in the rail when the quote was not ticked', async ({ page }) => {
  const body = { state: 'live', view: view({ options: [PRIVATE_OPT] }), validUntil: new Date(Date.now() + 7 * 864e5).toISOString() };
  await stubQuoteView(page, body);
  await page.goto(PAGE);

  await expect(page.locator('.hop-p')).toHaveCount(0);
  await expect(page.locator('.hop-sum')).toHaveCount(0);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web-tests && npx playwright test e2e/quote-page.spec.js -g 'per-journey'`
Expected: FAIL — `.hop-p` resolves to zero elements.

- [ ] **Step 3: Render the prices**

In `quote.html`, change `daysHtml` and `dayRowHtml` so the rail can carry prices. `daysHtml` walks the days and consumes `legPrices.rows` in order for non-stay rows:

```js
  // Per-journey prices (spec 2026-08-16), shown only when ops ticked this quote. Rows are
  // consumed in itinerary order against the DRIVING days — the projection emits exactly one row
  // per driving leg, in the same order quoteDays lays them out. Stay days are priced too, as
  // "no charge": that is the private blurb's "you only pay for the days you're moving", proved.
  function daysHtml(days, legPrices){
    days = days || [];
    var rows = (legPrices && legPrices.rows) || [];
    var next = 0;
    var staySeen = false;
    var html = days.map(function(day, i){
      var isStay = day.kind === 'stay';
      var price = null;
      if (rows.length) {
        if (isStay) {
          // Once per stay BLOCK, not on every consecutive stay row.
          price = staySeen ? null : 'no charge';
          staySeen = true;
        } else {
          staySeen = false;
          price = next < rows.length ? rows[next++].amountUsd : null;
        }
      }
      return dayRowHtml(day, i === days.length - 1, price);
    }).join('');
    return '<div class="hops">' + html + sumHtml(legPrices) + '</div>';
  }

  function sumHtml(lp){
    if (!lp) return '';
    var r = '';
    if (lp.reconcile) r += '<div class="r"><span>' + esc(lp.reconcile.label) + '</span><span>' + esc(lp.reconcile.amountUsd) + '</span></div>';
    if (lp.discount) r += '<div class="r"><span>' + esc(lp.discount.label) + '</span><span>' + esc(lp.discount.amountUsd) + '</span></div>';
    r += '<div class="r tot"><span>Total</span><span>' + esc(lp.totalUsd) + '</span></div>';
    return '<div class="hop-sum">' + r + '</div>';
  }
```

and in `dayRowHtml`, widen the signature to take the price and render it inside `.hop-t`. Change:

```js
  function dayRowHtml(day, isLast){
```

to:

```js
  function dayRowHtml(day, isLast, price){
```

then replace this line:

```js
      + '<div><div class="hop-t">' + esc(day.title) + '</div>'
```

with:

```js
      + '<div><div class="hop-t"><span class="hop-title">' + esc(day.title) + '</span>'
      + (price ? '<span class="hop-p">' + esc(price) + '</span>' : '') + '</div>'
```

Everything below that line in `dayRowHtml` (`.hop-d`, `.hop-m`, `stops`) is unchanged.

At the call site (`:365`), pass the lead option's block:

```js
      + daysHtml(v.days, (v.options && v.options[0] && v.options[0].legPrices) || null)
```

When two options are shown, label the rail so the figures are never read against the chauffeur total. Change the head at `:364`:

```js
      + '<div class="t-head"><span class="t-ref">Day by day</span>'
      + (v.options && v.options.length > 1 && v.options[0].legPrices
          ? '<span class="t-ref t-ref-soft">' + esc(v.options[0].name.toLowerCase()) + ' prices</span>'
          : '')
      + '</div>'
```

- [ ] **Step 4: Add the styles**

In `quote.css`, after the `.opts` block:

```css
/* Per-journey prices (spec 2026-08-16). Invoice shape: the money sits on the journey's header
   line, right-aligned, so a customer scanning the right edge reads a column of figures. Tabular
   numerals keep that column true. In quote.css and not ticket.css — pay.html shares .hop. */
.hop-t{display:flex;align-items:baseline;gap:12px}
.hop-t .hop-title{flex:1;min-width:0}
.hop-p{flex:none;font-family:var(--display);font-weight:700;font-size:1rem;color:var(--ink);
  font-variant-numeric:tabular-nums}
/* A stay day is priced too — quietly. "no charge" in the meta voice is the private card's
   "you only pay for the days you're moving", shown rather than claimed. */
.hop.is-stay .hop-p{font-family:inherit;font-weight:600;font-size:.7rem;letter-spacing:.04em;
  text-transform:uppercase;color:var(--ink-faint)}
.hop-sum{margin:4px 0 0 25px;padding-top:11px;border-top:1px solid var(--line-soft,#f0ece1)}
.hop-sum .r{display:flex;justify-content:space-between;gap:12px;font-size:.8rem;
  color:var(--ink-soft);padding:2px 0}
.hop-sum .r span:last-child{font-variant-numeric:tabular-nums}
.hop-sum .r.tot{margin-top:7px;padding-top:9px;border-top:1px solid var(--line-soft,#f0ece1);
  font-family:var(--display);font-weight:700;font-size:1.05rem;color:var(--ink)}
.t-ref-soft{color:var(--ink-faint);margin-left:8px}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web-tests && npx playwright test e2e/quote-page.spec.js`
Expected: PASS — all specs in the file, old and new.

- [ ] **Step 6: Restamp the assets**

Both `quote.html` and `quote.css` changed, so their `?v=` must be regenerated or the codegen check fails.

Run: `npm run generate` (from the repo root)
Expected: `stamped N asset refs (1 files changed)`.

- [ ] **Step 7: Run both full gates**

Run: `cd api && npm run check`
Run: `cd web-tests && npm run test:all`
Expected: both green.

- [ ] **Step 8: Commit**

```bash
git add quote.html quote.css web-tests/e2e/quote-page.spec.js
git commit -m "feat(quote): show what each journey costs in the day-by-day rail"
```

---

## Manual verification before the last PR merges

The unit and e2e tests stub the view. Confirm the real path once, on staging, after Tasks 1–3 are merged:

1. Open a private, approved quote in the ops tool. Tick "Show price per journey".
2. Mint its quote link and open it.
3. Check: one price per journey, stay days reading "no charge" once per block, and the column adding up to the total on the option card.
4. Untick it, reload the customer link, confirm every price disappears.

## Out of scope — do not build

- Per-leg prices for chauffeur in any form.
- A customer-openable expander. The gate is ops-side only.
- Per-leg prices on `pay.html` or `manage.html`.
- Any change to what is charged. This feature is display-only end to end.
