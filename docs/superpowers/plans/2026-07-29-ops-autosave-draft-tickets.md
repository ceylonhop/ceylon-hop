# Ops autosave + assign-from-first-click Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An ops agent can assign a brand-new quote the instant they open it, and never has to press Save.

**Architecture:** "+ New quote" creates a real `draft` row up front — a `$0` **shell** marked by `request_json = { shell: true }`. Because the row exists, the assignee picker is live immediately and the existing 2.5s autosave takes over as soon as the quote is priceable. A shell can never be submitted or sent (server-side gate), is visibly marked in the queue, is excluded from analytics, and is soft-deleted by a new cron sweep after 24h untouched.

**Tech Stack:** Node 20 · TypeScript (strict) · Hono · Zod · Vitest · Drizzle + Postgres · Playwright (`web-tests/`)

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-29-ops-autosave-draft-tickets-design.md`. Read it first.
- **No migration.** Do not touch `api/src/db/schema.ts` or add a file to `api/drizzle/`. The shell is a JSON marker precisely so no schema change is needed.
- **No pricing change.** Do not touch `api/src/quote/rateCard.ts` or `api/src/db/departureRepo.ts`.
- **No config change.** Do not touch `api/src/config.ts` or env handling.
- **The shell test is the JSON marker, never the price.** `isUnpricedShell(q) === (q.request?.shell === true)`. Never `totalCents === 0`.
- **Gate:** `cd api && npm run check` must pass before every commit. For tasks touching `api/src/routes/ops-ui.html` or `web-tests/`, also `npm run test:all` from the repo root.
- **Branch:** `ops-autosave-drafts` (already created, worktree at `.claude/worktrees/ops-autosave-drafts`). One commit per task.
- **Exact copy strings** (pinned by tests, do not paraphrase):
  - Queue total slot for a shell: `Not priced yet`
  - Save-state chip for a shell: `Not priced yet`
  - Server error code for the send gate: `unpriced_quote`
  - Soft-delete actor for the sweep: `system:draft-cleanup`
  - Submit blocker label: `A price — this quote has not been priced yet`
- **Window:** `ABANDONED_DRAFT_TTL_MS = 24 * 3600 * 1000`.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `api/src/db/quoteRepo.ts` | Modify | Export `isUnpricedShell()`; add `unpriced` to `QuoteSummary`; set it in `toSummary()` |
| `api/src/db/postgresQuoteRepo.ts` | Modify | Set `unpriced` in `list()`'s row mapping; exclude shells from the two analytics projections |
| `api/src/routes/internalQuote.ts` | Modify | New `POST /admin/quote/draft`; `unpriced_quote` gate on the status PATCH |
| `api/src/services/abandonedDrafts.ts` | Create | `sweepAbandonedDrafts(now, deps)` — pure over `(now, deps)` |
| `api/src/services/abandonedDrafts.test.ts` | Create | Sweep unit tests |
| `api/src/routes/admin.ts` | Modify | Wire the sweep into `POST /admin/jobs/notifications` |
| `api/src/routes/internalQuote.test.ts` | Modify | Draft-route + send-gate tests |
| `api/src/db/quoteRepo.test.ts` | Modify | `isUnpricedShell` + `unpriced` summary tests |
| `api/src/routes/ops-ui.html` | Modify | Shell create on "+ New quote"; assign always live; autosave without `savedId`; chip copy; queue row copy; submit blocker |
| `web-tests/e2e/ops-autosave-drafts.spec.js` | Create | Playwright: assign with no Save; queue marking |

Order matters: Task 1 defines the helper every later task imports. Tasks 2–5 are server-side and independent of each other once Task 1 lands. Tasks 6–7 are the UI. Task 8 is the e2e gate.

---

### Task 1: The shell marker + `unpriced` on the summary

**Files:**
- Modify: `api/src/db/quoteRepo.ts` (add export near `toSummary`, ~line 249; `QuoteSummary` interface ~line 106)
- Modify: `api/src/db/postgresQuoteRepo.ts` (`list()` row mapping, ~line 277-291)
- Test: `api/src/db/quoteRepo.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function isUnpricedShell(q: { request: unknown }): boolean` — the single derivation every other task imports.
  - `QuoteSummary.unpriced: boolean`

- [ ] **Step 1: Write the failing test**

Append to `api/src/db/quoteRepo.test.ts`:

```ts
describe('isUnpricedShell', () => {
  it('is true only for the { shell: true } marker', () => {
    expect(isUnpricedShell({ request: { shell: true } })).toBe(true);
    expect(isUnpricedShell({ request: { tool: {}, engine: {} } })).toBe(false);
    expect(isUnpricedShell({ request: null })).toBe(false);
    expect(isUnpricedShell({ request: undefined })).toBe(false);
    expect(isUnpricedShell({ request: 'shell' })).toBe(false);
  });

  it('does NOT treat a legitimately zero-priced quote as a shell', () => {
    expect(isUnpricedShell({ request: { tool: {}, engine: {} } })).toBe(false);
  });
});

describe('list() summaries', () => {
  it('flags an unpriced shell and leaves a priced quote unflagged', async () => {
    const repo = new InMemoryQuoteRepo();
    await repo.save({
      channel: 'ops', product: 'private', totalCents: 0, currency: 'USD',
      rateCardVersion: 'v', request: { shell: true }, result: { shell: true },
    });
    await repo.save({
      channel: 'ops', product: 'private', totalCents: 4048, currency: 'USD',
      rateCardVersion: 'v', request: { tool: {}, engine: {} }, result: { totalCents: 4048 },
    });

    const rows = await repo.list({ channel: 'ops' });
    expect(rows.find((r) => r.totalCents === 0)!.unpriced).toBe(true);
    expect(rows.find((r) => r.totalCents === 4048)!.unpriced).toBe(false);
  });
});
```

Add `isUnpricedShell` to the existing import from `./quoteRepo` at the top of that test file.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && npx vitest run src/db/quoteRepo.test.ts
```

