# Quote Lifecycle (v1, ops channel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every price the internal quoting tool generates in Postgres and give each quote a manual lifecycle (draft → sent → won/lost/expired), so we can track conversion and answer "are we too expensive?".

**Architecture:** A new `quotes` table stores the engine's `QuoteRequest`/`QuoteResult` verbatim as JSONB plus flat analytics columns. A `QuoteRepo` (InMemory + Postgres, following the existing repo trio) is injected through `AppDeps`. The internal quoting tool's route group gains `/save`, `/list`, `GET /:id`, `PATCH /:id`, all gated by `x-admin-key` (enforced only when a key is configured, so dev/preview keeps working). The tool HTML gains a Save button and a Recent-quotes panel.

**Tech Stack:** Node 20 · TypeScript (strict) · Hono · Zod · Drizzle + Postgres (Supabase) · Vitest · Playwright. Money = integer minor units (USD cents) + ISO currency.

## Global Constraints

- Backend lives in `api/` only. NEVER edit the frozen front-end (root `*.html`, `site.css`, booking/plan/etc. `*.js`). The tool HTML `api/src/routes/quote-tool.html` is backend and editable.
- TDD: write the test, run it RED, implement to GREEN, commit. Paste red→green evidence in the PR.
- Money is integer minor units + ISO currency. IDs are uuid.
- `cd api && npm run check` (typecheck + lint + test) must pass before a PR.
- Rate card is locked: `RATE_CARD.version === '2026-06-28'`, `RATE_CARD.currency === 'USD'`. Use these constants — never hardcode.
- Follow the existing repo pattern exactly: interface + `InMemory*` (dev/tests) + `Postgres*` (prod), wired via `AppDeps`.
- Engine is server-authoritative: never trust a client-supplied total — always re-price.

---

### Task 1: QuoteRepo interface + InMemoryQuoteRepo

**Files:**
- Create: `api/src/db/quoteRepo.ts`
- Test: `api/src/db/quoteRepo.test.ts`

**Interfaces:**
- Consumes: nothing (leaf).
- Produces:
  - `type QuoteStatus = 'draft' | 'sent' | 'won' | 'lost' | 'expired'`
  - `const QUOTE_STATUSES: readonly QuoteStatus[]`
  - `interface NewQuote { channel?: 'ops'; product: string; vehicle?: string | null; customerName?: string | null; customerContact?: string | null; totalCents: number; currency: string; rateCardVersion: string; marginCents?: number | null; request: unknown; result: unknown; notes?: string | null; }`
  - `interface SavedQuote { id: string; reference: string; channel: string; status: QuoteStatus; lostReason: string | null; product: string; vehicle: string | null; customerName: string | null; customerContact: string | null; totalCents: number; currency: string; rateCardVersion: string; marginCents: number | null; request: unknown; result: unknown; convertedBookingId: string | null; notes: string | null; createdAt: Date; updatedAt: Date; sentAt: Date | null; decidedAt: Date | null; }`
  - `interface QuoteSummary { id: string; reference: string; status: QuoteStatus; product: string; vehicle: string | null; customerName: string | null; customerContact: string | null; totalCents: number; currency: string; createdAt: Date; }`
  - `interface QuoteListFilter { status?: QuoteStatus; product?: string; from?: string; to?: string }`
  - `interface QuotePatch { status?: QuoteStatus; lostReason?: string | null; notes?: string | null }`
  - `interface QuoteRepo { save(q: NewQuote): Promise<SavedQuote>; get(id: string): Promise<SavedQuote | null>; list(filter?: QuoteListFilter): Promise<QuoteSummary[]>; patch(id: string, patch: QuotePatch): Promise<SavedQuote | null>; }`
  - `class InMemoryQuoteRepo implements QuoteRepo`

- [ ] **Step 1: Write the failing test**

Create `api/src/db/quoteRepo.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryQuoteRepo, type NewQuote } from './quoteRepo';

const sample = (over: Partial<NewQuote> = {}): NewQuote => ({
  product: 'private',
  vehicle: 'car',
  customerName: 'Maya',
  customerContact: '+34600',
  totalCents: 4048,
  currency: 'USD',
  rateCardVersion: '2026-06-28',
  marginCents: 900,
  request: { product: 'private', legs: [{ from: 'A', to: 'B', distanceKm: 80 }] },
  result: { totalCents: 4048 },
  ...over,
});

describe('InMemoryQuoteRepo', () => {
  it('save assigns id, a Q- reference, draft status, and timestamps', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    expect(q.id).toMatch(/[0-9a-f-]{36}/);
    expect(q.reference).toMatch(/^Q-[0-9A-Z]{4}$/);
    expect(q.status).toBe('draft');
    expect(q.channel).toBe('ops');
    expect(q.totalCents).toBe(4048);
    expect(q.request).toEqual(sample().request);
    expect(q.createdAt).toBeInstanceOf(Date);
    expect(q.sentAt).toBeNull();
    expect(q.decidedAt).toBeNull();
    expect(q.convertedBookingId).toBeNull();
  });

  it('get returns a saved quote and null for unknown ids', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    expect((await repo.get(q.id))?.reference).toBe(q.reference);
    expect(await repo.get('nope')).toBeNull();
  });

  it('list returns newest first and filters by status and product', async () => {
    const repo = new InMemoryQuoteRepo();
    const a = await repo.save(sample({ product: 'private' }));
    const b = await repo.save(sample({ product: 'chauffeur' }));
    await repo.patch(b.id, { status: 'won' });
    const all = await repo.list();
    expect(all.map((r) => r.id)).toEqual([b.id, a.id]); // newest first
    expect((await repo.list({ product: 'chauffeur' })).map((r) => r.id)).toEqual([b.id]);
    expect((await repo.list({ status: 'won' })).map((r) => r.id)).toEqual([b.id]);
    expect((await repo.list({ status: 'draft' })).map((r) => r.id)).toEqual([a.id]);
  });

  it('patch updates status, stamps sent_at then decided_at, and records lost_reason', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(sample());
    const sent = await repo.patch(q.id, { status: 'sent' });
    expect(sent?.status).toBe('sent');
    expect(sent?.sentAt).toBeInstanceOf(Date);
    expect(sent?.decidedAt).toBeNull();
    const lost = await repo.patch(q.id, { status: 'lost', lostReason: 'too expensive' });
    expect(lost?.status).toBe('lost');
    expect(lost?.sentAt).toBeInstanceOf(Date); // preserved
    expect(lost?.decidedAt).toBeInstanceOf(Date);
    expect(lost?.lostReason).toBe('too expensive');
  });

  it('patch returns null for an unknown id', async () => {
    expect(await new InMemoryQuoteRepo().patch('nope', { status: 'won' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/db/quoteRepo.test.ts`
