# Quote revision history (Slice 2) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every superseded version of a quote, so a price change can be read out of the
database instead of reconstructed from arithmetic.

**Architecture:** `update()` copies the current quote row into `quote_revisions` before
overwriting it, inside one transaction. A `quote:manage` endpoint returns the timeline with the
field names that changed between versions; a list panel in the builder renders it.

**Tech Stack:** TypeScript, Hono, Drizzle (Postgres), Vitest. The ops UI is vanilla JS in one HTML
file.

**Spec:** `docs/superpowers/specs/2026-08-05-quote-history-design.md` §4–§6. Slice 1 (the
price-drift indicator) is already merged — PR #309.

## Global Constraints

- **Snapshot-before-overwrite.** History holds *superseded* states; `quotes` holds the live one.
  Never write the new state to history — that would duplicate the current row.
- **The write is inside `update()`'s transaction.** A snapshot must never be missing for a write
  that landed, and a failed snapshot must never let the write land alone.
- **No-op saves record nothing.** Compare the incoming `request_json` against the stored one with
  a key-order-stable serialisation. NOT `result_json` — it re-prices on every save, so a rate-card
  move would fake a change. If the comparison is ever wrong the failure must be benign: an extra
  row, never a missing one.
- **Revision gaps are correct**, not a bug: a gap means the counter moved and the content did not.
- **`update()` keeps bumping `revision` unconditionally.** It is what retires a pay link on
  re-approval, and `internalQuote.test.ts` pins it. Do not make it conditional.
- **No margin, rate-card snapshot or hot-zone data on the wire** — same invariant as
  `/quotes/pay/view`.
- Migration is `0040`, and **it needs a `drizzle/meta/_journal.json` entry** or it silently never
  runs.
- Commit per task. Isolated worktree off `origin/main`, never the shared tree.

## File Structure

| File | Responsibility |
| --- | --- |
| `api/drizzle/0040_quote_revisions.sql` (new) | the table |
| `api/drizzle/meta/_journal.json` | the entry that makes it run |
| `api/src/db/schema.ts` | Drizzle table definition |
| `api/src/db/quoteRepo.ts` | `QuoteRevision` type, `listRevisions`, in-memory snapshot |
| `api/src/db/postgresQuoteRepo.ts` | the transactional snapshot in `update()`/`updateWebV2()` |
| `api/src/quote/quoteDiff.ts` (new) | pure: which fields differ between two versions |
| `api/src/routes/internalQuote.ts` | `GET /:id/revisions` |
| `api/src/routes/ops-ui.html` | the history panel |

---

### Task 1: The table and the ops write path

**Files:**
- Create: `api/drizzle/0040_quote_revisions.sql`
- Modify: `api/drizzle/meta/_journal.json`, `api/src/db/schema.ts`, `api/src/db/quoteRepo.ts`,
  `api/src/db/postgresQuoteRepo.ts`
- Test: `api/src/db/quoteRepo.test.ts`

**Interfaces:**
- Produces: `QuoteRevision { revision, totalCents, currency, rateCardVersion, status, updatedBy,
  createdAt, request, result }` and `QuoteRepo.listRevisions(quoteId): Promise<QuoteRevision[]>`
  (newest first).

- [ ] **Step 1: Write the failing test**