Expected: FAIL — `isUnpricedShell is not a function` (and a type error on `.unpriced`).

- [ ] **Step 3: Write minimal implementation**

In `api/src/db/quoteRepo.ts`, add to the `QuoteSummary` interface (after `routeText`):

```ts
  // Autosave shells (spec 2026-07-29): true when this row was created by "+ New quote" and has
  // never been priced. The queue renders "Not priced yet" instead of a $0 total, and the send
  // gate refuses to move it out of draft. Derived from the request marker, NEVER from the price —
  // a $0 total is a symptom, the marker is the fact.
  unpriced: boolean;
```

Add the exported helper above `toSummary`:

```ts
// A shell is the row "+ New quote" creates before anything is priceable: request_json and
// result_json are both { shell: true }. POST /save overwrites request/result wholesale, so the
// marker cannot survive a real save — that is what makes it safe to store a $0 row with no
// nullable-money migration.
export function isUnpricedShell(q: { request: unknown }): boolean {
  return !!q.request && typeof q.request === 'object' && (q.request as { shell?: unknown }).shell === true;
}
```

In `toSummary`, add after `createdAt`:

```ts
    unpriced: isUnpricedShell(q),
```

In `api/src/db/postgresQuoteRepo.ts`, in `list()`'s `rows.map`, add after `routeText`:

```ts
      unpriced: isUnpricedShell({ request: r.request }),
```