Expected: FAIL — `Cannot find module './quoteRepo'`.

- [ ] **Step 3: Write minimal implementation**

Create `api/src/db/quoteRepo.ts`:

```ts
import { randomUUID } from 'node:crypto';

export type QuoteStatus = 'draft' | 'sent' | 'won' | 'lost' | 'expired';
export const QUOTE_STATUSES: readonly QuoteStatus[] = ['draft', 'sent', 'won', 'lost', 'expired'];
const DECIDED: readonly QuoteStatus[] = ['won', 'lost', 'expired'];

export interface NewQuote {
  channel?: 'ops';
  product: string;
  vehicle?: string | null;
  customerName?: string | null;
  customerContact?: string | null;
  totalCents: number;
  currency: string;
  rateCardVersion: string;
  marginCents?: number | null;
  request: unknown;
  result: unknown;
  notes?: string | null;
}

export interface SavedQuote {
  id: string;
  reference: string;
  channel: string;
  status: QuoteStatus;
  lostReason: string | null;
  product: string;
  vehicle: string | null;
  customerName: string | null;
  customerContact: string | null;
  totalCents: number;
  currency: string;
  rateCardVersion: string;
  marginCents: number | null;
  request: unknown;
  result: unknown;
  convertedBookingId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
  decidedAt: Date | null;
}

export interface QuoteSummary {
  id: string;
  reference: string;
  status: QuoteStatus;
  product: string;
  vehicle: string | null;
  customerName: string | null;
  customerContact: string | null;
  totalCents: number;
  currency: string;
  createdAt: Date;
}

export interface QuoteListFilter {
  status?: QuoteStatus;
  product?: string;
  from?: string;
  to?: string;
}

export interface QuotePatch {
  status?: QuoteStatus;
  lostReason?: string | null;
  notes?: string | null;
}

export interface QuoteRepo {
  save(q: NewQuote): Promise<SavedQuote>;
  get(id: string): Promise<SavedQuote | null>;
  list(filter?: QuoteListFilter): Promise<QuoteSummary[]>;
  patch(id: string, patch: QuotePatch): Promise<SavedQuote | null>;
}

// A short, human-referenceable code (e.g. "Q-7F3K") for pasting into WhatsApp.
export function genReference(): string {
  return 'Q-' + randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
}

function toSummary(q: SavedQuote): QuoteSummary {
  return {
    id: q.id,
    reference: q.reference,
    status: q.status,
    product: q.product,
    vehicle: q.vehicle,
    customerName: q.customerName,
    customerContact: q.customerContact,
    totalCents: q.totalCents,
    currency: q.currency,
    createdAt: q.createdAt,
  };
}

export class InMemoryQuoteRepo implements QuoteRepo {
  private readonly rows = new Map<string, SavedQuote>();

  async save(q: NewQuote): Promise<SavedQuote> {
    const now = new Date();
    const row: SavedQuote = {
      id: randomUUID(),
      reference: genReference(),
      channel: q.channel ?? 'ops',
      status: 'draft',
      lostReason: null,
      product: q.product,
      vehicle: q.vehicle ?? null,
      customerName: q.customerName ?? null,
      customerContact: q.customerContact ?? null,
      totalCents: q.totalCents,
      currency: q.currency,
      rateCardVersion: q.rateCardVersion,
      marginCents: q.marginCents ?? null,
      request: q.request,
      result: q.result,
      convertedBookingId: null,
      notes: q.notes ?? null,
      createdAt: now,
      updatedAt: now,
      sentAt: null,
      decidedAt: null,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async get(id: string): Promise<SavedQuote | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async list(filter: QuoteListFilter = {}): Promise<QuoteSummary[]> {
    let rows = [...this.rows.values()];
    if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter.product) rows = rows.filter((r) => r.product === filter.product);
    if (filter.from) rows = rows.filter((r) => r.createdAt >= new Date(filter.from as string));
    if (filter.to) rows = rows.filter((r) => r.createdAt <= new Date(filter.to as string));
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return rows.map(toSummary);
  }

  async patch(id: string, patch: QuotePatch): Promise<SavedQuote | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const now = new Date();
    if (patch.status) {
      row.status = patch.status;
      if (patch.status === 'sent' && !row.sentAt) row.sentAt = now;
      if (DECIDED.includes(patch.status) && !row.decidedAt) row.decidedAt = now;
    }
    if (patch.lostReason !== undefined) row.lostReason = patch.lostReason;
    if (patch.notes !== undefined) row.notes = patch.notes;
    row.updatedAt = now;
    return { ...row };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/db/quoteRepo.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add api/src/db/quoteRepo.ts api/src/db/quoteRepo.test.ts
git commit -m "feat(quotes): QuoteRepo interface + InMemoryQuoteRepo"
```

---

### Task 2: Wire QuoteRepo through AppDeps

**Files:**
- Modify: `api/src/app.ts`
- Modify: `api/src/routes/internalQuote.ts` (add `quotes` to deps; unused for now)

