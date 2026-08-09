# Partial-leg payment links — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let ops mint a payment link that charges only some legs of a private quote, with the
booking, the pay page and the funnel all reflecting what was actually sold.

**Architecture:** A pure selection module computes the quote's charge lines and a subset's amount
from the stored request + locked rate card. The selection is stored on the `quotes` row and pinned
into a new v3 pay token by a monotonic sequence number, so re-picking retires the old link.
`quoteToBooking` gains an optional leg filter so pay-commit creates a booking over the sold legs
only.

**Tech Stack:** TypeScript, Hono, Drizzle (Postgres), Vitest (`api/`), Vitest + Playwright
(`web-tests/`). Ops UI and pay page are hand-written vanilla JS in single HTML files.

**Spec:** `docs/superpowers/specs/2026-08-04-partial-leg-pay-link-design.md` — read it first.

## Global Constraints

- **Private transfers only.** A selection is rejected unless `engine.product === 'private'`.
- **Amount = the sum of the line prices already quoted.** Never re-run the engine over a subset,
  never re-finish. A selection covering every line uses `quote.totalCents` verbatim.
- **Margin never reaches the wire.** `/quotes/pay/view` stays a hand-built projection; no
  `result`, `request`, `rateCardJson`, margin or hot-zone field may be echoed.
- **Minting never touches** `status`, `sentAt` or the assignee. It writes through
  `QuoteRepo.patch`, never `update` (which bumps `revision`).
- **`pay_link_seq` is monotonic and never reset**, including when a selection is cleared.
- Currency is USD cents throughout; amounts are integers.
- Run `cd api && npm test` for API tests; `cd web-tests && npm run test:all` for the web suite.
- Commit per task. Branch off `origin/main`, never commit in the shared tree
  (`/Users/roshenw/claude_code/ceylon-hop`) — use a worktree.

## File Structure

| File | Responsibility |
| --- | --- |
| `api/src/quote/paySelection.ts` (new) | Pure: quote → charge lines; selection → amount; full/contiguity predicates |
| `api/src/quote/paySelection.test.ts` (new) | Unit tests for the above |
| `api/drizzle/0038_pay_link_selection.sql` (new) | Additive columns |
| `api/src/db/schema.ts` | Drizzle column definitions |
| `api/src/db/quoteRepo.ts` | `SavedQuote` / `QuotePatch` fields; in-memory repo behaviour |
| `api/src/db/postgresQuoteRepo.ts` | Persist the new fields; clear selection on `update()` |
| `api/src/lib/bookingToken.ts` | v3 token carrying the selection seq |
| `api/src/quote/quoteToBooking.ts` | Optional `legIndexes` filter |
| `api/src/routes/internalQuote.ts` | Mint accepts a selection; `/book` retires one |
| `api/src/routes/quotePay.ts` | `/view` lines+coverage; `/start` subset booking + seq idempotency |
| `api/src/services/analytics/funnel.ts` | `wonValue` uses the sold amount |
| `api/src/services/notifications.ts` | Coverage sentence on a partial booking's email |
| `api/src/routes/ops-ui.html` | "Part of trip…" picker, gap warning, outstanding-link display |
| `pay.html` | Line receipt + coverage sentence |
| `web-tests/e2e/pay-link-chain.spec.js` | End-to-end partial mint → view → start |

---

### Task 1: Selection maths (pure module)

The heart of the feature, and the only place the amount is decided.

**It reads the quote's STORED `result.lineItems` — it does not re-price anything.** Those line
items are the engine's own output, re-priced on every save, and they are literally the prices the
customer was quoted. Recomputing them (e.g. via `quoteBreakdown`) would introduce a second pricing
implementation kept in parity by hand, and would drag in the rate card — where an expired
`rateLockedUntil` makes `rateCardFor()` hand back the *live* card, pricing lines off today's
numbers against yesterday's total. Reading the stored result removes both hazards.

Line order in `result.lineItems` is fixed by `engine.ts`: the first `engine.legs.length` items are
the driving legs, then the extras in request order, then an optional `price_adjustment` (the charm
finishing, which by rule never applies to a subset — spec §4).

**Files:**
- Create: `api/src/quote/paySelection.ts`
- Test: `api/src/quote/paySelection.test.ts`

**Interfaces:**
- Consumes: `SavedQuote` from `api/src/db/quoteRepo.ts`; `QuoteRequest`, `LineItem` from
  `api/src/quote/types.ts`.
- Produces:
  - `interface PaySelection { legIndexes: number[]; extraIndexes: number[] }`
  - `interface PayLine { kind: 'leg' | 'extra'; index: number; label: string; amountCents: number; legIndex?: number }`
  - `payLines(quote: SavedQuote): PayLine[]`
  - `selectionAmountCents(lines: PayLine[], sel: PaySelection): number`
  - `isFullSelection(lines: PayLine[], sel: PaySelection): boolean`
  - `isContiguous(legIndexes: number[]): boolean`
  - `gapAfterLeg(lines: PayLine[], sel: PaySelection): string | null`

- [ ] **Step 1: Write the failing test**

Create `api/src/quote/paySelection.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { payLines, selectionAmountCents, isFullSelection, isContiguous, gapAfterLeg } from './paySelection';
import { quote } from './engine';
import { RATE_CARD } from './rateCard';
import type { QuoteRequest } from './types';

const req: QuoteRequest = {
  product: 'private',
  vehicle: 'car',
  pax: 2,
  bags: 2,
  legs: [
    { from: 'Colombo', to: 'Kandy', distanceKm: 120 },
    { from: 'Kandy', to: 'Ella', distanceKm: 140 },
    { from: 'Ella', to: 'Galle', distanceKm: 200 },
  ],
  extras: [{ code: 'luggage', legIndex: 1 }, 'flex'],
};

// A stored quote is `request: { engine, tool }` + `result`. Build it through the REAL engine, so
// the fixture carries the same line items a saved quote does rather than a hand-written shape.
function savedQuote(request: QuoteRequest = req) {
  const result = quote(request, RATE_CARD);
  return { request: { engine: request }, result, totalCents: result.totalCents } as never;
}

describe('payLines', () => {
  it('emits one line per leg then one per extra, in request order', () => {
    const lines = payLines(savedQuote());
    expect(lines.map((l) => `${l.kind}:${l.index}`)).toEqual([
      'leg:0', 'leg:1', 'leg:2', 'extra:0', 'extra:1',
    ]);
    expect(lines[0].label).toBe('Colombo → Kandy');
    expect(lines[3].label).toBe('Luggage rack — Kandy → Ella');
    expect(lines[3].legIndex).toBe(1);
    expect(lines[4].legIndex).toBeUndefined();
  });

  it('excludes the charm-finishing adjustment row', () => {
    expect(payLines(savedQuote())).toHaveLength(5); // 3 legs + 2 extras, never price_adjustment
  });

  // THE invariant of this feature: the lines a partial link charges from are the same numbers
  // the quote itself was built from. If this drifts, every partial sale charges a fiction.
  it('sums with the adjustment to the quote total', () => {
    const q = savedQuote() as never as { result: { priceAdjustmentCents: number }; totalCents: number };
    const sum = payLines(q as never).reduce((a, l) => a + l.amountCents, 0);
    expect(sum + q.result.priceAdjustmentCents).toBe(q.totalCents);
  });
});

describe('selectionAmountCents', () => {
  it('sums only the ticked lines', () => {
    const lines = payLines(savedQuote());
    const sel = { legIndexes: [0, 1], extraIndexes: [0] };
    expect(selectionAmountCents(lines, sel)).toBe(
      lines[0].amountCents + lines[1].amountCents + lines[3].amountCents,
    );
  });

  it('never falls below the per-leg floor for the priced tier', () => {
    const lines = payLines(savedQuote({ ...req, legs: [{ from: 'A', to: 'B', distanceKm: 1 }], extras: [] }));
    expect(selectionAmountCents(lines, { legIndexes: [0], extraIndexes: [] }))
      .toBeGreaterThanOrEqual(RATE_CARD.floorCents.car);
  });
});

describe('isFullSelection', () => {
  it('is true only when every line is ticked', () => {
    const lines = payLines(savedQuote());
    expect(isFullSelection(lines, { legIndexes: [0, 1, 2], extraIndexes: [0, 1] })).toBe(true);
    expect(isFullSelection(lines, { legIndexes: [0, 1, 2], extraIndexes: [0] })).toBe(false);
    expect(isFullSelection(lines, { legIndexes: [0, 2], extraIndexes: [0, 1] })).toBe(false);
  });
});

describe('isContiguous', () => {
  it('accepts a run and rejects a hole', () => {
    expect(isContiguous([0, 1, 2])).toBe(true);
    expect(isContiguous([1, 2])).toBe(true);
    expect(isContiguous([2, 0, 1])).toBe(true); // order-insensitive
    expect(isContiguous([0, 2])).toBe(false);
    expect(isContiguous([])).toBe(false);
  });
});

describe('gapAfterLeg', () => {
  it('names the leg the gap opens after, for the ops warning', () => {
    const lines = payLines(savedQuote());
    expect(gapAfterLeg(lines, { legIndexes: [0, 2], extraIndexes: [] })).toBe('Colombo → Kandy');
    expect(gapAfterLeg(lines, { legIndexes: [0, 1], extraIndexes: [] })).toBeNull();
  });
});

```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/quote/paySelection.test.ts`
Expected: FAIL — `Failed to resolve import "./paySelection"`.

- [ ] **Step 3: Write the implementation**

Create `api/src/quote/paySelection.ts`:

```ts
import type { SavedQuote } from '../db/quoteRepo';
import type { LineItem, QuoteRequest } from './types';