```ts
describe('quote revision history (spec 2026-08-05)', () => {
  it('snapshots the PREVIOUS content, leaving the live row current', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample({ totalCents: 10900 }));
    await repo.update(q.id, sample({ totalCents: 9900 }));

    const revs = await repo.listRevisions(q.id);
    expect(revs).toHaveLength(1);
    expect(revs[0].revision).toBe(q.revision);   // the superseded revision
    expect(revs[0].totalCents).toBe(10900);      // …holding the OLD money
    expect((await repo.get(q.id))!.totalCents).toBe(9900);
  });

  it('records nothing for a save that changes nothing, but still bumps revision', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    const same = sample();
    const after = await repo.update(q.id, same);
    expect(await repo.listRevisions(q.id)).toHaveLength(0);
    expect(after!.revision).toBe(q.revision + 1); // the bump is load-bearing — see the constraints
  });

  it('is not fooled by JSON key order', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample({ request: { a: 1, b: 2 } }));
    await repo.update(q.id, sample({ request: { b: 2, a: 1 } }));
    expect(await repo.listRevisions(q.id)).toHaveLength(0);
  });

  // result_json re-prices on every save, so comparing it would record phantom history.
  it('is not fooled by a re-priced result', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample({ result: { totalCents: 1 } }));
    await repo.update(q.id, sample({ result: { totalCents: 2 } }));
    expect(await repo.listRevisions(q.id)).toHaveLength(0);
  });

  it('attributes an unedited first version to its creator', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample({ createdBy: 'maker@x.com' }));
    await repo.update(q.id, sample({ totalCents: 1 }));
    expect((await repo.listRevisions(q.id))[0].updatedBy).toBe('maker@x.com');
  });

  it('returns newest first', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample({ totalCents: 100 }));
    await repo.update(q.id, sample({ totalCents: 200 }));
    await repo.update(q.id, sample({ totalCents: 300 }));
    expect((await repo.listRevisions(q.id)).map((r) => r.totalCents)).toEqual([200, 100]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && npx vitest run src/db/quoteRepo.test.ts -t "revision history"`
Expected: FAIL — `listRevisions is not a function`.

- [ ] **Step 3: Write the migration**

`api/drizzle/0040_quote_revisions.sql`:

```sql
-- Quote version history (spec 2026-08-05 §4). One row per SUPERSEDED state: update() copies the
-- current row here before overwriting it, so history holds what a quote used to be and `quotes`
-- always holds what it is. No duplication of the live state.
--
-- Rows appear only when content actually changed, so revision numbers have gaps — a gap means the
-- revision counter moved (it bumps unconditionally, which is what retires pay links) while the
-- content did not.
CREATE TABLE "quote_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "quote_id" uuid NOT NULL REFERENCES "quotes"("id"),
  "revision" integer NOT NULL,
  "request_json" jsonb,
  "result_json" jsonb,
  "total_cents" integer NOT NULL,
  "currency" text NOT NULL,
  "rate_card_version" text,
  "status" text,
  "updated_by" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_revisions_quote_revision_unique" UNIQUE ("quote_id", "revision")
);
CREATE INDEX "idx_quote_revisions_quote" ON "quote_revisions" ("quote_id", "revision" DESC);
```

- [ ] **Step 4: Register it in the journal**

Append to `entries` in `api/drizzle/meta/_journal.json`, copying the previous entry's shape:

```json
{ "idx": 40, "version": "7", "when": 1786430400000, "tag": "0040_quote_revisions", "breakpoints": true }
```

- [ ] **Step 5: Add the Drizzle table**

In `api/src/db/schema.ts`, after the `quotes` table:

```ts
// Quote version history (spec 2026-08-05). One row per superseded state — see migration 0040.
export const quoteRevisions = pgTable('quote_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id),
  revision: integer('revision').notNull(),
  requestJson: jsonb('request_json'),
  resultJson: jsonb('result_json'),
  totalCents: integer('total_cents').notNull(),
  currency: text('currency').notNull(),
  rateCardVersion: text('rate_card_version'),
  status: text('status'),
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique('quote_revisions_quote_revision_unique').on(t.quoteId, t.revision),
  index('idx_quote_revisions_quote').on(t.quoteId, t.revision),
]);
```

- [ ] **Step 6: The shared no-op rule and the type**

In `api/src/db/quoteRepo.ts`:

```ts
export interface QuoteRevision {
  revision: number;
  totalCents: number;
  currency: string;
  rateCardVersion: string | null;
  status: string | null;
  updatedBy: string | null;
  createdAt: Date;
  // Raw content, for the route's diff. NEVER echoed to the wire — it carries margin.
  request: unknown;
  result: unknown;
}

// Stable across key order, so re-serialising identical content can't fake a change. Compares
// REQUEST only: result re-prices on every save, and a rate-card move must not record history.
export function sameQuoteContent(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)))
      : val,
  );
}
```

Add `listRevisions(quoteId: string): Promise<QuoteRevision[]>` to the `QuoteRepo` interface.