**Interfaces:**
- Consumes: `QuoteRepo`, `InMemoryQuoteRepo` from Task 1.
- Produces: `createApp({ quotes })` option; `internalQuoteRoutes({ maps, googleKey, quotes })` accepts a repo.

- [ ] **Step 1: Write the failing test**

Add to `api/src/routes/internalQuote.test.ts` (inside the first `describe`):

```ts
  it('accepts an injected QuoteRepo without breaking existing routes', async () => {
    const { InMemoryQuoteRepo } = await import('../db/quoteRepo');
    const app = createApp({ quotes: new InMemoryQuoteRepo() });
    const res = await app.request('/admin/quote/places?q=kand');
    expect((await res.json()).places).toEqual(['Kandy']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t "injected QuoteRepo"`
Expected: FAIL — `Object literal may only specify known properties` / typecheck error on `quotes`.

- [ ] **Step 3: Write minimal implementation**

In `api/src/app.ts`:
1. Add import: `import { InMemoryQuoteRepo, type QuoteRepo } from './db/quoteRepo';`
2. Add to `AppDeps`: `quotes?: QuoteRepo;`
3. In `createApp`, add: `const quotes = deps.quotes ?? new InMemoryQuoteRepo();`
4. Update the tool route wiring:
```ts
  app.route('/admin/quote', internalQuoteRoutes({ maps, googleKey: config.GOOGLE_MAPS_API_KEY, quotes })); // internal quoting tool
```

In `api/src/routes/internalQuote.ts`, change the exported signature:
```ts
import type { QuoteRepo } from '../db/quoteRepo';
// ...
export function internalQuoteRoutes(deps: { maps: MapsAdapter; googleKey?: string; quotes: QuoteRepo }) {
```
(The `deps.quotes` field is unused until Task 5 — that is fine; it is referenced by later tasks, not dead.)

Also update the two-arg call sites in `internalQuote.test.ts`'s `appWithKey()` helper to pass a repo:
```ts
  const appWithKey = () => {
    const a = new Hono();
    a.route('/admin/quote', internalQuoteRoutes({ maps: new FakeMapsAdapter(), googleKey: 'test-key', quotes: new InMemoryQuoteRepo() }));
    return a;
  };
```
Add the import at the top of the test file: `import { InMemoryQuoteRepo } from '../db/quoteRepo';`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: PASS (all existing + the new test).

- [ ] **Step 5: Commit**

```bash
git add api/src/app.ts api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts
git commit -m "feat(quotes): inject QuoteRepo through AppDeps into the tool routes"
```

---

### Task 3: quotes table, migration 0009, PostgresQuoteRepo

**Files:**
- Modify: `api/src/db/schema.ts`
- Create: `api/drizzle/0009_*.sql` + `api/drizzle/meta/*` (generated by drizzle-kit)
- Create: `api/src/db/postgresQuoteRepo.ts`
- Modify: `api/src/db/postgres.test.ts`
- Modify: `api/src/server.ts`

**Interfaces:**
- Consumes: `QuoteRepo`, `NewQuote`, `SavedQuote`, `QuoteSummary`, `QuoteListFilter`, `QuotePatch`, `genReference`, `QUOTE_STATUSES` from Task 1; `Db` from `./client`.
- Produces: `quotes` Drizzle table; `class PostgresQuoteRepo implements QuoteRepo`.

- [ ] **Step 1: Add the table to the schema**

In `api/src/db/schema.ts`, add `jsonb` to the pg-core import:
```ts
import { pgTable, uuid, text, integer, boolean, timestamp, unique, jsonb } from 'drizzle-orm/pg-core';
```
Append at the end of the file:
```ts
// M11 quote lifecycle — every price the internal quoting tool hands out. request_json /
// result_json store the engine I/O verbatim (replayable; freezes the quoted price even
// if the rate card changes). converted_booking_id is a nullable bridge, populated later.
export const quotes = pgTable('quotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  reference: text('reference').notNull().unique(),
  channel: text('channel').notNull().default('ops'),
  status: text('status').notNull().default('draft'),
  lostReason: text('lost_reason'),
  product: text('product').notNull(),
  vehicle: text('vehicle'),
  customerName: text('customer_name'),
  customerContact: text('customer_contact'),
  totalCents: integer('total_cents').notNull(),
  currency: text('currency').notNull(),
  rateCardVersion: text('rate_card_version').notNull(),
  marginCents: integer('margin_cents'),
  requestJson: jsonb('request_json').notNull(),
  resultJson: jsonb('result_json').notNull(),
  convertedBookingId: uuid('converted_booking_id').references(() => bookings.id),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
});
```

- [ ] **Step 2: Generate the migration**

Run: `cd api && npm run db:generate`
Expected: creates `api/drizzle/0009_<name>.sql` containing `CREATE TABLE "quotes"` and updates `api/drizzle/meta/_journal.json` with an `idx: 9` entry. Verify:
```bash
ls api/drizzle/0009_*.sql && grep -c 'CREATE TABLE "quotes"' api/drizzle/0009_*.sql
```
Expected: the file exists and the grep prints `1`. (drizzle-kit generate diffs the schema snapshot offline — no DB connection required.)

- [ ] **Step 3: Write the failing Postgres test**