// Partial-leg pay links (spec 2026-08-04). The ONE place a partial link's amount is decided.
//
// The rule is the owner's: a partial link charges the line prices the quote ALREADY shows,
// added up. So this module READS `quote.result.lineItems` — the engine's own output, re-priced
// on every save — and never recomputes a price. Two hazards that buys us out of:
//   • a second pricing implementation (quoteBreakdown) kept in parity with the engine by hand;
//   • the rate card, where an expired `rateLockedUntil` makes rateCardFor() return the LIVE
//     card, which would price these lines off today's numbers against yesterday's total.
//
// Line order is fixed by engine.ts: the first `engine.legs.length` items are the driving legs,
// then the extras in request order, then an optional price_adjustment (the charm finishing).
// The adjustment is excluded — by rule it never applies to a subset (spec §4).
//
// Floors come for free: the engine already applies max(floorCents[vehicle], raw) per private
// leg, so any subset of n legs clears n × floor — exactly the `protectedMinimumCents` the
// engine defends. See §11 of the spec.

export interface PaySelection {
  legIndexes: number[];
  extraIndexes: number[];
}

export interface PayLine {
  kind: 'leg' | 'extra';
  /** Index into `engine.legs` or `engine.extras` — positional, matching the `legIndex` convention. */
  index: number;
  label: string;
  amountCents: number;
  /** Extras only: the driving leg this charge belongs to, when it was attributed. */
  legIndex?: number;
}

/** Thrown when a quote can't produce charge lines — chauffeur, shell, or a legacy row. */
export class NotLineablePriceError extends Error {}

/**
 * Every charge line of a private quote, read from its stored result: legs first (in `engine.legs`
 * order), then extras (in `engine.extras` order). Throws for anything that isn't a priced private
 * quote — a chauffeur leg carries only its km share, so a subset of them sums to a meaningless
 * number (spec §3).
 */
export function payLines(quote: SavedQuote): PayLine[] {
  const engine = (quote.request as { engine?: QuoteRequest } | null)?.engine;
  if (!engine || engine.product !== 'private') throw new NotLineablePriceError('not a private quote');
  const items = (quote.result as { lineItems?: LineItem[] } | null)?.lineItems;
  if (!Array.isArray(items)) throw new NotLineablePriceError('quote has no priced line items');

  const legCount = engine.legs.length;
  // A shell or a half-saved row would slice legs out of thin air; refuse rather than invent.
  if (items.length < legCount) throw new NotLineablePriceError('fewer line items than legs');

  const legLines: PayLine[] = items.slice(0, legCount).map((item, i) => ({
    kind: 'leg',
    index: i,
    label: item.label,
    amountCents: item.amountCents,
  }));

  // Everything after the legs is an extra, except the finishing adjustment the engine appends
  // last. An UNATTRIBUTED extra carries no meta at all, so extras cannot be identified by meta —
  // position is the contract, and it matches `engine.extras` one-for-one.
  const extraLines: PayLine[] = items
    .slice(legCount)
    .filter((item) => (item.meta as { kind?: string } | undefined)?.kind !== 'price_adjustment')
    .map((item, i) => {
      const legIndex = (item.meta as { legIndex?: number } | undefined)?.legIndex;
      return {
        kind: 'extra' as const,
        index: i,
        label: item.label,
        amountCents: item.amountCents,
        ...(typeof legIndex === 'number' ? { legIndex } : {}),
      };
    });

  return [...legLines, ...extraLines];
}

const ticked = (line: PayLine, sel: PaySelection): boolean =>
  line.kind === 'leg' ? sel.legIndexes.includes(line.index) : sel.extraIndexes.includes(line.index);

export function selectionAmountCents(lines: PayLine[], sel: PaySelection): number {
  return lines.filter((l) => ticked(l, sel)).reduce((sum, l) => sum + l.amountCents, 0);
}

/** True when nothing was unticked — the caller must then use the quote's stored total (spec §4). */
export function isFullSelection(lines: PayLine[], sel: PaySelection): boolean {
  return lines.every((l) => ticked(l, sel));
}

/** A selection is contiguous when its legs form an unbroken run. Empty is not contiguous. */
export function isContiguous(legIndexes: number[]): boolean {
  if (!legIndexes.length) return false;
  const sorted = [...legIndexes].sort((a, b) => a - b);
  return sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
}

/** The leg name a gap opens after, for the ops warning — null when the selection is contiguous. */
export function gapAfterLeg(lines: PayLine[], sel: PaySelection): string | null {
  if (isContiguous(sel.legIndexes)) return null;
  const sorted = [...sel.legIndexes].sort((a, b) => a - b);
  const before = sorted.find((n, i) => i > 0 && n !== sorted[i - 1] + 1);
  if (before === undefined) return null;
  const prev = sorted[sorted.indexOf(before) - 1];
  return lines.find((l) => l.kind === 'leg' && l.index === prev)?.label ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && npx vitest run src/quote/paySelection.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add api/src/quote/paySelection.ts api/src/quote/paySelection.test.ts
git commit -m "feat(quote): pure selection maths for partial-leg pay links"
```

---

### Task 2: Store the selection on the quote

**Files:**
- Create: `api/drizzle/0038_pay_link_selection.sql`
- Modify: `api/src/db/schema.ts` (the `quotes` table, ~line 442)
- Modify: `api/src/db/quoteRepo.ts` (`SavedQuote`, `QuotePatch`, `InMemoryQuoteRepo`)
- Modify: `api/src/db/postgresQuoteRepo.ts` (`quoteRowToSaved`, `patch`, `update`)
- Test: `api/src/db/quoteRepo.test.ts`

**Interfaces:**
- Produces: `SavedQuote.payLinkSelection: PaySelection | null`, `SavedQuote.soldCents: number | null`,
  `SavedQuote.payLinkSeq: number`; `QuotePatch.payLinkSelection?: PaySelection | null`,
  `QuotePatch.soldCents?: number | null`, `QuotePatch.payLinkSeq?: number`.
- Consumes: `PaySelection` from Task 1.

- [ ] **Step 1: Write the failing test**

Append to `api/src/db/quoteRepo.test.ts`:

```ts
describe('pay-link selection', () => {
  it('round-trips a selection, amount and seq through patch', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(newQuoteFixture());
    const patched = await repo.patch(q.id, {
      payLinkSelection: { legIndexes: [0, 2], extraIndexes: [1] },
      soldCents: 31000,
      payLinkSeq: 1,
    });
    expect(patched!.payLinkSelection).toEqual({ legIndexes: [0, 2], extraIndexes: [1] });
    expect(patched!.soldCents).toBe(31000);
    expect(patched!.payLinkSeq).toBe(1);
  });

  it('defaults to no selection and seq 0', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(newQuoteFixture());
    expect(q.payLinkSelection).toBeNull();
    expect(q.soldCents).toBeNull();
    expect(q.payLinkSeq).toBe(0);
  });

  // legIndexes are POSITIONAL, so an edit that reorders or deletes a leg leaves them pointing
  // at legs nobody chose. The token retires on the revision mismatch, but the stored selection
  // would still drive the ops display and a re-mint. See spec §6.
  it('clears the selection on update(), leaving seq monotonic', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(newQuoteFixture());
    await repo.patch(q.id, {
      payLinkSelection: { legIndexes: [0], extraIndexes: [] },
      soldCents: 12000,
      payLinkSeq: 3,
    });
    const updated = await repo.update(q.id, newQuoteFixture());
    expect(updated!.revision).toBe(q.revision + 1);
    expect(updated!.payLinkSelection).toBeNull();
    expect(updated!.soldCents).toBeNull();
    expect(updated!.payLinkSeq).toBe(3);
  });
});
```

If `newQuoteFixture()` does not already exist in that file, use whatever fixture helper the
surrounding tests use — do not invent a second one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/db/quoteRepo.test.ts -t "pay-link selection"`
Expected: FAIL — `payLinkSelection` is not a known property.