In `InMemoryQuoteRepo`: hold `private revisions = new Map<string, QuoteRevision[]>()`; in
`update()`, **before** mutating the row, push a snapshot when
`!sameQuoteContent(row.request, q.request)`; `listRevisions` returns a newest-first copy.
`updatedBy` on the snapshot is `row.updatedBy ?? row.createdBy`.

- [ ] **Step 7: The transactional snapshot in Postgres**

In `postgresQuoteRepo.update()`, wrap the existing update in a transaction that reads first:

```ts
  async update(id: string, q: NewQuote): Promise<SavedQuote | null> {
    return this.db.transaction(async (tx) => {
      // FOR UPDATE so two concurrent saves can't both snapshot the same revision (the unique
      // constraint would make the loser fail, taking a legitimate content write down with it).
      const [before] = await tx.select().from(quotes)
        .where(and(eq(quotes.id, id), isNull(quotes.deletedAt))).for('update');
      if (!before) return null;

      // Snapshot the state being SUPERSEDED — and only when the content really moved.
      if (!sameQuoteContent(before.requestJson, q.request)) {
        await tx.insert(quoteRevisions).values({
          quoteId: id,
          revision: before.revision,
          requestJson: before.requestJson as object | null,
          resultJson: before.resultJson as object | null,
          totalCents: before.totalCents,
          currency: before.currency,
          rateCardVersion: before.rateCardVersion,
          status: before.status,
          updatedBy: before.updatedBy ?? before.createdBy,
        });
      }

      const [row] = await tx.update(quotes).set({ /* …the existing .set() block, unchanged… */ })
        .where(and(eq(quotes.id, id), isNull(quotes.deletedAt))).returning();
      return row ? quoteRowToSaved(row) : null;
    });
  }
```

Add `listRevisions` selecting from `quoteRevisions` ordered by `revision desc`.

- [ ] **Step 8: Run the tests**

```bash
cd api && npx tsc --noEmit -p tsconfig.json && npx vitest run
```
Expected: clean, and the whole suite green — especially
`internalQuote.test.ts`'s "re-approving with NO edit still retires the link already sent".

- [ ] **Step 9: Commit**

```bash
git add api/drizzle/0040_quote_revisions.sql api/drizzle/meta/_journal.json api/src/db/schema.ts api/src/db/quoteRepo.ts api/src/db/postgresQuoteRepo.ts api/src/db/quoteRepo.test.ts
git commit -m "feat(db): snapshot each superseded quote version"
```

---

### Task 2: The customer web-edit path

`updateWebV2()` is the other place `revision` bumps — the customer editing their own web quote.
Same risk, same fix.

**Files:** `api/src/db/postgresQuoteRepo.ts`, `api/src/db/quoteRepo.ts`; test in
`api/src/db/quoteRepo.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
it('snapshots the customer web-edit path too', async () => {
  const repo = new InMemoryQuoteRepo();
  const q = await repo.save(sample({ channel: 'web', accessTokenDigest: 'dig', totalCents: 100 }));
  await repo.updateWebV2({
    id: q.id, accessTokenDigest: 'dig', expectedRevision: q.revision,
    now: new Date(), quote: sample({ channel: 'web', totalCents: 200 }),
  });
  const revs = await repo.listRevisions(q.id);
  expect(revs).toHaveLength(1);
  expect(revs[0].totalCents).toBe(100);
});
```