In `api/src/db/postgres.test.ts`:
1. Add import: `import { PostgresQuoteRepo } from './postgresQuoteRepo';`
2. Declare in the describe: `let quotes: PostgresQuoteRepo;`
3. In `beforeAll`, after the other repos: `quotes = new PostgresQuoteRepo(conn.db);`
4. Add a test:
```ts
  it('persists a quote with JSONB request/result and patches its status', async () => {
    const saved = await quotes.save({
      product: 'private',
      vehicle: 'car',
      customerName: 'Maya',
      customerContact: '+34600',
      totalCents: 4048,
      currency: 'USD',
      rateCardVersion: '2026-06-28',
      marginCents: 900,
      request: { product: 'private', legs: [{ from: 'A', to: 'B', distanceKm: 80 }] },
      result: { totalCents: 4048, lineItems: [{ label: 'A → B', amountCents: 4048 }] },
      notes: 'via WhatsApp',
    });
    expect(saved.reference).toMatch(/^Q-/);
    const got = await quotes.get(saved.id);
    expect(got?.totalCents).toBe(4048);
    expect((got?.request as { legs: unknown[] }).legs).toHaveLength(1);
    expect((got?.result as { lineItems: unknown[] }).lineItems).toHaveLength(1);

    const listed = await quotes.list({ product: 'private' });
    expect(listed.some((r) => r.id === saved.id)).toBe(true);

    const won = await quotes.patch(saved.id, { status: 'won' });
    expect(won?.status).toBe('won');
    expect(won?.decidedAt).toBeInstanceOf(Date);
    expect(await quotes.patch('00000000-0000-0000-0000-000000000000', { status: 'won' })).toBeNull();
  });
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd api && npx vitest run src/db/postgres.test.ts`
Expected: FAIL to compile — `Cannot find module './postgresQuoteRepo'`. (The integration body is skipped without `DATABASE_URL_TEST`, but the import must resolve, so a missing file fails the run.)

- [ ] **Step 5: Write the PostgresQuoteRepo**

Create `api/src/db/postgresQuoteRepo.ts`:

```ts
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { Db } from './client';
import { quotes } from './schema';
import { genReference } from './quoteRepo';
import type {
  QuoteRepo,
  NewQuote,
  SavedQuote,
  QuoteSummary,
  QuoteListFilter,
  QuotePatch,
  QuoteStatus,
} from './quoteRepo';

type Row = typeof quotes.$inferSelect;
const DECIDED: readonly QuoteStatus[] = ['won', 'lost', 'expired'];

function toSaved(r: Row): SavedQuote {
  return {
    id: r.id,
    reference: r.reference,
    channel: r.channel,
    status: r.status as QuoteStatus,
    lostReason: r.lostReason,
    product: r.product,
    vehicle: r.vehicle,
    customerName: r.customerName,
    customerContact: r.customerContact,
    totalCents: r.totalCents,
    currency: r.currency,
    rateCardVersion: r.rateCardVersion,
    marginCents: r.marginCents,
    request: r.requestJson,
    result: r.resultJson,
    convertedBookingId: r.convertedBookingId,
    notes: r.notes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    sentAt: r.sentAt,
    decidedAt: r.decidedAt,
  };
}

export class PostgresQuoteRepo implements QuoteRepo {
  constructor(private readonly db: Db) {}

  async save(q: NewQuote): Promise<SavedQuote> {
    const [row] = await this.db
      .insert(quotes)
      .values({
        reference: genReference(),
        channel: q.channel ?? 'ops',
        product: q.product,
        vehicle: q.vehicle ?? null,
        customerName: q.customerName ?? null,
        customerContact: q.customerContact ?? null,
        totalCents: q.totalCents,
        currency: q.currency,
        rateCardVersion: q.rateCardVersion,
        marginCents: q.marginCents ?? null,
        requestJson: q.request,
        resultJson: q.result,
        notes: q.notes ?? null,
      })
      .returning();
    return toSaved(row);
  }

  async get(id: string): Promise<SavedQuote | null> {
    const rows = await this.db.select().from(quotes).where(eq(quotes.id, id));
    return rows[0] ? toSaved(rows[0]) : null;
  }

  async list(filter: QuoteListFilter = {}): Promise<QuoteSummary[]> {
    const conds = [];
    if (filter.status) conds.push(eq(quotes.status, filter.status));
    if (filter.product) conds.push(eq(quotes.product, filter.product));
    if (filter.from) conds.push(gte(quotes.createdAt, new Date(filter.from)));
    if (filter.to) conds.push(lte(quotes.createdAt, new Date(filter.to)));
    const rows = await this.db
      .select()
      .from(quotes)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(quotes.createdAt));
    return rows.map((r) => {
      const s = toSaved(r);
      return {
        id: s.id,
        reference: s.reference,
        status: s.status,
        product: s.product,
        vehicle: s.vehicle,
        customerName: s.customerName,
        customerContact: s.customerContact,
        totalCents: s.totalCents,
        currency: s.currency,
        createdAt: s.createdAt,
      };
    });
  }

  async patch(id: string, patch: QuotePatch): Promise<SavedQuote | null> {
    const current = await this.get(id);
    if (!current) return null;
    const now = new Date();
    const set: Partial<Row> = { updatedAt: now };
    if (patch.status) {
      set.status = patch.status;
      if (patch.status === 'sent' && !current.sentAt) set.sentAt = now;
      if (DECIDED.includes(patch.status) && !current.decidedAt) set.decidedAt = now;
    }
    if (patch.lostReason !== undefined) set.lostReason = patch.lostReason;
    if (patch.notes !== undefined) set.notes = patch.notes;
    const [row] = await this.db.update(quotes).set(set).where(eq(quotes.id, id)).returning();
    return toSaved(row);
  }
}
```

- [ ] **Step 6: Run the test to verify it passes (compiles + skips)**

Run: `cd api && npx vitest run src/db/postgres.test.ts`
Expected: PASS/skipped — the module now resolves; the integration test is skipped without `DATABASE_URL_TEST`. Also run `cd api && npm run typecheck` → clean.

- [ ] **Step 7: Wire the Postgres repo in the server**

In `api/src/server.ts`:
1. Add import: `import { PostgresQuoteRepo } from './db/postgresQuoteRepo';`
2. In the `createApp({ ... })` call, add: `quotes: new PostgresQuoteRepo(db),`

- [ ] **Step 8: Commit**