and add `isUnpricedShell` to the existing `../db/quoteRepo` (or `./quoteRepo`) import in that file.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd api && npx vitest run src/db/quoteRepo.test.ts && npm run check
```

Expected: PASS, and `npm run check` green (it typechecks that both repos now satisfy `QuoteSummary`).

- [ ] **Step 5: Commit**

```bash
git add api/src/db/quoteRepo.ts api/src/db/postgresQuoteRepo.ts api/src/db/quoteRepo.test.ts
git commit -m "feat(quotes): mark unpriced shell rows on the quote summary"
```

---

### Task 2: `POST /admin/quote/draft`

**Files:**
- Modify: `api/src/routes/internalQuote.ts` (add the route immediately **before** `r.post('/save', ...)`, ~line 564)
- Test: `api/src/routes/internalQuote.test.ts`

**Interfaces:**
- Consumes: `isUnpricedShell` (Task 1).
- Produces: `POST /admin/quote/draft` → `201 { id, reference, status, assignedTo }` — the same response shape `POST /save` returns on create, so the builder reuses its existing handling.

Notes for the implementer:
- The router already applies `opsIdentity` + `requireCap('quote:manage')` to every path via `r.use('*', ...)` (~line 502), so the new route needs no per-route capability guard. It **does** need the `csrf` middleware, like every other mutating route here.
- `RATE_CARD` is already imported in this file. `c.get('identity').email` is the actor.
- Tests in this file `POST` with no `Origin`/`Sec-Fetch-Site` header, which the `csrf` middleware deliberately allows (non-browser caller).

- [ ] **Step 1: Write the failing test**

Append to `api/src/routes/internalQuote.test.ts`:

```ts
describe('POST /admin/quote/draft (autosave shell)', () => {
  it('creates a $0 draft shell assigned to its creator', async () => {
    const quotes = new InMemoryQuoteRepo();
    const app = createApp({ quotes });

    const res = await post(app, '/admin/quote/draft', {});
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe('draft');
    expect(body.reference).toMatch(/\S/);
    expect(body.assignedTo).toBe('f@x.com');

    const saved = await quotes.get(body.id);
    expect(saved!.totalCents).toBe(0);
    expect(saved!.channel).toBe('ops');
    expect(saved!.customerName).toBeNull();
    expect(saved!.requestedService).toBeNull();
    expect(isUnpricedShell(saved!)).toBe(true);
  });

  it('401s without a session', async () => {
    const res = await realCreateApp({ auth: AUTH, adminApiKey: 'k' }).request('/admin/quote/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('403s on a cross-site POST', async () => {
    const app = createApp({ quotes: new InMemoryQuoteRepo() });
    const res = await app.request('/admin/quote/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: FOUNDER_COOKIE, 'sec-fetch-site': 'cross-site' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('bad_origin');
  });
});
```

Add `isUnpricedShell` to the existing `../db/quoteRepo` import in that test file.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && npx vitest run src/routes/internalQuote.test.ts -t "autosave shell"
```

Expected: FAIL — the first case gets `404` (route not registered).

- [ ] **Step 3: Write minimal implementation**

In `api/src/routes/internalQuote.ts`, immediately before `r.post('/save', ...)`:

```ts
  // "+ New quote" (spec 2026-07-29). Creates the row BEFORE anything is priceable, so an ops
  // agent can claim or hand over the ticket on the call rather than after a Save. /save prices
  // via resolveAndPrice() and therefore cannot create an empty row — hence this separate insert.
  // The row is a $0 SHELL: request/result are the { shell: true } marker, which POST /save
  // overwrites wholesale on the first real save. Nothing else about the row is special, so the
  // queue, assignment, soft-delete and reopen paths all work on it unchanged.
  r.post('/draft', csrf, async (c) => {
    const actor = c.get('identity').email;
    const saved = await deps.quotes.save({
      channel: 'ops',
      product: 'private', // the builder's default service; the first real save overwrites it
      totalCents: 0,
      currency: RATE_CARD.currency,
      rateCardVersion: RATE_CARD.version,
      request: { shell: true },
      result: { shell: true },
      createdBy: actor,
      updatedBy: actor,
      assignedTo: actor, // same auto-assign-to-creator rule /save applies on insert
    });
    return c.json({ id: saved.id, reference: saved.reference, status: saved.status, assignedTo: saved.assignedTo }, 201);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd api && npx vitest run src/routes/internalQuote.test.ts && npm run check
```

Expected: PASS (all three new cases, and the pre-existing suite still green).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts
git commit -m "feat(quotes): POST /admin/quote/draft creates an assignable \$0 shell"
```

---

### Task 3: A `$0` shell can never be submitted or sent

**Files:**
- Modify: `api/src/routes/internalQuote.ts` (inside the status block of `r.patch('/:id', ...)`, immediately after the `requested_service_required` check, ~line 831)
- Test: `api/src/routes/internalQuote.test.ts`

**Interfaces:**
- Consumes: `isUnpricedShell` (Task 1), `POST /admin/quote/draft` (Task 2).
- Produces: `400 { error: 'unpriced_quote' }` on `pending_review` / `ready` / `sent` for a shell.

Note: the check reads the **stored** row (`current`), never the request body — for the same reason the adjacent `requestedService` check does. Only `POST /save` writes pricing, so trusting a body value here would be a hole.

- [ ] **Step 1: Write the failing test**

Append to `api/src/routes/internalQuote.test.ts`:

```ts
describe('unpriced shells cannot leave draft', () => {
  async function shell(quotes: InMemoryQuoteRepo) {
    return quotes.save({
      channel: 'ops', product: 'private', totalCents: 0, currency: 'USD',
      rateCardVersion: 'v', request: { shell: true }, result: { shell: true },
      // requestedService is set so this test isolates the price gate from the intent gate
      requestedService: 'private', customerName: 'Maya', customerContact: '+34600',
    });
  }
  function patch(app: App, id: string, body: unknown) {
    return app.request('/admin/quote/' + id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: FOUNDER_COOKIE },
      body: JSON.stringify(body),
    });
  }

  for (const to of ['pending_review', 'ready', 'sent'] as const) {
    it(`400 unpriced_quote on ${to}`, async () => {
      const quotes = new InMemoryQuoteRepo();
      const q = await shell(quotes);
      const res = await patch(createApp({ quotes }), q.id, { status: to });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('unpriced_quote');
      expect((await quotes.get(q.id))!.status).toBe('draft');
    });
  }

  it('allows a priced quote through the same transition', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await quotes.save({
      channel: 'ops', product: 'private', totalCents: 4048, currency: 'USD',
      rateCardVersion: 'v', request: { tool: {}, engine: {} }, result: { totalCents: 4048 },
      requestedService: 'private', customerName: 'Maya', customerContact: '+34600',
    });
    const res = await patch(createApp({ quotes }), q.id, { status: 'pending_review' });
    expect(res.status).toBe(200);
  });

  it('lets a shell through once a real save has priced it', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await shell(quotes);
    // A real save replaces request/result wholesale — the marker is gone by construction.
    await quotes.update(q.id, {
      product: 'private', totalCents: 4048, currency: 'USD', rateCardVersion: 'v',
      request: { tool: {}, engine: {} }, result: { totalCents: 4048 },
      customerName: 'Maya', customerContact: '+34600', requestedService: 'private',
    });
    const res = await patch(createApp({ quotes }), q.id, { status: 'pending_review' });
    expect(res.status).toBe(200);
  });

  it('still allows an internal-notes-only PATCH on a shell', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await shell(quotes);
    const res = await patch(createApp({ quotes }), q.id, { internalNotes: 'called back at 4' });
    expect(res.status).toBe(200);
  });

  it('still allows assigning a shell', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await shell(quotes);
    const res = await patch(createApp({ quotes }), q.id, { assignedTo: 'op@x.com' });
    expect(res.status).toBe(200);
    expect((await quotes.get(q.id))!.assignedTo).toBe('op@x.com');
  });
});
```

If `type App` is not already in scope in this file, use `ReturnType<typeof realCreateApp>` inline instead — it is defined near the top of the file (~line 30).

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && npx vitest run src/routes/internalQuote.test.ts -t "unpriced shells"
```

Expected: FAIL — the three transition cases return `200`, not `400`.

- [ ] **Step 3: Write minimal implementation**

In `api/src/routes/internalQuote.ts`, immediately after the `requested_service_required` block:

```ts
      // Autosave shells (spec 2026-07-29, owner: "make sure zero $ quotes can never be sent").
      // A shell is a real draft row created before anything was priceable; it must never reach
      // review, approval or the customer. Checked against the STORED row, never the body — only
      // POST /save writes pricing, so a body value here would be a hole, not a shortcut.
      // Assignment and internal notes stay allowed: that is the whole point of the early row.
      if ((to === 'pending_review' || to === 'ready' || to === 'sent') && isUnpricedShell(current)) {
        return c.json({ error: 'unpriced_quote' }, 400);
      }
```