If the in-memory `updateWebV2` requires a live rate lock, set `rateLockedUntil` in the fixture to
a future date — mirror whatever the existing `updateWebV2` tests in that file do.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && npx vitest run src/db/quoteRepo.test.ts -t "web-edit path"`
Expected: FAIL — 0 revisions.

- [ ] **Step 3: Implement**

Apply the same snapshot inside `updateWebV2`'s existing guard, in both repos. In Postgres it is
already a single `.update()` with a `where` that enforces the expected revision — wrap it in a
transaction, `select … .for('update')` first, and snapshot only if the row passes the same guards
the `where` clause applies **and** the content changed.

- [ ] **Step 4: Run the tests**

Run: `cd api && npx vitest run src/db/quoteRepo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/db/quoteRepo.ts api/src/db/postgresQuoteRepo.ts api/src/db/quoteRepo.test.ts
git commit -m "feat(db): snapshot the customer web-edit path too"
```

---

### Task 3: Which fields changed

**Files:** Create `api/src/quote/quoteDiff.ts`; test `api/src/quote/quoteDiff.test.ts`.

**Interfaces:**
- Produces: `changedFields(prev: {request: unknown; totalCents: number}, next: {request: unknown; totalCents: number}): string[]`
  returning any of `legs`, `stops`, `distance`, `extras`, `vehicle`, `pax`, `bags`, `dates`, `total`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { changedFields } from './quoteDiff';

const v = (over: Record<string, unknown> = {}, totalCents = 10000) => ({
  totalCents,
  request: {
    engine: {
      product: 'private', vehicle: 'car', pax: 2, bags: 1,
      legs: [{ stops: ['A', 'B'], segmentKms: [100] }],
      extras: [{ code: 'sightseeing', legIndex: 0 }],
      ...over,
    },
    tool: { legs: [{ date: '2026-09-01' }] },
  },
});

describe('changedFields', () => {
  it('reports nothing when nothing moved', () => {
    expect(changedFields(v(), v())).toEqual([]);
  });

  // The Q-DMKNW case: a fee came off, the price moved, the route did not.
  it('names extras and total when a fee is dropped', () => {
    expect(changedFields(v(), v({ extras: [] }, 9000)).sort()).toEqual(['extras', 'total']);
  });

  // The case the owner BELIEVED had happened: a pickup edit that leaves the price alone.
  it('names stops but NOT total when a pickup changes at the same price', () => {
    expect(changedFields(v(), v({ legs: [{ stops: ['A2', 'B'], segmentKms: [100] }] }))).toEqual(['stops']);
  });

  it('names distance when only the km move', () => {
    expect(changedFields(v(), v({ legs: [{ stops: ['A', 'B'], segmentKms: [120] }] }))).toEqual(['distance']);
  });

  it('names legs when a leg is added', () => {
    const next = v({ legs: [{ stops: ['A', 'B'], segmentKms: [100] }, { stops: ['B', 'C'], segmentKms: [50] }] });
    expect(changedFields(v(), next)).toContain('legs');
  });

  it('names vehicle, pax and bags', () => {
    expect(changedFields(v(), v({ vehicle: 'van9' }))).toEqual(['vehicle']);
    expect(changedFields(v(), v({ pax: 5 }))).toEqual(['pax']);
    expect(changedFields(v(), v({ bags: 4 }))).toEqual(['bags']);
  });

  it('names dates from the tool half', () => {
    const next = { ...v(), request: { ...v().request, tool: { legs: [{ date: '2026-09-02' }] } } };
    expect(changedFields(v(), next)).toEqual(['dates']);
  });

  it('never throws on a legacy or empty version', () => {
    expect(() => changedFields({ request: null, totalCents: 0 }, v())).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && npx vitest run src/quote/quoteDiff.test.ts`
Expected: FAIL — cannot resolve `./quoteDiff`.

- [ ] **Step 3: Implement**