- [ ] **Step 3: Write the migration**

Create `api/drizzle/0038_pay_link_selection.sql`:

```sql
-- Partial-leg pay links (spec 2026-08-04). Additive: a quote with no selection behaves exactly
-- as it did before. pay_link_seq is monotonic per quote and is never reset — a seq must never be
-- reused by a later selection, or a retired link would validate again.
ALTER TABLE "quotes" ADD COLUMN "pay_link_selection" jsonb;
ALTER TABLE "quotes" ADD COLUMN "sold_cents" integer;
ALTER TABLE "quotes" ADD COLUMN "pay_link_seq" integer DEFAULT 0 NOT NULL;
```

Hand-written, matching the file's neighbours. `drizzle/meta/` gains no snapshot for it — the same
gap already recorded for 0013/0023/0029 in `docs/known-bugs.md`. Harmless until someone runs
`npm run db:generate`; if a redundant migration appears there later, delete it.

- [ ] **Step 4: Add the Drizzle columns**

In `api/src/db/schema.ts`, inside the `quotes` table definition, next to `revision`:

```ts
  // Partial-leg pay links (spec 2026-08-04). NULL selection = the outstanding link is for the
  // full quote. sold_cents is the FROZEN amount a partial link charges.
  payLinkSelection: jsonb('pay_link_selection'),
  soldCents: integer('sold_cents'),
  payLinkSeq: integer('pay_link_seq').notNull().default(0),
```

- [ ] **Step 5: Extend the repo types and the in-memory repo**

In `api/src/db/quoteRepo.ts`, add to `SavedQuote`:

```ts
  payLinkSelection: PaySelection | null;
  soldCents: number | null;
  payLinkSeq: number;
```

and to `QuotePatch`:

```ts
  // Partial-leg pay links (spec 2026-08-04). Tri-state like rateLock: `undefined` = leave alone,
  // an object = store, `null` = clear. payLinkSeq is set explicitly by the mint; it is monotonic
  // and the repo never resets it.
  payLinkSelection?: PaySelection | null;
  soldCents?: number | null;
  payLinkSeq?: number;
```

Import `PaySelection` from `../quote/paySelection`. In `InMemoryQuoteRepo`: default the three
fields on `save()` (`null`, `null`, `0`), apply them in `patch()` with the same
`!== undefined` guard the other fields use, and in `update()` set
`row.payLinkSelection = null; row.soldCents = null;` alongside the existing revision bump —
leaving `payLinkSeq` untouched.

- [ ] **Step 6: Persist them in Postgres**

In `api/src/db/postgresQuoteRepo.ts`:

- `quoteRowToSaved`: map the three columns (`payLinkSelection: (r.payLinkSelection ?? null) as PaySelection | null`,
  `soldCents: r.soldCents ?? null`, `payLinkSeq: r.payLinkSeq ?? 0`).
- `patch()`: add, alongside the existing spreads —

```ts
        ...(patch.payLinkSelection !== undefined
          ? { payLinkSelection: (patch.payLinkSelection ?? null) as object | null }
          : {}),
        ...(patch.soldCents !== undefined ? { soldCents: patch.soldCents } : {}),
        ...(patch.payLinkSeq !== undefined ? { payLinkSeq: patch.payLinkSeq } : {}),
```

- `update()`: in the same `.set({...})` that carries `revision: sql\`${quotes.revision} + 1\``,
  add `payLinkSelection: null, soldCents: null,`. Do **not** touch `payLinkSeq`.

- [ ] **Step 7: Run the tests**

Run: `cd api && npx vitest run src/db/quoteRepo.test.ts`
Expected: PASS, including the three new cases.

- [ ] **Step 8: Commit**

```bash
git add api/drizzle/0038_pay_link_selection.sql api/src/db/schema.ts api/src/db/quoteRepo.ts api/src/db/postgresQuoteRepo.ts api/src/db/quoteRepo.test.ts
git commit -m "feat(db): store the pay-link selection, sold amount and seq on quotes"
```

---

### Task 3: v3 pay token carrying the selection seq

**Files:**
- Modify: `api/src/lib/bookingToken.ts:109-160`
- Test: `api/src/lib/bookingToken.test.ts`

**Interfaces:**
- Produces: `signQuotePayToken(quoteId: string, revision: number, secret: string, seq?: number): string`
  (default `seq = 0`); `verifyQuotePayToken(token, secret): { quoteId: string; revision: number; seq: number } | null`.

- [ ] **Step 1: Write the failing test**

Append to `api/src/lib/bookingToken.test.ts`:

```ts
describe('quote pay token v3', () => {
  const secret = 'test-secret';
  const id = '11111111-2222-3333-4444-555555555555';

  it('round-trips a seq', () => {
    const t = signQuotePayToken(id, 4, secret, 7);
    expect(verifyQuotePayToken(t, secret)).toEqual({ quoteId: id, revision: 4, seq: 7 });
  });

  it('is deterministic — the same inputs give a byte-identical URL', () => {
    expect(signQuotePayToken(id, 4, secret, 7)).toBe(signQuotePayToken(id, 4, secret, 7));
  });

  it('a different seq is a different token', () => {
    expect(signQuotePayToken(id, 4, secret, 7)).not.toBe(signQuotePayToken(id, 4, secret, 8));
  });

  it('reads a legacy v2 token as seq 0', () => {
    // v2 is 20 bytes; v3 is 22. Links already in customers' WhatsApp threads must keep working.
    const v2 = signQuotePayTokenV2ForTest(id, 4, secret);
    expect(verifyQuotePayToken(v2, secret)).toEqual({ quoteId: id, revision: 4, seq: 0 });
  });

  it('rejects a tampered signature', () => {
    const t = signQuotePayToken(id, 4, secret, 7);
    expect(verifyQuotePayToken(t.slice(0, -1) + 'A', secret)).toBeNull();
  });
});
```

Add a test-only helper in the same file that packs the old 20-byte v2 body, so the back-compat
case is exercised against a real v2 token rather than a hand-copied string:

```ts
function signQuotePayTokenV2ForTest(quoteId: string, revision: number, secret: string): string {
  const buf = Buffer.alloc(20);
  buf.writeUInt8(2, 0);
  buf.writeUInt8(0x01, 1);
  Buffer.from(quoteId.replace(/-/g, ''), 'hex').copy(buf, 2);
  buf.writeUInt16BE(revision, 18);
  const body = buf.toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest().subarray(0, 16).toString('base64url');
  return `${body}.${sig}`;
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/lib/bookingToken.test.ts -t "quote pay token v3"`
Expected: FAIL — `signQuotePayToken` takes 3 arguments; `verifyQuotePayToken` returns no `seq`.

- [ ] **Step 3: Implement v3**

In `api/src/lib/bookingToken.ts`, add next to `MAX_REVISION`:

```ts
const MAX_SEQ = 0xffff;
```

Replace `signQuotePayToken` with:

```ts
// v3 (2026-08-04) adds a 2-byte SELECTION SEQ so a partial link can be retired when ops re-picks
// without editing the quote. seq 0 = "the full quote", which is what every pre-v3 link means.
// Packed: 1 version + 1 purpose + 16 uuid + 2 revision + 2 seq = 22 bytes.
export function signQuotePayToken(
  quoteId: string,
  revision: number,
  secret: string,
  seq = 0,
): string {
  const hex = quoteId.replace(/-/g, '');
  if (
    hex.length !== 32 || !/^[0-9a-f]+$/i.test(hex) ||
    revision < 1 || revision > MAX_REVISION ||
    seq < 0 || seq > MAX_SEQ
  ) {
    return signedBody({ v: 1, purpose: 'quote-pay', q: quoteId, r: revision, s: seq }, secret);
  }
  const buf = Buffer.alloc(22);
  buf.writeUInt8(3, 0);
  buf.writeUInt8(PURPOSE_QUOTE_PAY, 1);
  Buffer.from(hex, 'hex').copy(buf, 2);
  buf.writeUInt16BE(revision, 18);
  buf.writeUInt16BE(seq, 20);
  const body = b64url(buf);
  return `${body}.${b64url(macBytes(body, secret))}`;
}
```

Replace `verifyV2` with a packed verifier that accepts both lengths:

```ts
/** v2 (20 bytes, no seq) and v3 (22 bytes, seq). Returns null for anything else. */
function verifyPacked(token: string, secret: string): { quoteId: string; revision: number; seq: number } | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(body, 'base64url');
  } catch {
    return null;
  }
  const version = buf.length === 20 ? 2 : buf.length === 22 ? 3 : 0;
  if (!version || buf.readUInt8(0) !== version || buf.readUInt8(1) !== PURPOSE_QUOTE_PAY) return null;
  const expected = b64url(macBytes(body, secret));
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const hex = buf.subarray(2, 18).toString('hex');
  const quoteId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const revision = buf.readUInt16BE(18);
  if (revision < 1) return null;
  return { quoteId, revision, seq: version === 3 ? buf.readUInt16BE(20) : 0 };
}
```

and widen the exported verifier's return type, defaulting the v1 branch to `seq: parsed.s ?? 0`:

```ts
export function verifyQuotePayToken(
  token: string | undefined,
  secret: string,
): { quoteId: string; revision: number; seq: number } | null {
  if (!token) return null;
  const packed = verifyPacked(token, secret);
  if (packed) return packed;
  const parsed = verifiedPayload(token, secret) as {
    v?: unknown; purpose?: unknown; q?: unknown; r?: unknown; s?: unknown;
  } | null;
  if (!parsed || parsed.v !== 1 || parsed.purpose !== 'quote-pay') return null;
  if (typeof parsed.q !== 'string' || parsed.q.length === 0) return null;
  if (typeof parsed.r !== 'number' || !Number.isInteger(parsed.r) || parsed.r < 1) return null;
  const seq = typeof parsed.s === 'number' && Number.isInteger(parsed.s) && parsed.s >= 0 ? parsed.s : 0;
  return { quoteId: parsed.q, revision: parsed.r, seq };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd api && npx vitest run src/lib/bookingToken.test.ts`
Expected: PASS — including the pre-existing v1/v2 cases.

- [ ] **Step 5: Commit**

```bash
git add api/src/lib/bookingToken.ts api/src/lib/bookingToken.test.ts
git commit -m "feat(token): v3 pay token pins the pay-link selection seq"
```

---

### Task 4: Map a booking over the sold legs only

**Files:**
- Modify: `api/src/quote/quoteToBooking.ts`
- Test: `api/src/quote/quoteToBooking.test.ts`

**Interfaces:**
- Produces: `quoteToBooking(quote, details, opts?: { legIndexes?: number[] }): MappedBooking`
  and `isQuoteBookable(quote, opts?: { legIndexes?: number[] }): boolean` — both existing
  signatures with an optional third/second argument, so every current caller is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `api/src/quote/quoteToBooking.test.ts`:

```ts
describe('partial mapping (legIndexes)', () => {
  const quote = savedQuoteWithLegs([
    { from: 'Colombo', to: 'Kandy', distanceKm: 120 },
    { from: 'Kandy', to: 'Ella', distanceKm: 140 },
    { from: 'Ella', to: 'Galle', distanceKm: 200 },
  ]);

  it('maps only the selected legs and sums only their km', () => {
    const mapped = quoteToBooking(quote, details, { legIndexes: [0, 1] });
    expect(mapped.mode).toBe('trip');
    expect((mapped.input as TripInput).stops).toEqual(['Colombo', 'Kandy', 'Ella']);
    expect(mapped.distanceKm).toBe(260);
  });

  it('a one-leg subset of a multi-leg quote is a single transfer', () => {
    const mapped = quoteToBooking(quote, details, { legIndexes: [1] });
    expect(mapped.mode).toBe('single');
    expect(mapped.distanceKm).toBe(140);
  });

  // A dropped middle leg leaves two rides that don't chain — the same gap a disconnected quote
  // produces today. The gap stop is kept, not silently dropped (GC-13).
  it('keeps the gap stop when a middle leg is dropped', () => {
    const mapped = quoteToBooking(quote, details, { legIndexes: [0, 2] });
    expect((mapped.input as TripInput).stops).toEqual(['Colombo', 'Kandy', 'Ella', 'Galle']);
    expect(mapped.distanceKm).toBe(320);
  });

  it('refuses an empty selection', () => {
    expect(() => quoteToBooking(quote, details, { legIndexes: [] })).toThrow(QuoteNotBookableError);
  });

  it('isQuoteBookable answers for the subset', () => {
    expect(isQuoteBookable(quote, { legIndexes: [2] })).toBe(true);
    expect(isQuoteBookable(quote, { legIndexes: [] })).toBe(false);
  });
});
```

Reuse the file's existing fixture helpers; if there is no `savedQuoteWithLegs`, build the quote
inline the way the neighbouring tests do.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/quote/quoteToBooking.test.ts -t "partial mapping"`
Expected: FAIL — `quoteToBooking` takes 2 arguments.

- [ ] **Step 3: Implement the filter**

In `api/src/quote/quoteToBooking.ts`, add the option type and filter the rides at the single
point where the private branch normalizes them:

```ts
// Partial-leg pay links (spec 2026-08-04). `legIndexes` selects which of `engine.legs` this
// booking covers — the legs the customer actually paid for. Absent = the whole itinerary, which
// is every pre-existing caller. Private only; a chauffeur quote never carries a selection.
export interface MapOptions {
  legIndexes?: number[];
}

function selectRides<T>(rides: T[], legIndexes?: number[]): T[] {
  if (!legIndexes) return rides;
  const wanted = [...new Set(legIndexes)].sort((a, b) => a - b);
  return wanted.filter((i) => i >= 0 && i < rides.length).map((i) => rides[i]);
}
```

In the `engine.product === 'private'` branch, replace

```ts
    const rides = engine.legs.map(normalizeRide);
```

with

```ts
    const rides = selectRides(engine.legs.map(normalizeRide), opts?.legIndexes);