Add `isUnpricedShell` to the existing `../db/quoteRepo` import in this file.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd api && npx vitest run src/routes/internalQuote.test.ts && npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts
git commit -m "feat(quotes): refuse to submit, approve or send an unpriced shell"
```

---

### Task 4: The abandoned-draft sweep

**Files:**
- Create: `api/src/services/abandonedDrafts.ts`
- Create: `api/src/services/abandonedDrafts.test.ts`
- Modify: `api/src/routes/admin.ts` (inside `r.post('/jobs/notifications', ...)`, after the `expiredQuotes` block, ~line 246)
- Test: `api/src/routes/admin.test.ts` (assert the response field)

**Interfaces:**
- Consumes: `isUnpricedShell` (Task 1), `QuoteRepo` (`list`, `get`, `softDelete`).
- Produces:
  - `export const ABANDONED_DRAFT_TTL_MS = 24 * 3600 * 1000`
  - `export async function sweepAbandonedDrafts(now: Date, deps: { quotes: QuoteRepo }): Promise<{ swept: number }>`
  - `POST /admin/jobs/notifications` response gains `abandonedDrafts: number`

- [ ] **Step 1: Write the failing test**

Create `api/src/services/abandonedDrafts.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sweepAbandonedDrafts, ABANDONED_DRAFT_TTL_MS } from './abandonedDrafts';
import { InMemoryQuoteRepo, type NewQuote } from '../db/quoteRepo';

const NOW = new Date('2026-07-29T06:00:00Z');
const HOUR = 3600 * 1000;

const shell = (over: Partial<NewQuote> = {}): NewQuote => ({
  channel: 'ops',
  product: 'private',
  totalCents: 0,
  currency: 'USD',
  rateCardVersion: 'v',
  request: { shell: true },
  result: { shell: true },
  ...over,
});
const priced = (over: Partial<NewQuote> = {}): NewQuote => ({
  ...shell(),
  totalCents: 4048,
  request: { tool: {}, engine: {} },
  result: { totalCents: 4048 },
  ...over,
});

// The in-memory repo stamps createdAt/updatedAt from the clock, so create the row at `at`
// and then restore the clock to NOW.
async function savedAt(repo: InMemoryQuoteRepo, at: Date, q: NewQuote) {
  vi.setSystemTime(at);
  const row = await repo.save(q);
  vi.setSystemTime(NOW);
  return row;
}