```ts
// Which FIELDS differ between two versions of a quote (spec 2026-08-05 §6). Names, never values:
// "extras changed, total changed" is what turns a mystery price move into a sentence, and it
// keeps margin-bearing content off the wire by construction.
//
// Defensive throughout: it runs over rows that may predate any given field, and a history panel
// that 500s on one odd legacy revision is worse than one that says "legs" and moves on.

interface Version { request: unknown; totalCents: number }

const engineOf = (v: Version) => (v.request as { engine?: Record<string, unknown> } | null)?.engine ?? {};
const toolLegsOf = (v: Version) =>
  ((v.request as { tool?: { legs?: { date?: string }[] } } | null)?.tool?.legs ?? []);
const legsOf = (v: Version) => (engineOf(v).legs as unknown[] | undefined) ?? [];
const j = (x: unknown) => JSON.stringify(x ?? null);

export function changedFields(prev: Version, next: Version): string[] {
  const out: string[] = [];
  const a = engineOf(prev), b = engineOf(next);

  if (legsOf(prev).length !== legsOf(next).length) out.push('legs');
  else {
    // Same leg count — say WHAT about them moved, which is the useful half.
    const stops = (v: Version) => legsOf(v).map((l) => (l as { stops?: string[]; from?: string; to?: string }).stops
      ?? [(l as { from?: string }).from, (l as { to?: string }).to]);
    const kms = (v: Version) => legsOf(v).map((l) => (l as { segmentKms?: number[]; distanceKm?: number }).segmentKms
      ?? [(l as { distanceKm?: number }).distanceKm]);
    if (j(stops(prev)) !== j(stops(next))) out.push('stops');
    if (j(kms(prev)) !== j(kms(next))) out.push('distance');
  }

  if (j(a.extras) !== j(b.extras)) out.push('extras');
  if (a.vehicle !== b.vehicle) out.push('vehicle');
  if (a.pax !== b.pax) out.push('pax');
  if (a.bags !== b.bags) out.push('bags');
  if (j(toolLegsOf(prev).map((l) => l?.date ?? null)) !== j(toolLegsOf(next).map((l) => l?.date ?? null))) out.push('dates');
  if (prev.totalCents !== next.totalCents) out.push('total');

  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd api && npx vitest run src/quote/quoteDiff.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/quote/quoteDiff.ts api/src/quote/quoteDiff.test.ts
git commit -m "feat(quote): name the fields that changed between two versions"
```

---

### Task 4: `GET /admin/quote/:id/revisions`

**Files:** `api/src/routes/internalQuote.ts`; test `api/src/routes/internalQuote.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
describe('GET /admin/quote/:id/revisions (spec 2026-08-05)', () => {
  it('returns the timeline newest-first, naming what changed', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await priced(quotes);
    const before = (await quotes.get(id))!;
    // Drop the attributed extra — the Q-DMKNW move.
    await quotes.update(id, {
      ...before,
      totalCents: before.totalCents - 1000,
      request: { ...(before.request as object), engine: { ...ENGINE3, extras: [] } },
    } as never);

    const app = createApp({ quotes });
    const body = await (await authedGet(app, `/admin/quote/${id}/revisions`)).json();

    expect(body.revisions[0].revision).toBe(before.revision);
    expect(body.revisions[0].totalCents).toBe(before.totalCents);
    // The HEAD entry compares the newest snapshot against the CURRENT row — the cross-table read.
    expect(body.revisions[0].changed.sort()).toEqual(['extras', 'total']);
  });

  it('carries no margin, hot-zone or rate-card data', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await priced(quotes);
    await quotes.update(id, { ...(await quotes.get(id))!, totalCents: 1 } as never);
    const app = createApp({ quotes });
    const raw = await (await authedGet(app, `/admin/quote/${id}/revisions`)).text();
    expect(raw).not.toMatch(/margin|hotZone|rateCardJson|requestJson|resultJson/i);
  });

  it('is 404 for an unknown quote', async () => {
    const app = createApp({ quotes: new InMemoryQuoteRepo() });
    expect((await authedGet(app, '/admin/quote/00000000-0000-0000-0000-000000000000/revisions')).status).toBe(404);
  });

  it('is empty, not an error, for a quote never edited', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await priced(quotes);
    const app = createApp({ quotes });
    expect((await (await authedGet(app, `/admin/quote/${id}/revisions`)).json()).revisions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t "revisions"`
Expected: FAIL — 404 on the route.

- [ ] **Step 3: Implement**

Register **above** the `/:id` param route (like `/rate-card` and `/:id/pay-lines`):