```bash
git add api/src/db/schema.ts api/drizzle/ api/src/db/postgresQuoteRepo.ts api/src/db/postgres.test.ts api/src/server.ts
git commit -m "feat(quotes): quotes table (migration 0009) + PostgresQuoteRepo + server wiring"
```

---

### Task 4: Extract the shared pricing helper (green refactor of /estimate)

**Files:**
- Modify: `api/src/routes/internalQuote.ts`

**Interfaces:**
- Consumes: existing `toEngineRequest`, `quote`, `LEG_TYPES`, `MapsAdapter`, `ToolRequest`.
- Produces: `class PriceError extends Error { status: 400 | 422 }` and `async function resolveAndPrice(body: ToolRequest, maps: MapsAdapter): Promise<{ req: QuoteRequest; result: QuoteResult }>` — used by `/estimate` (this task) and `/save` (Task 5).

This is a behavior-preserving refactor: the existing `/estimate` tests are the safety net.

- [ ] **Step 1: Run the existing tests to confirm the green baseline**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: PASS (baseline before refactor).

- [ ] **Step 2: Extract the helper and rewrite /estimate to use it**

In `api/src/routes/internalQuote.ts`, add near the top (after imports):
```ts
// Thrown by resolveAndPrice so the route can map it to the right HTTP status.
class PriceError extends Error {
  constructor(message: string, readonly status: 400 | 422) {
    super(message);
  }
}

// Shared by /estimate and /save: validate legs, auto-resolve missing distances via the
// maps adapter, then price with the engine. Mutates each driving leg's distanceKm in place.
async function resolveAndPrice(
  body: ToolRequest,
  maps: MapsAdapter,
): Promise<{ req: QuoteRequest; result: QuoteResult }> {
  if (!body || !Array.isArray(body.legs) || body.legs.length === 0) {
    throw new PriceError('add at least one leg', 400);
  }
  const driving = body.legs.filter((l) => LEG_TYPES[l.type || 'transfer']?.drives);
  if (driving.length === 0) {
    throw new PriceError('add at least one travel leg (a stay day alone has no transfer)', 400);
  }
  for (const l of driving) {
    if (!l.distanceKm || Number(l.distanceKm) <= 0) {
      const d = await maps.distance(l.from, l.to);
      if (d) l.distanceKm = d.km;
      else throw new PriceError(`couldn't find the distance for ${l.from || '?'} → ${l.to || '?'} — enter the km manually`, 400);
    }
  }
  try {
    const req = toEngineRequest(body);
    return { req, result: quote(req) };
  } catch (e) {
    throw new PriceError(e instanceof Error ? e.message : 'could not price this trip', 422);
  }
}
```
Then replace the body of the `r.post('/estimate', ...)` handler with:
```ts
  r.post('/estimate', async (c) => {
    const body = (await c.req.json().catch(() => null)) as ToolRequest | null;
    try {
      const { req, result } = await resolveAndPrice(body as ToolRequest, deps.maps);
      const comparison: Record<string, ReturnType<typeof shape> | { error: string }> = {};
      for (const v of ['car', 'van'] as Vehicle[]) {
        try {
          comparison[v] = shape(quote({ ...req, vehicle: v } as QuoteRequest));
        } catch (e) {
          comparison[v] = { error: e instanceof Error ? e.message : 'n/a' };
        }
      }
      return c.json({
        ...shape(result),
        fxUsdToLkr: fxRate,
        comparison,
        drafts: {
          whatsapp: whatsappDraft(body?.name ?? '', body as ToolRequest, result),
          email: emailDraft(body?.name ?? '', body as ToolRequest, result),
          notion: notionDraft(body as ToolRequest, result),
        },
      });
    } catch (e) {
      if (e instanceof PriceError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });
```

- [ ] **Step 3: Run the existing tests to verify no behavior changed**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: PASS (same tests green — the 400 no-legs, 400 stay-day-only, 400 unknown-distance, 422, and success cases all still hold).

- [ ] **Step 4: Typecheck + lint**

Run: `cd api && npm run typecheck && npm run lint`
Expected: clean (no unused-var warnings; `QuoteResult`/`QuoteRequest` are already imported in this file).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/internalQuote.ts
git commit -m "refactor(quotes): extract resolveAndPrice shared by /estimate (+/save next)"
```

---

### Task 5: POST /save — persist a priced quote

**Files:**
- Modify: `api/src/routes/internalQuote.ts`
- Modify: `api/src/routes/internalQuote.test.ts`

**Interfaces:**
- Consumes: `resolveAndPrice`, `PriceError` (Task 4); `deps.quotes` (Task 2); `RATE_CARD`.
- Produces: `POST /admin/quote/save` → `201 { id, reference, status }`.

- [ ] **Step 1: Write the failing test**

Add to `api/src/routes/internalQuote.test.ts` (first describe):
```ts
  it('POST /save persists a priced quote and returns a Q- reference; total matches /estimate', async () => {
    const app = createApp();
    const bodyReq = { name: 'Maya', contact: '+34600', product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [leg({ distanceKm: 80 })] };
    const est = await (await post(app, '/admin/quote/estimate', bodyReq)).json();
    const res = await post(app, '/admin/quote/save', bodyReq);
    expect(res.status).toBe(201);
    const saved = await res.json();
    expect(saved.reference).toMatch(/^Q-[0-9A-Z]{4}$/);
    expect(saved.status).toBe('draft');
    const got = await (await app.request(`/admin/quote/${saved.id}`)).json();
    expect(got.totalCents).toBe(est.total.cents); // saved total == previewed total
    expect(got.customerName).toBe('Maya');
    expect(got.rateCardVersion).toBe('2026-06-28');
  });

  it('POST /save re-prices server-side and ignores any client-supplied total', async () => {
    const app = createApp();
    const res = await post(app, '/admin/quote/save', {
      product: 'private', vehicle: 'car', pax: 1, bags: 0, total: 999999, totalCents: 999999, legs: [leg({ distanceKm: 80 })],
    });
    const saved = await res.json();
    const got = await (await app.request(`/admin/quote/${saved.id}`)).json();
    expect(got.totalCents).toBe(4048); // engine price, not the bogus client total
  });

  it('POST /save is 422 for an unpriceable trip (no travel leg)', async () => {
    const res = await post(createApp(), '/admin/quote/save', {
      product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [{ type: 'stay_day', from: 'Kandy', to: '' }],
    });
    expect(res.status).toBe(400); // stay-day-only → no travel leg
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t "/save"`
Expected: FAIL — `/save` returns 404 (route not defined) so `res.status` is 404, and `GET /:id` 404s.

- [ ] **Step 3: Write the implementation**

In `api/src/routes/internalQuote.ts`, add after the `/estimate` route (and before `return r;`):
```ts
  // Persist the currently-priced quote. Re-prices server-side — never trusts a client total.
  r.post('/save', async (c) => {
    const body = (await c.req.json().catch(() => null)) as (ToolRequest & { name?: string; contact?: string; notes?: string }) | null;
    try {
      const { req, result } = await resolveAndPrice(body as ToolRequest, deps.maps);
      const saved = await deps.quotes.save({
        product: req.product,
        vehicle: 'vehicle' in req ? req.vehicle : null,
        customerName: body?.name ?? null,
        customerContact: body?.contact ?? null,
        totalCents: result.totalCents,
        currency: RATE_CARD.currency,
        rateCardVersion: RATE_CARD.version,
        marginCents: result.marginEstimateCents ?? null,
        request: req,
        result,
        notes: body?.notes ?? null,
      });
      return c.json({ id: saved.id, reference: saved.reference, status: saved.status }, 201);
    } catch (e) {
      if (e instanceof PriceError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  // Full quote (incl. request/result JSON) for re-opening in the tool.
  r.get('/:id', async (c) => {
    const q = await deps.quotes.get(c.req.param('id'));
    return q ? c.json(q) : c.json({ error: 'not_found' }, 404);
  });
```
Note: register `/save` and the more specific data routes before `/:id`. `/list` and `PATCH /:id` come in Task 6 (add `/list` before `/:id`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts
git commit -m "feat(quotes): POST /save (server-repriced) + GET /:id"
```

---

### Task 6: GET /list + PATCH /:id — lifecycle transitions

**Files:**
- Modify: `api/src/routes/internalQuote.ts`
- Modify: `api/src/routes/internalQuote.test.ts`

**Interfaces:**
- Consumes: `deps.quotes`, `QUOTE_STATUSES`.
- Produces: `GET /admin/quote/list` → `{ quotes: QuoteSummary[] }`; `PATCH /admin/quote/:id` → updated `SavedQuote` / 404 / 400.

- [ ] **Step 1: Write the failing test**

Add to `api/src/routes/internalQuote.test.ts` (first describe). Helper for PATCH:
```ts
  const patch = (app: App, path: string, body: unknown) =>
    app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('GET /list returns saved quotes newest-first and filters by status/product', async () => {
    const app = createApp();
    const a = await (await post(app, '/admin/quote/save', { product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [leg({ distanceKm: 80 })] })).json();
    const b = await (await post(app, '/admin/quote/save', { product: 'private', vehicle: 'van', pax: 1, bags: 0, legs: [leg({ distanceKm: 80 })] })).json();
    const list = await (await app.request('/admin/quote/list')).json();
    expect(list.quotes[0].id).toBe(b.id); // newest first
    await patch(app, `/admin/quote/${a.id}`, { status: 'won' });
    const won = await (await app.request('/admin/quote/list?status=won')).json();
    expect(won.quotes.map((q: { id: string }) => q.id)).toEqual([a.id]);
  });

  it('PATCH /:id moves status, stamps timestamps, records lost_reason; 404 unknown; 400 bad status', async () => {
    const app = createApp();
    const q = await (await post(app, '/admin/quote/save', { product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [leg({ distanceKm: 80 })] })).json();
    const sent = await (await patch(app, `/admin/quote/${q.id}`, { status: 'sent' })).json();
    expect(sent.status).toBe('sent');
    expect(sent.sentAt).not.toBeNull();
    const lost = await (await patch(app, `/admin/quote/${q.id}`, { status: 'lost', lostReason: 'too expensive' })).json();
    expect(lost.decidedAt).not.toBeNull();
    expect(lost.lostReason).toBe('too expensive');
    expect((await patch(app, '/admin/quote/00000000-0000-0000-0000-000000000000', { status: 'won' })).status).toBe(404);
    expect((await patch(app, `/admin/quote/${q.id}`, { status: 'bogus' })).status).toBe(400);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t "/list"`
Expected: FAIL — `/list` currently resolves to the `GET /:id` handler (id = "list") → 404, and PATCH is undefined.

- [ ] **Step 3: Write the implementation**

In `api/src/routes/internalQuote.ts`:
1. Import the status list: change the rateCard import to add `QUOTE_STATUSES`? No — statuses live in the repo module. Add: `import { QUOTE_STATUSES, type QuoteStatus } from '../db/quoteRepo';`
2. Register `/list` **before** `/:id` (route order matters):
```ts
  r.get('/list', async (c) => {
    const status = c.req.query('status') as QuoteStatus | undefined;
    if (status && !QUOTE_STATUSES.includes(status)) return c.json({ error: 'bad_status' }, 400);
    const quotesList = await deps.quotes.list({
      status,
      product: c.req.query('product') || undefined,
      from: c.req.query('from') || undefined,
      to: c.req.query('to') || undefined,
    });
    return c.json({ quotes: quotesList });
  });
```
Move this ABOVE the `r.get('/:id', ...)` handler added in Task 5.
3. Add PATCH after `GET /:id`:
```ts
  r.patch('/:id', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { status?: string; lostReason?: string | null; notes?: string | null } | null;
    if (!body) return c.json({ error: 'bad_request' }, 400);
    if (body.status && !QUOTE_STATUSES.includes(body.status as QuoteStatus)) return c.json({ error: 'bad_status' }, 400);
    const updated = await deps.quotes.patch(c.req.param('id'), {
      status: body.status as QuoteStatus | undefined,
      lostReason: body.lostReason,
      notes: body.notes,
    });
    return updated ? c.json(updated) : c.json({ error: 'not_found' }, 404);
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts
git commit -m "feat(quotes): GET /list filters + PATCH /:id lifecycle transitions"
```

---

### Task 7: Admin-key auth on the data routes

**Files:**
- Modify: `api/src/routes/internalQuote.ts`
- Modify: `api/src/app.ts`
- Modify: `api/src/routes/internalQuote.test.ts`
- Modify: `docs/superpowers/specs/2026-06-30-quote-lifecycle-design.md` (note enforce-when-configured; add ADMIN_API_KEY to go-live)

**Interfaces:**
- Consumes: `config.ADMIN_API_KEY` (already wired as `adminApiKey` in `createApp`).
- Produces: `internalQuoteRoutes({ maps, googleKey, quotes, adminKey })`; all routes except `GET /` require `x-admin-key` **when `adminKey` is set** (unset ⇒ open, for dev/preview).

- [ ] **Step 1: Write the failing test**

Add a new describe to `api/src/routes/internalQuote.test.ts`:
```ts
describe('quoting tool — admin-key auth', () => {
  const keyed = () => {
    const a = new Hono();
    a.route('/admin/quote', internalQuoteRoutes({ maps: new FakeMapsAdapter(), quotes: new InMemoryQuoteRepo(), adminKey: 'secret' }));
    return a;
  };

  it('serves the HTML shell without a key', async () => {
    const res = await keyed().request('/admin/quote');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('401s a data route without the key and 200s with it', async () => {
    const app = keyed();
    expect((await app.request('/admin/quote/places?q=kand')).status).toBe(401);
    const ok = await app.request('/admin/quote/places?q=kand', { headers: { 'x-admin-key': 'secret' } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).places).toEqual(['Kandy']);
  });

  it('leaves data routes open when no key is configured (dev/preview)', async () => {
    // createApp default ADMIN_API_KEY is '' → open
    expect((await createApp().request('/admin/quote/places?q=kand')).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t "admin-key auth"`
Expected: FAIL — `adminKey` is not a known prop (typecheck) and the 401 assertions fail (routes currently open).

- [ ] **Step 3: Write the implementation**

In `api/src/routes/internalQuote.ts`:
1. Extend the signature:
```ts
export function internalQuoteRoutes(deps: { maps: MapsAdapter; googleKey?: string; quotes: QuoteRepo; adminKey?: string }) {
```
2. Register the open shell FIRST, then the guard, then all data routes. The guard only applies to routes registered after it (Hono runs handlers in registration order):
```ts
  const r = new Hono();

  // Open shell (a browser navigation can't send a header). The JS attaches the key to
  // its fetches; the guard below protects every data/XHR route.
  r.get('/', (c) => c.html(toolHtml()));

  // Enforce the admin key ONLY when one is configured, so dev/preview (no key) still works.
  // Prod MUST set ADMIN_API_KEY — see the go-live checklist.
  r.use('*', async (c, next) => {
    if (deps.adminKey && c.req.header('x-admin-key') !== deps.adminKey) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  });
```
Ensure the existing `r.get('/', ...)` line is removed from its old position (it must be the first route, before the `r.use`). All of `/places`, `/distance`, `/estimate`, `/save`, `/list`, `/:id`, `PATCH /:id` stay registered after the `r.use`.

In `api/src/app.ts`, pass the key:
```ts
  app.route('/admin/quote', internalQuoteRoutes({ maps, googleKey: config.GOOGLE_MAPS_API_KEY, quotes, adminKey: adminApiKey }));
```
(`adminApiKey` is already defined in `createApp`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: PASS (auth describe + all existing keyless tests still 200 via `createApp()`).

- [ ] **Step 5: Note the prod requirement**

Append to the spec's "Open items" section a line: `- Prod MUST set ADMIN_API_KEY (auth enforced only when configured) — added to the go-live checklist.` Then update the go-live memory/doc if present. (Documentation step — no code.)

- [ ] **Step 6: Full gate**

Run: `cd api && npm run check`
Expected: typecheck + lint + all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add api/src/routes/internalQuote.ts api/src/app.ts api/src/routes/internalQuote.test.ts docs/superpowers/specs/2026-06-30-quote-lifecycle-design.md
git commit -m "feat(quotes): admin-key gate on tool data routes (enforced when configured)"
```

---

### Task 8: Tool UI — Save button, Recent-quotes panel, key handling

**Files:**
- Modify: `api/src/routes/quote-tool.html`
- Modify: `web-tests/e2e/quote-tool.spec.js`

**Interfaces:**
- Consumes: `POST /admin/quote/save`, `GET /admin/quote/list`, `PATCH /admin/quote/:id`.
- Produces: a Save control that shows the returned reference; a Recent panel listing quotes with a status control. All fetches attach `x-admin-key` from `localStorage` if present, and on any `401` prompt for the key, store it, and retry.

- [ ] **Step 1: Add key-aware fetch + Save + Recent to the HTML**

In `api/src/routes/quote-tool.html`, wrap the existing fetch calls with a helper. Add this near the top of the `<script>` (before `apiPlaces`/`apiDistance`):
```js
function adminKey(){ return localStorage.getItem('chAdminKey') || ''; }
async function api(path, opts){
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  const k = adminKey(); if(k) headers['x-admin-key'] = k;
  let res = await fetch(path, Object.assign({}, opts, { headers }));
  if(res.status === 401){
    const entered = prompt('Enter the admin key for the quoting tool:');
    if(entered){ localStorage.setItem('chAdminKey', entered); headers['x-admin-key'] = entered;
      res = await fetch(path, Object.assign({}, opts, { headers })); }
  }
  return res;
}
```
Route the existing tool calls (`/admin/quote/places`, `/admin/quote/distance`, `/admin/quote/estimate`) through `api(...)` instead of bare `fetch(...)`.

Add a **Save** button to the Pricing Summary block. After a successful `/estimate` render, show a `Save quote` button with id `saveBtn`; wire it:
```js
async function saveQuote(){
  const payload = collect(); // the same object /estimate receives
  payload.name = ($('name').value || '').trim();
  payload.contact = ($('contact') ? $('contact').value.trim() : '');
  const res = await api('/admin/quote/save', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
  const d = await res.json();
  if(!res.ok){ $('saveMsg').textContent = d.error || 'Save failed'; return; }
  $('saveMsg').innerHTML = 'Saved as <b>'+d.reference+'</b>';
  loadRecent();
}
```
Add a **Recent quotes** panel (a `<div id="recent">`) and:
```js
async function loadRecent(){
  const res = await api('/admin/quote/list');
  if(!res.ok) return;
  const { quotes } = await res.json();
  $('recent').innerHTML = quotes.map(function(q){
    return '<div class="qrow" data-id="'+q.id+'"><span class="qref">'+q.reference+'</span>'
      + '<span>'+(q.customerName||'—')+'</span>'
      + '<span>'+q.product+'</span>'
      + '<span class="qtotal">'+q.totalCents+'</span>'
      + '<select class="qstatus">'
      + ['draft','sent','won','lost','expired'].map(function(s){ return '<option'+(s===q.status?' selected':'')+'>'+s+'</option>'; }).join('')
      + '</select></div>';
  }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('.qrow .qstatus'), function(sel){
    sel.addEventListener('change', function(){
      const id = sel.closest('.qrow').getAttribute('data-id');
      api('/admin/quote/'+id, { method:'PATCH', headers:{'content-type':'application/json'}, body: JSON.stringify({ status: sel.value }) });
    });
  });
}
```
Call `loadRecent()` on page load. Add a `contact` input next to the `name` input in the Customer block (id `contact`, placeholder "WhatsApp / email"). Add a `<div id="saveMsg">` beside the Save button.

- [ ] **Step 2: Add the e2e test (RED)**

In `web-tests/e2e/quote-tool.spec.js`, add:
```js
test('save a quote → reference appears → shows in Recent, and status can change', async ({ page }) => {
  await page.goto(TOOL);
  await page.locator('.leg [data-f="from"]').first().fill('Somewhere Villa');
  await page.locator('.leg [data-f="to"]').first().fill('Airport');
  await page.locator('.leg [data-f="distanceKm"]').first().fill('80');
  await page.fill('#name', 'E2E Save');
  await page.click('#go');
  await expect(page.locator('.total')).toContainText('LKR');
  await page.click('#saveBtn');
  await expect(page.locator('#saveMsg')).toContainText('Q-');
  await expect(page.locator('#recent .qrow', { hasText: 'E2E Save' }).first()).toBeVisible();
  // change its status
  const row = page.locator('#recent .qrow', { hasText: 'E2E Save' }).first();
  await row.locator('.qstatus').selectOption('won');
  await expect(row.locator('.qstatus')).toHaveValue('won');
});
```

- [ ] **Step 3: Run the e2e to verify it fails, then passes**

Run: `cd web-tests && npx playwright test quote-tool.spec.js`
Expected first run (before the HTML is complete): FAIL on `#saveBtn`. After Step 1's HTML is in place: re-run → PASS (all 4 specs).

- [ ] **Step 4: Verify in preview (manual smoke)**

Start the API (`cd api && npm run dev`), open `http://localhost:8787/admin/quote`, price a trip, click Save, confirm a `Q-XXXX` reference and a Recent row; change status and reload to confirm persistence (InMemory resets on restart — use it only as a live smoke; the Postgres path is covered by Task 3's integration test).

- [ ] **Step 5: Full gate + commit**

```bash
cd api && npm run check   # green
git add api/src/routes/quote-tool.html web-tests/e2e/quote-tool.spec.js
git commit -m "feat(quotes): tool UI — Save button, Recent panel, admin-key handling"
```

---

## Self-Review

**Spec coverage:**
- Data model `quotes` (§1) → Task 3. ✅
- Write/read API `/save`, `/list`, `GET/:id`, `PATCH/:id` (§2) → Tasks 5, 6. ✅
- `/estimate` stays stateless; `/save` re-prices server-side (D5, D8) → Tasks 4, 5. ✅
- Repo pattern InMemory + Postgres (§3) → Tasks 1, 3. ✅
- Auth on data routes (§4, D7) → Task 7. ✅
- Tool UI Save + Recent + key prompt (§ Tool UI) → Task 8. ✅
- Testing (repo unit, route integration, postgres round-trip, e2e) → Tasks 1, 3, 5, 6, 7, 8. ✅
- Deferred (web capture, lost-reason enum, converted_booking_id population) → not built (correct). ✅

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `QuoteRepo`/`NewQuote`/`SavedQuote`/`QuoteSummary`/`QuotePatch`/`QuoteStatus`/`QUOTE_STATUSES`/`genReference` defined in Task 1, consumed unchanged in Tasks 2, 3, 5, 6, 7. `resolveAndPrice`/`PriceError` defined in Task 4, consumed in Task 5. `internalQuoteRoutes` signature grows monotonically: `+quotes` (Task 2), `+adminKey` (Task 7). Route registration order (`/list` before `/:id`, shell before guard) called out explicitly.