describe('sweepAbandonedDrafts', () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  it('soft-deletes an unpriced draft untouched past the TTL', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await savedAt(repo, new Date(NOW.getTime() - ABANDONED_DRAFT_TTL_MS - HOUR), shell());

    expect(await sweepAbandonedDrafts(NOW, { quotes: repo })).toEqual({ swept: 1 });
    expect(await repo.get(q.id)).toBeNull(); // get() hides soft-deleted rows
  });

  it('stamps the sweep as the deleting actor', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await savedAt(repo, new Date(NOW.getTime() - ABANDONED_DRAFT_TTL_MS - HOUR), shell());
    const spy = vi.spyOn(repo, 'softDelete');

    await sweepAbandonedDrafts(NOW, { quotes: repo });

    expect(spy).toHaveBeenCalledWith(q.id, 'system:draft-cleanup');
  });

  it('spares an unpriced draft younger than the TTL', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await savedAt(repo, new Date(NOW.getTime() - HOUR), shell());
    expect(await sweepAbandonedDrafts(NOW, { quotes: repo })).toEqual({ swept: 0 });
    expect(await repo.get(q.id)).not.toBeNull();
  });

  it('spares a priced draft of any age', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await savedAt(repo, new Date(NOW.getTime() - 30 * 24 * HOUR), priced());
    expect(await sweepAbandonedDrafts(NOW, { quotes: repo })).toEqual({ swept: 0 });
    expect(await repo.get(q.id)).not.toBeNull();
  });

  it('spares an old shell that was touched inside the window', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await savedAt(repo, new Date(NOW.getTime() - 5 * 24 * HOUR), shell());
    await repo.patch(q.id, { internalNotes: 'called back' }); // bumps updatedAt to NOW
    expect(await sweepAbandonedDrafts(NOW, { quotes: repo })).toEqual({ swept: 0 });
    expect(await repo.get(q.id)).not.toBeNull();
  });

  it('sweeps an assigned shell — assignment does not grant immortality', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await savedAt(
      repo,
      new Date(NOW.getTime() - ABANDONED_DRAFT_TTL_MS - HOUR),
      shell({ assignedTo: 'op@x.com' }),
    );
    expect(await sweepAbandonedDrafts(NOW, { quotes: repo })).toEqual({ swept: 1 });
    expect(await repo.get(q.id)).toBeNull();
  });

  it('keeps going when one row fails to delete', async () => {
    const repo = new InMemoryQuoteRepo();
    const old = new Date(NOW.getTime() - ABANDONED_DRAFT_TTL_MS - HOUR);
    const a = await savedAt(repo, old, shell());
    const b = await savedAt(repo, old, shell());
    const real = repo.softDelete.bind(repo);
    vi.spyOn(repo, 'softDelete').mockImplementation(async (id, by) => {
      if (id === a.id) throw new Error('boom');
      return real(id, by);
    });

    expect(await sweepAbandonedDrafts(NOW, { quotes: repo })).toEqual({ swept: 1 });
    expect(await repo.get(b.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && npx vitest run src/services/abandonedDrafts.test.ts
```

Expected: FAIL — cannot resolve `./abandonedDrafts`.

- [ ] **Step 3: Write minimal implementation**

Create `api/src/services/abandonedDrafts.ts`:

```ts
import { isUnpricedShell, type QuoteRepo } from '../db/quoteRepo';

// How long an unpriced shell may sit untouched before the sweep soft-deletes it (owner
// 2026-07-29). "+ New quote" creates a real row so the ticket can be assigned on the call, which
// means an abandoned click leaves a row behind; this is what keeps the queue bounded. Anchored on
// updatedAt, not createdAt, so a shell someone actually touched gets a fresh window. 24h is also
// the floor set by the driver: the sweep rides the DAILY cron tick, so a shorter window could not
// be enforced without a new schedule.
export const ABANDONED_DRAFT_TTL_MS = 24 * 3600 * 1000;

// Soft-delete ops draft shells nobody finished. Pure over (now, repos) like the other scheduler
// sweeps so it's deterministic in tests; the cron tick drives it with the real clock. Naturally
// idempotent (a deleted row no longer appears in list()) and per-row best-effort — one bad row
// must not strand the rest of the sweep. Soft delete only: the row stays in the table, so a wrong
// call is recoverable, matching the existing soft-delete contract.
export async function sweepAbandonedDrafts(
  now: Date,
  deps: { quotes: QuoteRepo },
): Promise<{ swept: number }> {
  const { quotes } = deps;
  let swept = 0;
  for (const summary of await quotes.list({ channel: 'ops', status: 'draft' })) {
    if (!summary.unpriced) continue; // priced work is never swept, at any age
    const q = await quotes.get(summary.id);
    if (!q) continue;
    if (now.getTime() - q.updatedAt.getTime() < ABANDONED_DRAFT_TTL_MS) continue;
    try {
      await quotes.softDelete(q.id, 'system:draft-cleanup');
      swept++;
    } catch (err) {
      console.error(`abandoned-draft sweep failed for ${q.reference}:`, err);
    }
  }
  return { swept };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api && npx vitest run src/services/abandonedDrafts.test.ts
```

Expected: PASS (7 cases).

- [ ] **Step 5: Wire it into the cron tick**

In `api/src/routes/admin.ts`, add the import beside the existing service imports:

```ts
import { sweepAbandonedDrafts } from '../services/abandonedDrafts';
```

Inside `r.post('/jobs/notifications', ...)`, after the `expiredQuotes` block and before the digest block:

```ts
    // Abandoned autosave shells ride the same tick, best-effort: "+ New quote" creates a real
    // row so the ticket is assignable immediately, and this is what stops the unfinished ones
    // accumulating. Idempotent (a soft-deleted row no longer lists) and a failure here must
    // never block the customer notifications the caller asked for.
    let abandonedDrafts = 0;
    if (deps.quotes) {
      try {
        abandonedDrafts = (await sweepAbandonedDrafts(new Date(), { quotes: deps.quotes })).swept;
      } catch (err) {
        console.error('abandoned-draft sweep failed:', err);
      }
    }
```

and add it to the response literal at the end of the handler:

```ts
    return c.json({ ...result, staleSharedHolds, expiredQuotes, abandonedDrafts, digest, rideBoard }, 200);
```

- [ ] **Step 6: Add the route-level assertion**

Append to `api/src/routes/admin.test.ts` (follow the file's existing pattern for authenticating the tick with `x-admin-key`, and reuse whatever quote-repo fixture the `expiredQuotes` assertions in that file already use):

```ts
it('the notifications tick reports the abandoned-draft sweep', async () => {
  const res = await tick(); // the file's existing helper for POST /admin/jobs/notifications
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ abandonedDrafts: 0 });
});
```

If `admin.test.ts` has no such helper, POST the endpoint directly with the `x-admin-key: k` header exactly as the neighbouring watchdog test does.

- [ ] **Step 7: Run the full check**

```bash
cd api && npm run check
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add api/src/services/abandonedDrafts.ts api/src/services/abandonedDrafts.test.ts api/src/routes/admin.ts api/src/routes/admin.test.ts
git commit -m "feat(quotes): sweep abandoned unpriced drafts after 24h"
```

---

### Task 5: Exclude shells from founder analytics

**Files:**
- Modify: `api/src/db/quoteRepo.ts` (`InMemoryQuoteRepo.listFunnelRows` ~line 346, `listDemandRows` ~line 362)
- Modify: `api/src/db/postgresQuoteRepo.ts` (`listFunnelRows` ~line 189, `listDemandRows` ~line 220)
- Test: `api/src/db/quoteRepo.test.ts`

**Interfaces:**
- Consumes: `isUnpricedShell` (Task 1).
- Produces: nothing new — both projections simply stop emitting shells.

Note on the perf contract: `listFunnelRows` deliberately never *selects* `request_json`. Adding a JSONB predicate to its `WHERE` does not break that — the projection stays scalar-only, and the query is already bounded by the window/live arms plus `limit`. Do **not** add `request_json` to the funnel `select`.

- [ ] **Step 1: Write the failing test**

Append to `api/src/db/quoteRepo.test.ts`:

```ts
describe('analytics projections exclude unpriced shells', () => {
  async function seed() {
    const repo = new InMemoryQuoteRepo();
    await repo.save({
      channel: 'ops', product: 'private', totalCents: 0, currency: 'USD',
      rateCardVersion: 'v', request: { shell: true }, result: { shell: true },
    });
    await repo.save({
      channel: 'ops', product: 'private', totalCents: 4048, currency: 'USD',
      rateCardVersion: 'v', request: { tool: {}, engine: {} }, result: { totalCents: 4048 },
    });
    return repo;
  }

  it('omits shells from the funnel rows', async () => {
    const repo = await seed();
    const { rows } = await repo.listFunnelRows(new Date(0), 100, 'ops');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.totalCents).toBe(4048);
  });

  it('omits shells from the demand rows', async () => {
    const repo = await seed();
    const { rows } = await repo.listDemandRows(new Date(0), new Date('2100-01-01'), 100, 'ops');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.totalCents).toBe(4048);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && npx vitest run src/db/quoteRepo.test.ts -t "exclude unpriced shells"
```

Expected: FAIL — both get 2 rows.

- [ ] **Step 3: Write minimal implementation**

In `api/src/db/quoteRepo.ts`, add `&& !isUnpricedShell(r)` to the row filter inside **both** `listFunnelRows` and `listDemandRows`, with this comment above each:

```ts
    // Autosave shells never count as demand (spec 2026-07-29): they are rows created by clicking
    // "+ New quote", not quotes anyone built. Counting them would inflate the funnel's draft stage.
```

In `api/src/db/postgresQuoteRepo.ts`, add this condition to the `and(...)` in **both** projections' `where`:

```ts
        // Autosave shells never count as demand (spec 2026-07-29). Predicate only — request_json
        // stays OUT of the funnel's select, so the scalar-only perf contract is intact.
        sql`coalesce(${quotes.requestJson}->>'shell', '') <> 'true'`,
```

Ensure `sql` is imported from `drizzle-orm` in that file (it already is, for the schema's partial index style — confirm and add if missing).

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api && npx vitest run src/db/quoteRepo.test.ts && npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/db/quoteRepo.ts api/src/db/postgresQuoteRepo.ts api/src/db/quoteRepo.test.ts
git commit -m "feat(analytics): keep unpriced shells out of the funnel and demand rows"
```

---

### Task 6: The builder creates its row on "+ New quote"

**Files:**
- Modify: `api/src/routes/ops-ui.html` — `apiSave` neighbourhood (~line 3585), `resetToNew`/`startNew` (~line 3645-3697), `fireAutosave` (~line 3305), `renderSaveState` (~line 3318), `renderHeaderAssign` (~line 5661)

**Interfaces:**
- Consumes: `POST /admin/quote/draft` (Task 2).
- Produces: `state.unpriced` (boolean, client-side) — read by Task 7's queue/blocker changes and by `renderSaveState`.

This file is a single large inline-script page; keep the edits surgical and in its existing `var`/`function` style (no `const`/arrow-only rewrites of surrounding code).

- [ ] **Step 1: Add the API helper**

After `apiSave` (~line 3596), add:

```js
// "+ New quote" creates the row up front (spec 2026-07-29) so the assignee picker is live before
// anything is priceable — an agent claims or hands over the ticket on the call, not after a Save.
async function apiCreateDraft() {
  try {
    var r = await api('/admin/quote/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!r.ok) return await errPayload(r);
    var body = await jsonOrNull(r);
    return body || { error: 'Could not start a quote' };
  } catch (e) { window.opsReportError && window.opsReportError('apiCreateDraft', e); return { error: 'Network error' }; }
}
```

- [ ] **Step 2: Track the shell in state and claim the row on startNew**

In `resetToNew`'s state literal, add after `assignedTo: null`:

```js
    unpriced: false, // true while this row is a server-side shell (never priced) — spec 2026-07-29
```

Replace `startNew` with:

```js
// The ops shell's "+ New quote" entry: reset to a fresh draft, guarding only when there are
// unsaved edits to lose, then claim a real row so the ticket is assignable immediately. The
// create is fire-and-forget from the operator's point of view — they can start typing at once.
function startNew() {
  if (_dirty && !confirm('Start a new quote? Unsaved changes will be lost.')) return;
  resetToNew();
  claimDraftRow();
}

// Create the shell row for the quote now on screen. Non-blocking by design: on failure the
// builder simply behaves as it did before this shipped (unsaved, assign disabled, manual Save)
// rather than trapping the operator behind a network error.
async function claimDraftRow() {
  var seq = _openSeq; // a reopen that lands mid-flight must win
  var res = await apiCreateDraft();
  if (seq !== _openSeq) return;
  if (!res || !res.id) return;
  state.savedId = res.id;
  state.reference = res.reference || res.id;
  state.unpriced = true;
  if (res.assignedTo !== undefined) state.assignedTo = res.assignedTo;
  if (window.opsRefreshQuotes) window.opsRefreshQuotes();
  render();
}
```

- [ ] **Step 3: Clear the shell flag on a real save and on reopen**

In `saveQuote`, inside the `if (res && res.id)` block, after the `state.assignedTo` line:

```js
    state.unpriced = false; // a real save prices the quote — the shell marker is gone server-side
```

In `reopenQuote` (~line 3999, where `state.reference` is set from the loaded row), add:

```js
  state.unpriced = !!(q.request && q.request.shell === true);
```

- [ ] **Step 4: Let autosave persist a shell's first real content**

In `fireAutosave`, replace:

```js
  if (!state.savedId || !isEditableNow() || !state.vehicleType) return;
```

with:

```js
  // The row now exists from the first click (spec 2026-07-29), so savedId is no longer the gate.
  // vehicleType still is: POST /save runs resolveAndPrice(), so an unpriceable payload cannot be
  // persisted at all. That window is the only place the beforeunload guard still matters.
  if (!isEditableNow() || !state.vehicleType) return;
```

- [ ] **Step 5: Fix the save-state chip copy**

In `renderSaveState`, replace the `_dirty` branch:

```js
  else if (_dirty) { cls += ' dirty'; txt = state.savedId ? 'Edits pending' : 'Unsaved'; }
```

with:

```js
  // On a shell the row already exists, so "Unsaved" would overstate the risk: what is pending is
  // a PRICE, not persistence. Say so.
  else if (_dirty) { cls += ' dirty'; txt = state.unpriced ? 'Not priced yet' : (state.savedId ? 'Edits pending' : 'Unsaved'); }
```

and add, before the final `else return`:

```js
  else if (state.unpriced) { cls += ' dirty'; txt = 'Not priced yet'; }
```

- [ ] **Step 6: Make the assignee picker live from the first frame**

In `renderHeaderAssign`, replace the `unsaved`/placeholder/title/disabled logic so the control is only disabled when there is genuinely no row (the create failed):

```js
function renderHeaderAssign() {
  // The row is created by "+ New quote" (spec 2026-07-29), so this is live from the first frame.
  // It stays disabled only when there is genuinely no row — i.e. the draft create failed and the
  // builder fell back to manual-save behaviour.
  var noRow = !state.savedId;
  var cur = state.assignedTo || '';
  var me = (window.opsEmail || '').toLowerCase();
  var opts = ['<option value=""' + (cur ? '' : ' selected') + '>Unassigned</option>'];
  opsUsers.forEach(function(u) {
    var label = u.displayName || String(u.email || '').split('@')[0];
    opts.push('<option value="' + esc(u.email) + '"' + (u.email === cur ? ' selected' : '') +
      ' title="' + esc(u.email) + '">' +
      esc(label) + (u.email === me ? ' (you)' : '') + '</option>');
  });
  var tone = (cur && cur === me) ? ' mine' : (cur ? '' : ' none');
  var title = noRow
    ? 'Could not start this quote on the server — save it to assign'
    : 'Assign this quote — click to reassign';
  return '<select class="ch-assign-sel ch-head-assign' + tone + '" id="assignSel" data-action="assignQuote"'
    + (noRow ? ' disabled' : '')
    + ' aria-label="Assign this quote" title="' + esc(title) + '">' + opts.join('') + '</select>';
}
```

Keep the `selected`-on-placeholder comment block that is already above the `opts` line — it documents a real morphdom bug and still applies.

- [ ] **Step 7: Verify in the browser**

```bash
cd api && npm run dev
```

Open `http://localhost:8787/ops`, sign in via `/__devlogin`, click "+ New quote". Confirm: the assignee picker is enabled and shows your name; picking a different name succeeds with no Save click; the chip reads "Not priced yet"; the new row appears in the queue.

- [ ] **Step 8: Run the gates and commit**

```bash
cd api && npm run check && cd .. && npm run test:all
```

Expected: PASS. Existing e2e specs that assert the assign picker is disabled on a new quote will need updating — that is expected and correct; update them to the new behaviour rather than weakening the assertion.

```bash
git add api/src/routes/ops-ui.html web-tests/
git commit -m "feat(ops): create the quote row on + New quote so assign works immediately"
```

---

### Task 7: Queue marking + the submit blocker

**Files:**
- Modify: `api/src/routes/ops-ui.html` — the `qrow` template (~line 1869-1875), `submitBlockers` (~line 4787)

**Interfaces:**
- Consumes: `QuoteSummary.unpriced` (Task 1), `state.unpriced` (Task 6).
- Produces: nothing.

- [ ] **Step 1: Mark the queue row**

In the `qrow` template, replace the `.qtotal` span:

```js
    <span class="qtotal" title="${esc(quoteUsd(q.totalCents))}">${esc(quoteUsdWhole(q.totalCents))}</span>
```

with:

```js
    <span class="qtotal${q.unpriced ? ' qtotal-unpriced' : ''}" title="${q.unpriced ? 'Started but never priced' : esc(quoteUsd(q.totalCents))}">${q.unpriced ? 'Not priced yet' : esc(quoteUsdWhole(q.totalCents))}</span>
```

and in the same template's `aria-label`, replace `${esc(quoteUsd(q.totalCents))}` with:

```js
${q.unpriced ? 'not priced yet' : esc(quoteUsd(q.totalCents))}
```

so a screen reader never announces `$0.00` for a shell.

- [ ] **Step 2: Add the muted tone**

Next to the existing `.qtotal` rule in the page's CSS, add:

```css
/* An unpriced shell (spec 2026-07-29) states its condition instead of showing a $0 total; muted
   and non-numeric so it never reads as a real price at a glance. */
.qtotal-unpriced { color: var(--ink-3, #8a8f98); font-variant-numeric: normal; font-weight: 400; }
```

Match the surrounding CSS's variable names — if `--ink-3` is not defined on this page, use the same muted colour token the row's secondary text already uses.

- [ ] **Step 3: Mirror the server's send gate in the blockers panel**

In `submitBlockers`, replace the trailing price blocker:

```js
  if (!out.length && !lastEstimate) add('A price — the trip could not be costed', '.ch-money');
```

with:

```js
  /* A price last: it's the SYMPTOM of most of the above, so naming it first would bury the cause.
     On a shell the server refuses the transition outright (400 unpriced_quote), so say so even
     when other blockers are listed — otherwise the panel could look satisfiable when it isn't. */
  if (state.unpriced) add('A price — this quote has not been priced yet', '.ch-money');
  else if (!out.length && !lastEstimate) add('A price — the trip could not be costed', '.ch-money');
```

- [ ] **Step 4: Verify in the browser**

With `npm run dev` running: click "+ New quote", go back to the queue, confirm the new row reads "Not priced yet" rather than `$0`. Reopen it and click Submit for review — the blockers panel must name the price. Then build a real quote and confirm the row shows its dollar total and submits normally.

- [ ] **Step 5: Run the gates and commit**

```bash
cd api && npm run check && cd .. && npm run test:all
```

```bash
git add api/src/routes/ops-ui.html
git commit -m "feat(ops): mark unpriced shells in the queue and block submitting them"
```

---

### Task 8: End-to-end coverage

**Files:**
- Create: `web-tests/e2e/ops-autosave-drafts.spec.js`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

Selectors, all verified against `api/src/routes/ops-ui.html` — use these, do not substitute:

| Thing | Selector |
| --- | --- |
| "+ New quote" button | `[data-qnew]` (`ops-ui.html:1918`) |
| Assignee picker | `#assignSel` |
| Save-state chip | `#ch-savestate` |
| Submit for review | `[data-action="submitForReview"]` (rendered by `B()`, `ops-ui.html:5623`) |
| Blockers panel | `.ch-blockers` |
| Queue row total | `.qrow .qtotal` / `.qrow .qtotal-unpriced` |

Copy the harness preamble from `web-tests/e2e/ops-ui.spec.js` verbatim: the `test.skip(process.env.CH_E2E_API !== '1', ...)` gate, the `OPS` base const (`process.env.OPS_BASE || 'http://localhost:8787'` + `/ops`), the `FOUNDER_EMAIL = 'founder@e2e.test'` const, and its `login(page, email)` helper (`#devloginemail` + `requestSubmit()` on `#devloginform`, then wait for `#approot`). Do not write a new harness.

- [ ] **Step 1: Write the spec**

```js
import { test, expect } from '@playwright/test';

// Autosave shells (spec 2026-07-29): "+ New quote" creates the row up front, so an ops agent can
// assign the ticket on the call — before anything is priceable — and never presses Save.
test.skip(process.env.CH_E2E_API !== '1', 'ops autosave-draft e2e needs the API — run with CH_E2E_API=1');

const OPS = (process.env.OPS_BASE || 'http://localhost:8787') + '/ops';
const FOUNDER_EMAIL = 'founder@e2e.test';

// Copied from ops-ui.spec.js — see that file for why requestSubmit() beats a click here.
async function login(page, email) {
  await page.goto(OPS);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#login')).toHaveClass(/show/);
  await page.fill('#devloginemail', email);
  await page.evaluate(() => document.getElementById('devloginform').requestSubmit());
  await expect(page.locator('#login')).not.toHaveClass(/show/);
  await expect(page.locator('#approot')).toBeVisible({ timeout: 10000 });
}

test.describe('ops autosave drafts', () => {
  test('a brand-new quote is assignable with no Save click', async ({ page }) => {
    await login(page, FOUNDER_EMAIL);
    await page.locator('[data-qnew]').click();

    const assign = page.locator('#assignSel');
    await expect(assign).toBeEnabled({ timeout: 10000 }); // enabled once the shell row lands
    await expect(page.locator('#ch-savestate')).toContainText('Not priced yet');

    // Reassign to someone else purely through the picker — no Save is ever pressed.
    const others = assign.locator('option:not([value=""])');
    await expect(others.first()).toBeAttached();
    const target = await others.last().getAttribute('value');
    await assign.selectOption(target);
    await expect(assign).toHaveValue(target);
  });

  test('the queue marks the shell as not priced', async ({ page }) => {
    await login(page, FOUNDER_EMAIL);
    await page.locator('[data-qnew]').click();
    await expect(page.locator('#assignSel')).toBeEnabled({ timeout: 10000 });

    await page.goto(OPS); // back to the queue
    await expect(page.locator('.qrow .qtotal-unpriced').first()).toHaveText('Not priced yet');
  });

  test('submitting a shell is blocked and names the price', async ({ page }) => {
    await login(page, FOUNDER_EMAIL);
    await page.locator('[data-qnew]').click();
    await expect(page.locator('#assignSel')).toBeEnabled({ timeout: 10000 });

    await page.locator('[data-action="submitForReview"]').click();
    await expect(page.locator('.ch-blockers')).toContainText('has not been priced yet');
  });
});
```

Note: these tests create real shell rows in the e2e database. That is fine — they are `draft` + unpriced, so the Task 4 sweep reclaims them within 24h.

- [ ] **Step 2: Run the spec**

```bash
cd web-tests && CH_E2E_API=1 npx playwright test e2e/ops-autosave-drafts.spec.js
```

Expected: PASS. If the API server is not running, start it per `ops-ui.spec.js`'s documented setup — do not skip the spec to make it green.

- [ ] **Step 3: Full suite and commit**

```bash
cd api && npm run check && cd .. && npm run test:all
```

```bash
git add web-tests/e2e/ops-autosave-drafts.spec.js
git commit -m "test(ops): e2e cover assign-before-save and the unpriced queue marking"
```

---

## Done when

- Clicking "+ New quote" produces an assignable ticket with no Save click.
- A `$0` shell cannot reach `pending_review`, `ready` or `sent` — server-side, proven by test.
- The queue shows "Not priced yet" for shells; real quotes are unchanged.
- Shells are absent from the funnel and demand projections.
- `sweepAbandonedDrafts` runs on `POST /admin/jobs/notifications` and reports a count.
- `cd api && npm run check` and `npm run test:all` both green.
- No migration, no pricing change, no config change in the diff.

## Deploy note

Merging to `main` deploys to **staging** only. Prod needs a separate reviewed `main → production` promote PR with the owner's explicit ok — do not open it as part of this work.