```ts
  // The version timeline (spec 2026-08-05 §6). `quote:manage`, the same capability as editing —
  // deliberately NOT founder-only: this response carries no margin, and ops make the edits, so
  // ops need to see what an edit did.
  r.get('/:id/revisions', async (c) => {
    const id = c.req.param('id');
    const quote = await deps.quotes.get(id);
    if (!quote) return c.json({ error: 'not_found' }, 404);
    const history = await deps.quotes.listRevisions(id); // newest first

    // The newest entry's "what changed" is the newest SNAPSHOT against the CURRENT row: history
    // holds only superseded states, so without this the top (most interesting) entry is blank.
    const successors = [
      { request: quote.request, totalCents: quote.totalCents },
      ...history.map((h) => ({ request: h.request, totalCents: h.totalCents })),
    ];

    return c.json({
      revisions: history.map((h, i) => ({
        revision: h.revision,
        totalCents: h.totalCents,
        currency: h.currency,
        status: h.status,
        updatedBy: h.updatedBy,
        createdAt: h.createdAt,
        // Hand-picked projection: request/result never reach the wire — they carry margin.
        changed: changedFields({ request: h.request, totalCents: h.totalCents }, successors[i]),
      })),
    });
  });
```

Import `changedFields` from `../quote/quoteDiff`.

- [ ] **Step 4: Run the tests**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts
git commit -m "feat(ops): serve a quote's version timeline"
```

---

### Task 5: The history panel

**Files:** `api/src/routes/ops-ui.html`; test `web-tests/unit/ops-quote-history.test.js` (new).

- [ ] **Step 1: Write the failing test**

Use the house `loadFn` pattern (see `web-tests/unit/ops-price-drift.test.js`):

```js
const historyRowsHtml = loadFn('historyRowsHtml(revisions)');

describe('quote history panel', () => {
  it('renders one row per revision, newest first', () => {
    const html = historyRowsHtml([
      { revision: 3, totalCents: 9900, updatedBy: 'devan@x.com', createdAt: '2026-08-04T10:00:00Z', changed: ['extras', 'total'] },
      { revision: 2, totalCents: 10900, updatedBy: 'roshen@x.com', createdAt: '2026-08-03T10:00:00Z', changed: ['stops'] },
    ]);
    expect(html).toContain('$99.00');
    expect(html).toContain('$109.00');
    expect(html).toContain('devan');
    expect(html).toContain('extras');
  });

  it('says so plainly when there is no history yet', () => {
    expect(historyRowsHtml([])).toContain('No edits recorded');
  });

  it('escapes the author', () => {
    expect(historyRowsHtml([{ revision: 1, totalCents: 1, updatedBy: '<script>x</script>', createdAt: '2026-08-01T00:00:00Z', changed: [] }]))
      .not.toContain('<script>');
  });

  it('survives a null author', () => {
    expect(() => historyRowsHtml([{ revision: 1, totalCents: 1, updatedBy: null, createdAt: '2026-08-01T00:00:00Z', changed: [] }])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web-tests && npx vitest run unit/ops-quote-history.test.js`
Expected: FAIL — `historyRowsHtml` not found.

- [ ] **Step 3: Implement**

Add `historyRowsHtml(revisions)` to `ops-ui.html` — pure, no DOM, no module state, so the test can
extract it. One row per revision: total, relative time, author (local-part only), and a chip per
changed field. Empty input renders "No edits recorded yet."

Then wire the panel: a collapsed "History" disclosure in the builder that fetches
`/admin/quote/:id/revisions` on first open, caches per `state.savedId`, and re-fetches after a
successful save. Follow `openPayPartPicker()` for the fetch/error/toast shape.

- [ ] **Step 4: Run the tests**

```bash
cd web-tests && npx vitest run unit/
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/ops-ui.html web-tests/unit/ops-quote-history.test.js
git commit -m "feat(ops-ui): a version history panel on the quote builder"
```

---

## Verification before finishing

```bash
cd api && npx tsc --noEmit -p tsconfig.json && npx vitest run
```

```bash
cd web-tests && npm run test:all
```

Then boot against `DATABASE_URL_TEST` and confirm migration `0040` applies on a real database, and
that saving a quote twice produces exactly one revision row while a no-op save produces none.

Known-good baseline: two `ops-ui.spec.js` failures (logout, shareable quote URL) reproduce on
unmodified `main`; `ops-addleg`/`ops-trip-calendar` are parallel-load flakes that pass serially.

## Rollout

Additive table, additive endpoint, additive UI. Existing quotes simply have no history until their
next save. `main` → staging automatically; migrations apply on boot fail-closed, so merging `0040`
is its release. Prod follows via the usual promote PR. **No backfill** — inventing history for
existing quotes would be fabricating an audit trail.