```

and change the signature to `export function quoteToBooking(quote: SavedQuote, details: BookingDetails, opts?: MapOptions): MappedBooking`.
The existing `if (!rides.length) throw new QuoteNotBookableError(...)` guard — move it to *after*
the filter if it currently sits before, so an empty selection throws. The `rides.length === 1 &&
rides[0].stops.length === 2` single-vs-trip test then decides on the filtered list with no
further change, and `chainStops` handles the gap.

Thread the same option through `isQuoteBookable`:

```ts
export function isQuoteBookable(quote: SavedQuote, opts?: MapOptions): boolean {
```

passing `opts` to its internal `quoteToBooking` call.

- [ ] **Step 4: Run the tests**

Run: `cd api && npx vitest run src/quote/quoteToBooking.test.ts`
Expected: PASS — the new block plus every existing case (no caller passes `opts`, so the
whole-itinerary behaviour is unchanged).

- [ ] **Step 5: Commit**

```bash
git add api/src/quote/quoteToBooking.ts api/src/quote/quoteToBooking.test.ts
git commit -m "feat(quote): map a booking over a subset of legs"
```

---

### Task 5: Mint a partial link

**Files:**
- Modify: `api/src/routes/internalQuote.ts:894-919` (the `/:id/pay-link` route)
- Test: `api/src/routes/internalQuote.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `POST /admin/quote/:id/pay-link` with an optional JSON body
  `{ legIndexes: number[], extraIndexes: number[] }`; response
  `{ url: string, payhereMode: string, coverage: { soldLegs: number, totalLegs: number } | null, amountCents: number }`.

- [ ] **Step 1: Write the failing test**

Append to `api/src/routes/internalQuote.test.ts`:

```ts
describe('POST /admin/quote/:id/pay-link with a selection', () => {
  it('mints a link for the picked legs and stores the frozen amount', async () => {
    const { app, quotes, quote } = await readyPrivateQuoteWith3Legs();
    const res = await app.request(`/admin/quote/${quote.id}/pay-link`, {
      method: 'POST',
      headers: opsHeaders(),
      body: JSON.stringify({ legIndexes: [0, 1], extraIndexes: [] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.coverage).toEqual({ soldLegs: 2, totalLegs: 3 });

    const saved = await quotes.get(quote.id);
    expect(saved!.payLinkSelection).toEqual({ legIndexes: [0, 1], extraIndexes: [] });
    expect(saved!.soldCents).toBe(body.amountCents);
    expect(saved!.payLinkSeq).toBe(1);
    // Minting must never move the lifecycle.
    expect(saved!.status).toBe(quote.status);
    expect(saved!.sentAt).toEqual(quote.sentAt);
    expect(saved!.revision).toBe(quote.revision);
  });

  it('re-minting the same selection returns the identical URL and does not bump seq', async () => {
    const { app, quotes, quote } = await readyPrivateQuoteWith3Legs();
    const sel = { legIndexes: [0], extraIndexes: [] };
    const a = await (await mint(app, quote.id, sel)).json();
    const b = await (await mint(app, quote.id, sel)).json();
    expect(b.url).toBe(a.url);
    expect((await quotes.get(quote.id))!.payLinkSeq).toBe(1);
  });

  it('a different selection bumps seq, so the old link is retired', async () => {
    const { app, quotes, quote } = await readyPrivateQuoteWith3Legs();
    const a = await (await mint(app, quote.id, { legIndexes: [0], extraIndexes: [] })).json();
    const b = await (await mint(app, quote.id, { legIndexes: [1], extraIndexes: [] })).json();
    expect(b.url).not.toBe(a.url);
    expect((await quotes.get(quote.id))!.payLinkSeq).toBe(2);
  });

  it('a full selection clears the stored selection and charges the quote total', async () => {
    const { app, quotes, quote } = await readyPrivateQuoteWith3Legs();
    await mint(app, quote.id, { legIndexes: [0], extraIndexes: [] });
    const res = await mint(app, quote.id, allLinesOf(quote));
    const body = await res.json();
    expect(body.amountCents).toBe(quote.totalCents); // finishing preserved, spec §4
    expect(body.coverage).toBeNull();
    const saved = await quotes.get(quote.id);
    expect(saved!.payLinkSelection).toBeNull();
    expect(saved!.soldCents).toBeNull();
    expect(saved!.payLinkSeq).toBe(2); // monotonic — never reset
  });

  it('refuses a selection with no legs', async () => {
    const { app, quote } = await readyPrivateQuoteWith3Legs();
    const res = await mint(app, quote.id, { legIndexes: [], extraIndexes: [0] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('not_linkable');
  });

  it('refuses a selection on a chauffeur quote', async () => {
    const { app, quote } = await readyChauffeurQuote();
    const res = await mint(app, quote.id, { legIndexes: [0], extraIndexes: [] });
    expect(res.status).toBe(409);
  });
});
```

Add the local helpers `mint(app, id, selection)` (POST with ops headers and a JSON body) and
`allLinesOf(quote)` (every leg index and every extra index of the fixture) beside the existing
helpers in that file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t "with a selection"`
Expected: FAIL — the route ignores the body; `coverage` is undefined.

- [ ] **Step 3: Implement the route**

In `api/src/routes/internalQuote.ts`, add the imports:

```ts
import { payLines, selectionAmountCents, isFullSelection, NotLineablePriceError, type PaySelection } from '../quote/paySelection';
```

and a body schema next to the file's other zod schemas:

```ts
const PayLinkSelectionSchema = z.object({
  legIndexes: z.array(z.number().int().min(0)),
  extraIndexes: z.array(z.number().int().min(0)),
}).strict();
```

Replace the body of `r.post('/:id/pay-link', csrf, …)` after the existing `not_linkable` gate with:

```ts
    if (!deps.linkSecret || !deps.payBaseUrl) return c.json({ error: 'pay_links_unavailable' }, 503);

    // No body = the full-total link, exactly as before this feature existed.
    const raw = await c.req.json().catch(() => null);
    const parsedSel = raw == null ? null : PayLinkSelectionSchema.safeParse(raw);
    if (parsedSel && !parsedSel.success) return c.json({ error: 'bad_request' }, 400);
    let selection: PaySelection | null = parsedSel ? parsedSel.data : null;

    let amountCents = quote.totalCents;
    let coverage: { soldLegs: number; totalLegs: number } | null = null;

    if (selection) {
      // Private only, and priced — payLines throws otherwise (chauffeur, shell, legacy row).
      let lines;
      try {
        lines = payLines(quote);
      } catch (e) {
        if (e instanceof NotLineablePriceError) return c.json({ error: 'not_linkable' }, 409);
        throw e;
      }
      if (isFullSelection(lines, selection)) {
        // Nothing was unticked — use the stored total so charm finishing survives (spec §4).
        selection = null;
      } else {
        if (!selection.legIndexes.length) return c.json({ error: 'not_linkable' }, 409);
        if (!isQuoteBookable(quote, { legIndexes: selection.legIndexes })) {
          return c.json({ error: 'not_linkable' }, 409);
        }
        amountCents = selectionAmountCents(lines, selection);
        if (amountCents <= 0) return c.json({ error: 'not_linkable' }, 409);
        coverage = { soldLegs: selection.legIndexes.length, totalLegs: engine.legs.length };
      }
    }

    // The seq moves ONLY when the selection actually changes, so pressing the button twice
    // still yields a byte-identical URL.
    const current = quote.payLinkSelection;
    const changed = JSON.stringify(normalizeSel(current)) !== JSON.stringify(normalizeSel(selection));
    const seq = changed ? quote.payLinkSeq + 1 : quote.payLinkSeq;
    if (changed) {
      await deps.quotes.patch(quote.id, {
        // Canonical (deduped, sorted) form, so [1,0] and [0,1] are one selection, not two.
        payLinkSelection: normalizeSel(selection),
        soldCents: selection ? amountCents : null,
        payLinkSeq: seq,
      });
    }

    const token = signQuotePayToken(quote.id, quote.revision, deps.linkSecret, seq);
    return c.json({
      url: `${deps.payBaseUrl.replace(/\/$/, '')}/p?t=${token}`,
      payhereMode: deps.payhereMode ?? 'off',
      amountCents,
      coverage,
    });
```

with this helper above the router (sorted indexes, so `[1,0]` and `[0,1]` are the same selection):

```ts
function normalizeSel(sel: PaySelection | null): PaySelection | null {
  if (!sel) return null;
  return {
    legIndexes: [...new Set(sel.legIndexes)].sort((a, b) => a - b),
    extraIndexes: [...new Set(sel.extraIndexes)].sort((a, b) => a - b),
  };
}
```

Store `normalizeSel(selection)` rather than the raw body so the stored form is canonical.

- [ ] **Step 4: Add the read endpoint the picker lists from**

The picker must show the same labels and amounts the server will charge — reconstructing them in
the browser is how the two drift apart. Add, immediately above the `/:id/pay-link` route (so the
literal path is registered before any `/:id` param route):

```ts
  // The charge lines of a quote, for the ops "Part of trip…" picker. Founder/ops only, same
  // guard as the rest of this router. Read-only: no selection is stored by looking.
  r.get('/:id/pay-lines', async (c) => {
    const quote = await deps.quotes.get(c.req.param('id'));
    if (!quote) return c.json({ error: 'not_found' }, 404);
    try {
      return c.json({
        lines: payLines(quote),
        totalCents: quote.totalCents,
        selection: quote.payLinkSelection,
      });
    } catch (e) {
      if (e instanceof NotLineablePriceError) return c.json({ error: 'not_linkable' }, 409);
      throw e;
    }
  });
```

Add a test asserting a chauffeur quote gets 409 and a private quote's line count equals
`legs.length + extras.length`.

- [ ] **Step 5: Run the tests**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: PASS — the new block plus every existing pay-link test (a bodyless POST still mints the
full-total link).

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts
git commit -m "feat(ops): mint a payment link for a subset of a quote's legs"
```

---

### Task 6: `/quotes/pay/view` — seq check, lines and coverage

**Files:**
- Modify: `api/src/routes/quotePay.ts:72-121`
- Test: `api/src/routes/quotePay.test.ts`

**Interfaces:**
- Produces: `/quotes/pay/view` for a partial link returns, in addition to today's fields,
  `lines: { label: string, amountCents: number }[]` and
  `coverage: { soldLegs: number, totalLegs: number }`; `totals` reflects `soldCents`.

- [ ] **Step 1: Write the failing test**

Append to `api/src/routes/quotePay.test.ts`:

```ts
describe('/quotes/pay/view for a partial link', () => {
  it('shows the picked lines, the coverage and the sold total', async () => {
    const { app, token, expected } = await partialLinkFixture({ legIndexes: [0, 1], extraIndexes: [] });
    const body = await (await app.request(`/quotes/pay/view?t=${token}`)).json();
    expect(body.state).toBe('payable');
    expect(body.totals.cents).toBe(expected.soldCents);
    expect(body.coverage).toEqual({ soldLegs: 2, totalLegs: 3 });
    expect(body.lines.map((l: { label: string }) => l.label)).toEqual(['Colombo → Kandy', 'Kandy → Ella']);
  });

  it('leaks no margin, hot-zone or rate-card data', async () => {
    const { app, token } = await partialLinkFixture({ legIndexes: [0], extraIndexes: [] });
    const raw = await (await app.request(`/quotes/pay/view?t=${token}`)).text();
    expect(raw).not.toMatch(/margin|hotZone|rateCardJson|marginCents/i);
  });

  it('a link whose seq is stale renders revised', async () => {
    const { app, token, remintWith } = await partialLinkFixture({ legIndexes: [0], extraIndexes: [] });
    await remintWith({ legIndexes: [1], extraIndexes: [] });
    const body = await (await app.request(`/quotes/pay/view?t=${token}`)).json();
    expect(body.state).toBe('revised');
  });

  it('a full-quote link is unchanged — no lines, no coverage', async () => {
    const { app, token } = await fullLinkFixture();
    const body = await (await app.request(`/quotes/pay/view?t=${token}`)).json();
    expect(body.state).toBe('payable');
    expect(body.lines).toBeUndefined();
    expect(body.coverage).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/routes/quotePay.test.ts -t "for a partial link"`
Expected: FAIL — `coverage` undefined; the stale-seq case returns `payable`.

- [ ] **Step 3: Implement**

In `api/src/routes/quotePay.ts`, extend `stateFor` to take the whole parsed token and check the
seq alongside the revision:

```ts
  async function stateFor(
    quote: SavedQuote | null,
    parsed: { revision: number; seq: number },
  ): Promise<{ state: PayState; paidVia?: { bookingId: string } }> {
    if (!quote) return { state: 'unavailable' };
    if (quote.convertedBookingId) { /* …unchanged… */ }
    else if (quote.status === 'won') return { state: 'paid' };
    if (quote.revision !== parsed.revision) return { state: 'revised' };
    // A re-pick retires the outstanding link exactly as an edit does: same screen, same reason
    // — the number this link was minted for is no longer the number ops is asking for.
    if (quote.payLinkSeq !== parsed.seq) return { state: 'revised' };
    if (quote.status === 'ready' || quote.status === 'sent') return { state: 'payable' };
    return { state: 'unavailable' };
  }
```

Update both call sites to pass `parsed`. In the `payable` response, add the partial fields:

```ts
    const soldCents = quote.soldCents ?? quote.totalCents;
    const sel = quote.payLinkSelection;
    const engine = (quote.request as { engine?: QuoteRequest } | null)?.engine;
    const partial = sel && engine && engine.product === 'private'
      ? (() => {
          const all = payLines(quote);
          const ticked = all.filter((l) =>
            l.kind === 'leg' ? sel.legIndexes.includes(l.index) : sel.extraIndexes.includes(l.index),
          );
          return {
            // Hand-picked projection: label and amount ONLY. PayLine's `kind`/`index`/`legIndex`
            // are internal and must not reach the wire.
            lines: ticked.map((l) => ({ label: l.label, amountCents: l.amountCents })),
            coverage: { soldLegs: sel.legIndexes.length, totalLegs: engine.legs.length },
          };
        })()
      : null;

    return c.json({
      state,
      copy: payPageCopy(quote),
      totals: { cents: soldCents, usd: usd(soldCents) },
      prefill: prefillFor(quote),
      ...(partial ?? {}),
    });
```

- [ ] **Step 4: Run the tests**

Run: `cd api && npx vitest run src/routes/quotePay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/quotePay.ts api/src/routes/quotePay.test.ts
git commit -m "feat(pay): view a partial link as an itemised receipt"
```

---

### Task 7: `/quotes/pay/start` — subset booking, seq-scoped idempotency

The money-correctness task. Read spec §9 before starting.

**Files:**
- Modify: `api/src/routes/quotePay.ts:123-224`
- Test: `api/src/routes/quotePay.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('/quotes/pay/start for a partial link', () => {
  it('creates a booking over the sold legs at the sold amount', async () => {
    const { app, token, expected, bookings } = await partialLinkFixture({ legIndexes: [0, 1], extraIndexes: [] });
    const res = await app.request('/quotes/pay/start', {
      method: 'POST',
      body: JSON.stringify({ t: token, customer, termsAccepted: true }),
    });
    expect(res.status).toBe(201);
    const booking = await bookings.get((await res.json()).bookingId);
    expect(booking!.total).toBe(expected.soldCents);
    expect(booking!.input.stops).toEqual(['Colombo', 'Kandy', 'Ella']);
  });

  // The bug this task exists to prevent (spec §9): selection A leaves a payment_pending booking
  // and stamps convertedBookingId; ops re-picks; the NEW link must not resume A's booking and
  // charge A's amount.
  it('does not resume a booking minted under a different selection', async () => {
    const f = await partialLinkFixture({ legIndexes: [0, 1], extraIndexes: [] });
    const first = await (await start(f.app, f.token)).json();
    const tokenB = await f.remintWith({ legIndexes: [2], extraIndexes: [] });
    const second = await (await start(f.app, tokenB)).json();

    expect(second.bookingId).not.toBe(first.bookingId);
    const b = await f.bookings.get(second.bookingId);
    expect(b!.total).toBe(f.soldCentsFor({ legIndexes: [2], extraIndexes: [] }));
  });

  it('a double tap on the SAME link still yields one booking', async () => {
    const f = await partialLinkFixture({ legIndexes: [0], extraIndexes: [] });
    const a = await (await start(f.app, f.token)).json();
    const b = await (await start(f.app, f.token)).json();
    expect(b.bookingId).toBe(a.bookingId);
  });

  it('refuses a stale-seq link', async () => {
    const f = await partialLinkFixture({ legIndexes: [0], extraIndexes: [] });
    await f.remintWith({ legIndexes: [1], extraIndexes: [] });
    const res = await start(f.app, f.token);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('quote_revised');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/routes/quotePay.test.ts -t "for a partial link"`
Expected: FAIL — the second test returns the first booking and charges the wrong total.

- [ ] **Step 3: Implement**

In `/start`, after the state checks:

```ts
    // Seq-scoped, so a booking minted under one selection can never be resumed by a link minted
    // under another (spec §9).
    //
    // Resumability is decided by the KEY LOOKUP ALONE, never by convertedBookingId. The key
    // carries revision AND seq, so findByIdempotencyKey can only ever return a booking from this
    // exact selection — no comparison needed, and none is possible: `Booking` does not expose its
    // idempotency key. Consulting convertedBookingId first (today's behaviour) is precisely what
    // would hand back the previous selection's booking, at the previous selection's amount.
    const baseKey = `pay:quote:${quote.id}:r${parsed.revision}:s${parsed.seq}`;
    const found = await deps.bookings.findByIdempotencyKey(baseKey);
    const chargeable = found && (found.status === 'draft' || found.status === 'payment_pending');
```

Leave the resume branch that follows exactly as it is. For the fresh-booking path, derive the key
from whatever booking already exists — this selection's dead one, or the previous selection's via
`convertedBookingId` — so a double tap still yields exactly one booking:

```ts
    const prior = found ?? (quote.convertedBookingId ? await deps.bookings.get(quote.convertedBookingId) : null);
    const idempotencyKey = prior ? `${baseKey}:after:${prior.id}` : baseKey;
```

Note this deliberately changes behaviour for FULL links too: they now key on `:s0` and stop
consulting `convertedBookingId` for resumption. The existing cancelled-booking tests
(2026-08-02) must still pass — a cancelled prior is ignored and a fresh booking is minted, which
is exactly what this shape does.

Then map and price against the selection:

```ts
    const legIndexes = quote.payLinkSelection?.legIndexes;
    const soldCents = quote.soldCents ?? quote.totalCents;
    ...
      mapped = quoteToBooking(quote, { ...details }, legIndexes ? { legIndexes } : undefined);
```

and replace both `total`/`amountDueNow` occurrences in the `newBooking` literal with `soldCents`.

No change to `BookingRepo` is needed — the key lookup is the only thing consulted.

- [ ] **Step 4: Run the tests**

Run: `cd api && npx vitest run src/routes/quotePay.test.ts`
Expected: PASS, including the existing cancelled-booking resume tests.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/quotePay.ts api/src/routes/quotePay.test.ts
git commit -m "fix(pay): never resume a booking across pay-link selections"
```

---

### Task 8: Funnel won-value uses the sold amount

**Files:**
- Modify: `api/src/db/quoteRepo.ts` (`FunnelQuoteRow`), `api/src/db/postgresQuoteRepo.ts`
  (`listFunnelRows`), `api/src/services/analytics/funnel.ts:60`
- Test: `api/src/services/analytics/funnel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('books a partial sale at the sold amount, not the quote total', () => {
  const rows = [
    funnelRow({ status: 'won', totalCents: 90000, soldCents: 31000, currency: 'USD', decidedAt: inRange }),
  ];
  const out = computeFunnel(rows, range);
  expect(out.totals.wonValue.USD).toBe(31000);
  // What was OFFERED is still the full quote — sent/pipeline/aging are unchanged.
  expect(out.totals.sentValue.USD).toBe(90000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/services/analytics/funnel.test.ts -t "partial sale"`
Expected: FAIL — `wonValue.USD` is 90000.

- [ ] **Step 3: Implement**

Add `soldCents: number | null;` to `FunnelQuoteRow`, select `quotes.soldCents` in
`listFunnelRows`, and in `funnel.ts` change the won branch only:

```ts
    // A partial sale wins the quote at the amount actually charged; booking totalCents here
    // would overstate revenue by the legs the customer didn't buy (spec §11).
    if (r.status === 'won' && decidedIn(r, from, to)) addCurrency(wonValue, r.currency, r.soldCents ?? r.totalCents);
```

- [ ] **Step 4: Run the tests**

Run: `cd api && npx vitest run src/services/analytics/funnel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/db/quoteRepo.ts api/src/db/postgresQuoteRepo.ts api/src/services/analytics/funnel.ts api/src/services/analytics/funnel.test.ts
git commit -m "fix(analytics): won value follows the amount actually sold"
```

---

### Task 9: `/book` retires an outstanding selection

**Files:**
- Modify: `api/src/routes/internalQuote.ts:840-884` (the `/:id/book` route)
- Test: `api/src/routes/internalQuote.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('marking booked charges the full quote and retires an outstanding partial link', async () => {
  const { app, quotes, quote } = await readyPrivateQuoteWith3Legs();
  await mint(app, quote.id, { legIndexes: [0], extraIndexes: [] });
  const res = await app.request(`/admin/quote/${quote.id}/book`, {
    method: 'POST', headers: opsHeaders(), body: JSON.stringify(bookDetails),
  });
  expect(res.status).toBe(201);
  const booking = await res.json();
  expect(booking.total).toBe(quote.totalCents);

  const saved = await quotes.get(quote.id);
  expect(saved!.payLinkSelection).toBeNull();
  expect(saved!.soldCents).toBeNull();
  expect(saved!.payLinkSeq).toBe(2); // bumped, so the outstanding link is dead
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t "retires an outstanding"`
Expected: FAIL — the selection is still stored and `payLinkSeq` is 1.

- [ ] **Step 3: Implement**

`/book` stays full-quote — it is the "paid me another way" lever — but must kill the link it
contradicts. In the existing final patch call, extend the payload:

```ts
    await deps.quotes.patch(id, {
      convertedBookingId: booking.id,
      status: 'won',
      // A partial link for this quote is now contradicted by a full-quote booking. Retire it
      // rather than leaving a live link that would create a second booking (spec §10).
      ...(quote.payLinkSelection
        ? { payLinkSelection: null, soldCents: null, payLinkSeq: quote.payLinkSeq + 1 }
        : {}),
    });
```

- [ ] **Step 4: Run the tests**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts
git commit -m "fix(ops): mark-booked retires an outstanding partial pay link"
```

---

### Task 10: Ops picker UI

**Files:**
- Modify: `api/src/routes/ops-ui.html` (near `mintPayLink`, ~line 4760)
- Test: `web-tests/unit/ops-pay-selection.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `web-tests/unit/ops-pay-selection.test.js`, following the pattern of the existing
`web-tests/unit/ops-*.test.js` files (they extract a function from `ops-ui.html` and exercise it):

```js
import { describe, it, expect } from 'vitest';
import { paySelectionState, toggleLine, selectionSummary } from './helpers/ops-pay-selection.js';

const lines = [
  { kind: 'leg', index: 0, label: 'Colombo → Kandy', amountCents: 5000 },
  { kind: 'leg', index: 1, label: 'Kandy → Ella', amountCents: 6000 },
  { kind: 'extra', index: 0, label: 'Luggage rack — Kandy → Ella', amountCents: 500, legIndex: 1 },
];

describe('pay selection picker', () => {
  it('starts with everything ticked', () => {
    const s = paySelectionState(lines);
    expect(s.legIndexes).toEqual([0, 1]);
    expect(s.extraIndexes).toEqual([0]);
  });

  it('unticking a leg unticks the extras attributed to it', () => {
    const s = toggleLine(paySelectionState(lines), lines, { kind: 'leg', index: 1 });
    expect(s.legIndexes).toEqual([0]);
    expect(s.extraIndexes).toEqual([]);
  });

  it('re-ticking the leg re-ticks them', () => {
    let s = toggleLine(paySelectionState(lines), lines, { kind: 'leg', index: 1 });
    s = toggleLine(s, lines, { kind: 'leg', index: 1 });
    expect(s.extraIndexes).toEqual([0]);
  });

  it("an extra can be dropped on its own", () => {
    const s = toggleLine(paySelectionState(lines), lines, { kind: 'extra', index: 0 });
    expect(s.legIndexes).toEqual([0, 1]);
    expect(s.extraIndexes).toEqual([]);
  });

  it('summarises coverage and total', () => {
    const s = toggleLine(paySelectionState(lines), lines, { kind: 'leg', index: 1 });
    expect(selectionSummary(s, lines)).toEqual({ soldLegs: 1, totalLegs: 2, amountCents: 5000, gapAfter: null });
  });

  it('names the gap when a middle leg is dropped', () => {
    const three = [...lines.slice(0, 2), { kind: 'leg', index: 2, label: 'Ella → Galle', amountCents: 9000 }];
    const s = toggleLine(paySelectionState(three), three, { kind: 'leg', index: 1 });
    expect(selectionSummary(s, three).gapAfter).toBe('Colombo → Kandy');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web-tests && npx vitest run unit/ops-pay-selection.test.js`
Expected: FAIL — the helper module does not exist.

- [ ] **Step 3: Implement the picker**

Add these three pure functions to `api/src/routes/ops-ui.html`, beside `mintPayLink` (ES5-style
`var`/`function`, matching the rest of that file):

```js
/* Partial pay links (spec 2026-08-04). The picker OPENS with everything ticked and ops only
   unticks, so its starting state is exactly today's full-total link — which is why an untouched
   picker needs no special case: the server sees a full selection and uses the stored total. */
function paySelectionState(lines) {
  return {
    legIndexes: lines.filter(function (l) { return l.kind === 'leg'; }).map(function (l) { return l.index; }),
    extraIndexes: lines.filter(function (l) { return l.kind === 'extra'; }).map(function (l) { return l.index; }),
  };
}

/* Unticking a leg takes its attributed extras with it — charging for a child seat on a leg
   nobody bought is exactly the kind of line that turns a payment page into an argument. An
   extra can still be dropped on its own. */
function toggleLine(state, lines, line) {
  var legs = state.legIndexes.slice();
  var extras = state.extraIndexes.slice();
  var without = function (arr, n) { return arr.filter(function (x) { return x !== n; }); };
  var attributed = function (legIndex) {
    return lines.filter(function (l) { return l.kind === 'extra' && l.legIndex === legIndex; })
                .map(function (l) { return l.index; });
  };
  if (line.kind === 'leg') {
    if (legs.indexOf(line.index) >= 0) {
      legs = without(legs, line.index);
      attributed(line.index).forEach(function (i) { extras = without(extras, i); });
    } else {
      legs = legs.concat(line.index).sort(function (a, b) { return a - b; });
      attributed(line.index).forEach(function (i) {
        if (extras.indexOf(i) < 0) extras = extras.concat(i);
      });
      extras.sort(function (a, b) { return a - b; });
    }
  } else {
    extras = extras.indexOf(line.index) >= 0
      ? without(extras, line.index)
      : extras.concat(line.index).sort(function (a, b) { return a - b; });
  }
  return { legIndexes: legs, extraIndexes: extras };
}

/* Mirrors selectionAmountCents/gapAfterLeg from api/src/quote/paySelection.ts. The server is
   authoritative for the amount; this is the running total the operator watches while picking. */
function selectionSummary(state, lines) {
  var ticked = function (l) {
    return l.kind === 'leg' ? state.legIndexes.indexOf(l.index) >= 0 : state.extraIndexes.indexOf(l.index) >= 0;
  };
  var sorted = state.legIndexes.slice().sort(function (a, b) { return a - b; });
  var gapAfter = null;
  for (var i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) {
      var prev = sorted[i - 1];
      var row = lines.filter(function (l) { return l.kind === 'leg' && l.index === prev; })[0];
      gapAfter = row ? row.label : null;
      break;
    }
  }
  return {
    soldLegs: state.legIndexes.length,
    totalLegs: lines.filter(function (l) { return l.kind === 'leg'; }).length,
    amountCents: lines.filter(ticked).reduce(function (sum, l) { return sum + l.amountCents; }, 0),
    gapAfter: gapAfter,
  };
}
```

Then wire the UI:

- `openPayPartPicker()` — renders the flat line list with checkboxes, the running summary, the gap
  warning when `gapAfter` is non-null (*"Leaves a gap after {gapAfter}. The vehicle's
  repositioning isn't priced into these legs, and the customer's itinerary will show the gap as a
  leg."*), and a Confirm that POSTs the selection to `/admin/quote/:id/pay-link` and then copies
  the URL with the existing `payLinkToast()` rules.
- Confirm is disabled only when no leg is ticked.
- After a successful mint, show the outstanding coverage next to the button
  (*"Link sent for 2 of 4 legs — $310.00"*), sourced from the response's `coverage`/`amountCents`.

Mirror the three pure functions into `web-tests/unit/helpers/ops-pay-selection.js` the way the
other `ops-*` unit tests share code, so the test exercises the same logic.

- [ ] **Step 4: Run the tests**

Run: `cd web-tests && npx vitest run unit/ops-pay-selection.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/ops-ui.html web-tests/unit/ops-pay-selection.test.js web-tests/unit/helpers/ops-pay-selection.js
git commit -m "feat(ops-ui): pick which legs a payment link covers"
```

---

### Task 11: Pay page receipt

**Files:**
- Modify: `pay.html` (~line 460, the payable render)
- Test: `web-tests/unit/pay-page-lines.test.js` (new)

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { linesHtml, coverageSentence } from './helpers/pay-lines.js';

describe('partial pay page', () => {
  it('renders one row per paid line', () => {
    const html = linesHtml([
      { label: 'Colombo → Kandy', amountCents: 5000 },
      { label: 'Luggage rack — Kandy → Ella', amountCents: 500 },
    ]);
    expect(html).toContain('Colombo → Kandy');
    expect(html).toContain('$50.00');
    expect(html).toContain('$5.00');
  });

  it('escapes place names', () => {
    expect(linesHtml([{ label: '<script>x</script>', amountCents: 100 }])).not.toContain('<script>');
  });

  it('states coverage in words', () => {
    expect(coverageSentence({ soldLegs: 2, totalLegs: 4 }))
      .toBe('This covers 2 of the 4 legs in your itinerary.');
  });

  it('says nothing when coverage is absent', () => {
    expect(coverageSentence(undefined)).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web-tests && npx vitest run unit/pay-page-lines.test.js`
Expected: FAIL — helper missing.

- [ ] **Step 3: Implement**

Add to `pay.html`, beside the other render helpers:

```js
/* Partial pay links (spec 2026-08-04). The page becomes a RECEIPT: the customer sees the lines
   they are paying for, and the total is visibly their sum. Excluded legs are deliberately not
   listed — the coverage sentence is enough to prevent "I thought this was the whole trip",
   without reading as an inventory of what they failed to buy. */
function linesHtml(lines) {
  if (!lines || !lines.length) return '';
  return '<ul class="paid-lines">' + lines.map(function (l) {
    return '<li><span class="l">' + esc(l.label) + '</span>'
         + '<span class="v">$' + (l.amountCents / 100).toFixed(2) + '</span></li>';
  }).join('') + '</ul>';
}

function coverageSentence(coverage) {
  if (!coverage) return '';
  return 'This covers ' + coverage.soldLegs + ' of the ' + coverage.totalLegs
       + ' legs in your itinerary.';
}
```

Render them in the payable view immediately above the existing total row
(`'<div class="tot">…' + esc(data.totals.usd) + …`):

```js
      + linesHtml(data.lines)
      + (data.coverage ? '<p class="coverage">' + esc(coverageSentence(data.coverage)) + '</p>' : '')
```

Both are no-ops on a full-quote link, which sends neither field. Mirror the two functions into
`web-tests/unit/helpers/pay-lines.js` (with a local `esc`) so the unit test exercises the same
logic the page runs.

- [ ] **Step 4: Run the tests**

Run: `cd web-tests && npx vitest run unit/pay-page-lines.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pay.html web-tests/unit/pay-page-lines.test.js web-tests/unit/helpers/pay-lines.js
git commit -m "feat(pay): itemise the paid legs on a partial payment page"
```

---

### Task 12: Coverage sentence on the confirmation email and ops drawer

Mitigation for the gap defect (spec §8). The itinerary list still renders a gap as a driven leg;
this sentence is what stops the email reading as a promise to drive it.

**Files:**
- Modify: `api/src/services/notifications.ts`
- Modify: `api/src/routes/ops-ui.html` (`legsHtmlFor`)
- Modify: `docs/known-bugs.md`
- Test: `api/src/services/notifications.test.ts`

- [ ] **Step 1: Write the failing test**

Spiked before writing this: `sendBookingConfirmation(booking, email, links)` is **pure over its
arguments** — it has no repo access, and every other sender in that file follows the same rule.
So the coverage is passed IN, by the caller that already resolves the quote. Follow the existing
test style in `notifications.test.ts` (a fake `EmailAdapter` capturing `send`):

```ts
it('tells the customer which legs a partial booking covers', async () => {
  const email = fakeEmail();
  await sendBookingConfirmation(trip, email, { coverage: { soldLegs: 2, totalLegs: 4 } });
  expect(email.sent[0].html).toContain('covers 2 of the 4 legs in your itinerary');
  expect(email.sent[0].html).toContain('your own arrangement');
  expect(email.sent[0].text).toContain('covers 2 of the 4 legs');
});

it('says nothing extra for a whole-trip booking', async () => {
  const email = fakeEmail();
  await sendBookingConfirmation(trip, email);
  expect(email.sent[0].html).not.toContain('covers');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/services/notifications.test.ts -t "partial booking"`
Expected: FAIL — no such sentence.

- [ ] **Step 3: Implement**

Widen the third argument of `sendBookingConfirmation` (it already carries `{ manage? }`):

```ts
export async function sendBookingConfirmation(
  booking: Booking,
  email: EmailAdapter,
  links: { manage?: string; coverage?: { soldLegs: number; totalLegs: number } } = {},
): Promise<void> {
```

and render one sentence above the itinerary in both `renderHtml` and `renderText` when
`coverage` is present:

> This booking covers 2 of the 4 legs in your itinerary; travel between them is your own
> arrangement.

Then supply it from the one caller that settles a payment,
`api/src/routes/webhooks.ts:229` — it already resolves the quote there for `claimWonQuote`:

```ts
          const q = await quotes.findByConvertedBookingId(paid.id);
          const sel = q?.payLinkSelection;
          const legs = ((q?.request as { engine?: { legs?: unknown[] } } | null)?.engine?.legs ?? []).length;
          await sendBookingConfirmation(paid, email, {
            manage: manageUrl(paid, baseUrl, linkSecret),
            ...(sel && legs ? { coverage: { soldLegs: sel.legIndexes.length, totalLegs: legs } } : {}),
          });
```

Give `api/src/routes/devEmails.ts`'s `confirmation` entry a fixture coverage so the
`/dev/emails` preview shows the partial variant. Add the same line to the ops drawer's
`legsHtmlFor` output. Then append a row to
`docs/known-bugs.md` recording the residual risk: *a gapped partial booking still renders the gap
pair as a driven leg in the itinerary list; the coverage sentence contradicts it. Closes when
`docs/backend-spec.md` §5.2 lands.*

- [ ] **Step 4: Run the tests**

Run: `cd api && npx vitest run src/services/notifications.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/services/notifications.ts api/src/routes/webhooks.ts api/src/routes/devEmails.ts api/src/routes/ops-ui.html api/src/services/notifications.test.ts docs/known-bugs.md
git commit -m "feat(email): state what a partial booking covers"
```

---

### Task 13: End-to-end chain

**Files:**
- Modify: `web-tests/e2e/pay-link-chain.spec.js`

- [ ] **Step 1: Write the failing test**

Add a spec that drives the real stack: approve a 3-leg private quote in `/ops`, open the
"Part of trip…" picker, untick the last leg, confirm, open the minted URL, assert the pay page
shows two line rows and *"This covers 2 of the 3 legs"*, submit the customer form, and assert the
created booking's total equals the summed lines and its stops are the two sold legs.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web-tests && npx playwright test e2e/pay-link-chain.spec.js`
Expected: FAIL — the picker does not exist until Task 10 is merged (this task runs last).

- [ ] **Step 3: Make it pass**

No new production code should be needed. If it is, the gap belongs in the task that owns that
file — go back and add it there rather than patching here. Act-then-verify: after clicking
Confirm, wait for the toast before reading the URL, never assert on a value read before the
action settled.

- [ ] **Step 4: Run the full suites**

```bash
cd api && npm test
```

```bash
cd web-tests && npm run test:all
```

Expected: PASS. The `ops-addleg` e2e flake is known and is not a regression.

- [ ] **Step 5: Commit**

```bash
git add web-tests/e2e/pay-link-chain.spec.js
git commit -m "test(e2e): partial pay link from picker to booking"
```

---

## Rollout

Additive migration, additive columns, additive token version — a quote with no selection behaves
exactly as it does today. Open one PR against `main`; staging deploys automatically, and migration
`0038` applies on boot (fail-closed), so merging it is its release. Prod follows via the usual
promote PR to `production`.
