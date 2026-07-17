# Customer quote intent (requested service) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record on every quote which service the customer actually asked for (point-to-point / chauffeur-guide / both), require it before review, and flag when it doesn't match what was priced.

**Architecture:** One nullable `requested_service` text column on `quotes`. The submitter sets it in the ops builder; it rides in the existing tool payload through `POST /save` into both the flat column (for the server gate) and `request.tool` (for reopen). `PATCH /:id` refuses `→ pending_review` / `→ ready` while the stored value is null. The mismatch signal is display-only in the builder — it compares recorded vs priced with no server involvement.

**Tech Stack:** Node 20 · TypeScript (strict) · Hono · Zod · Vitest · Drizzle + Postgres (Supabase) · Playwright. Ops shell is a single self-contained HTML file with inlined JS (`api/src/routes/ops-ui.html`).

**Spec:** `docs/superpowers/specs/2026-07-17-quote-intent-design.md` (decisions I1–I10).

## Global Constraints

- **Migration number is `0017`** — `0015_quote_assignment` and `0016_ops_user_profiles` are both taken. Confirm with `ls api/drizzle/*.sql` before generating.
- **NEVER hand-write the migration SQL.** Drizzle owns `drizzle/*.sql`, `drizzle/meta/*_snapshot.json` and `drizzle/meta/_journal.json` as a unit. Edit `schema.ts`, then run `cd api && npm run db:generate`. Hand-editing desynchronises the snapshot.
- **Merging IS the schema release** (CLAUDE.md rule 7): since PR #50, Render applies pending migrations on boot, fail-closed. Flag the migration in the PR body. Do **not** tell the owner to run a prod migrate.
- **Values are exactly** `'private' | 'chauffeur' | 'both'`. No `'legacy'`, no `'shared'` (I2, I7).
- **No pre-fill / no default** (I4). The control starts unselected. Never derive it from `state.service`.
- **Gate `→ pending_review` and `→ ready` only.** `POST /save` is never gated (I3).
- **The mismatch never blocks** submission or approval (I8) — signal, not gate.
- **Leave it green:** `cd api && npm run check` and `cd web-tests && npm run test:all` before every commit.
- **Shared tree:** stage only your own files by path. Never `git add -A`.

---

### Task 1: Persist `requested_service` end-to-end

Column + schema + both repo implementations + the save route. Deliverable: the value round-trips through save/get/update.

**Files:**
- Modify: `api/src/db/schema.ts:221` (after `notes: text('notes'),`)
- Modify: `api/src/db/quoteRepo.ts` — `NewQuote` (~27), `SavedQuote` (~51), `InMemoryQuoteRepo.save()` (~208), `InMemoryQuoteRepo.update()`
- Modify: `api/src/db/postgresQuoteRepo.ts` — `toSaved()` (~51), `save()` insert (~88), `update()` set-block
- Modify: `api/src/routes/internalQuote.ts` — `parseToolRequest` (~50), `content` object in `POST /save`
- Generate: `api/drizzle/0017_*.sql` + `drizzle/meta/` (via `npm run db:generate`)
- Test: `api/src/db/quoteRepo.test.ts`, `api/src/routes/internalQuote.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `NewQuote.requestedService?: string | null`
  - `SavedQuote.requestedService: string | null`
  - tool payload field `requestedService?: 'private' | 'chauffeur' | 'both'`

- [ ] **Step 1: Write the failing repo test**

Append to `api/src/db/quoteRepo.test.ts`:

```ts
describe('requestedService (quote intent, spec 2026-07-17)', () => {
  const base = {
    product: 'private', totalCents: 1000, currency: 'USD',
    rateCardVersion: 'v1', request: {}, result: {},
  };

  it('round-trips the recorded request', async () => {
    const repo = new InMemoryQuoteRepo();
    const saved = await repo.save({ ...base, requestedService: 'both' });
    expect(saved.requestedService).toBe('both');
    expect((await repo.get(saved.id))!.requestedService).toBe('both');
  });

  it('defaults to null when the submitter has not recorded it (I7: no backfill, no sentinel)', async () => {
    const repo = new InMemoryQuoteRepo();
    const saved = await repo.save(base);
    expect(saved.requestedService).toBeNull();
  });

  it('update() rewrites it, so a correction on re-save sticks', async () => {
    const repo = new InMemoryQuoteRepo();
    const saved = await repo.save({ ...base, requestedService: 'private' });
    const updated = await repo.update(saved.id, { ...base, requestedService: 'chauffeur' });
    expect(updated!.requestedService).toBe('chauffeur');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd api && npx vitest run src/db/quoteRepo.test.ts`
Expected: FAIL — `requestedService` is not a known property / received `undefined`.

- [ ] **Step 3: Add the column to the schema**

`api/src/db/schema.ts`, immediately after `notes: text('notes'),`:

```ts
  // Quote intent (spec 2026-07-17): which service the CUSTOMER asked for — 'private' |
  // 'chauffeur' | 'both' — as distinct from `product`, which is what was actually priced.
  // Nullable: rows predating this have none, and the requirement is a workflow gate at
  // submit (internalQuote PATCH), not a storage constraint.
  requestedService: text('requested_service'),
```

- [ ] **Step 4: Generate the migration**

Run: `cd api && npm run db:generate`
Expected: creates `drizzle/0017_<name>.sql` containing `ALTER TABLE "quotes" ADD COLUMN "requested_service" text;`, plus `drizzle/meta/0017_snapshot.json` and a new `_journal.json` entry.

Verify it added a column and nothing else: `git diff --stat api/drizzle/` should show only the new files and `_journal.json`. If the generated SQL contains anything beyond the one ADD COLUMN, STOP — the schema has drifted and that is its own problem.

- [ ] **Step 5: Thread it through the repo types + in-memory repo**

`api/src/db/quoteRepo.ts` — in `NewQuote`, after `notes?: string | null;`:

```ts
  // Quote intent (spec 2026-07-17). What the customer ASKED for, vs `product` = what was priced.
  requestedService?: string | null;
```

In `SavedQuote`, after `notes: string | null;`:

```ts
  requestedService: string | null;
```

In `InMemoryQuoteRepo.save()`, after `notes: q.notes ?? null,`:

```ts
      requestedService: q.requestedService ?? null,
```

In `InMemoryQuoteRepo.update()`, after `row.notes = q.notes ?? null;`:

```ts
    row.requestedService = q.requestedService ?? null;
```

- [ ] **Step 6: Thread it through the postgres repo**

`api/src/db/postgresQuoteRepo.ts` — in `toSaved()`, after `notes: r.notes,`:

```ts
    requestedService: r.requestedService,
```

In `save()`'s `.values({...})`, after `notes: q.notes ?? null,`:

```ts
            requestedService: q.requestedService ?? null,
```

In `update()`'s `.set({...})`, after `notes: q.notes ?? null,`:

```ts
        requestedService: q.requestedService ?? null,
```

- [ ] **Step 7: Run the repo test to see it pass**

Run: `cd api && npx vitest run src/db/quoteRepo.test.ts`
Expected: PASS.

- [ ] **Step 8: Write the failing save-route test**

Append to `api/src/routes/internalQuote.test.ts`. These use the file's REAL module-scope helpers — `createApp()`, `post(app, path, body)` (carries `FOUNDER_COOKIE`), `authedGet(app, path)`, and the `leg()` fixture. Do not introduce new ones. Assertions go through `GET /:id` rather than a repo handle, matching how the neighbouring `/save` tests verify persistence:

```ts
describe('quote intent — requestedService persistence (spec 2026-07-17)', () => {
  const TRIP = { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 80 })] };

  it('persists the recorded customer request from the tool payload', async () => {
    const app = createApp();
    const res = await post(app, '/admin/quote/save', { ...TRIP, requestedService: 'both' });
    expect(res.status).toBe(201);
    const got = await (await authedGet(app, `/admin/quote/${(await res.json()).id}`)).json();
    expect(got.requestedService).toBe('both');
  });

  it('leaves it null when the payload omits it (I7: no backfill, no sentinel)', async () => {
    const app = createApp();
    const res = await post(app, '/admin/quote/save', TRIP);
    const got = await (await authedGet(app, `/admin/quote/${(await res.json()).id}`)).json();
    expect(got.requestedService).toBeNull();
  });

  it("rejects a value outside the enum — 'legacy' is not a member (I7)", async () => {
    const res = await post(createApp(), '/admin/quote/save', { ...TRIP, requestedService: 'legacy' });
    expect(res.status).toBe(400);
  });

  it('survives a re-save, so reopening and correcting it sticks', async () => {
    const app = createApp();
    const first = await (await post(app, '/admin/quote/save', { ...TRIP, requestedService: 'private' })).json();
    await post(app, '/admin/quote/save', { ...TRIP, id: first.id, requestedService: 'chauffeur' });
    const got = await (await authedGet(app, `/admin/quote/${first.id}`)).json();
    expect(got.requestedService).toBe('chauffeur');
  });
});
```

- [ ] **Step 9: Run it to see it fail**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: FAIL — `requestedService` is stripped by Zod, so the saved row has `null`/`undefined`.

- [ ] **Step 10: Accept + persist it in the save route**

`api/src/routes/internalQuote.ts`, in `parseToolRequest`'s schema, immediately after the `service:` line:

```ts
  // Quote intent (spec 2026-07-17). What the customer asked for — deliberately NOT defaulted
  // from `service` (I4): a pre-filled value gets accepted unread, which is the failure this
  // field exists to prevent. 'legacy' is not a member — there is no exemption (I7).
  requestedService: z.enum(['private', 'chauffeur', 'both']).optional(),
```

In the `content` object in `POST /save`, after `notes: body.notes ?? null,`:

```ts
        requestedService: body.requestedService ?? null,
```

- [ ] **Step 11: Run it to see it pass**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: PASS.

- [ ] **Step 12: Full gate + commit**

Run: `cd api && npm run check`
Expected: all green.

```bash
git add api/src/db/schema.ts api/src/db/quoteRepo.ts api/src/db/quoteRepo.test.ts \
        api/src/db/postgresQuoteRepo.ts api/src/routes/internalQuote.ts \
        api/src/routes/internalQuote.test.ts api/drizzle
git commit -m "feat(quote): persist the customer's requested service (migration 0017)"
```

---

### Task 2: Gate submission on the recorded request

**Files:**
- Modify: `api/src/routes/internalQuote.ts` — the `r.patch('/:id')` handler, inside the existing `if (body.status) {` block
- Test: `api/src/routes/internalQuote.test.ts`

**Interfaces:**
- Consumes: `SavedQuote.requestedService` (Task 1).
- Produces: `400 { error: 'requested_service_required' }` on a gated transition.

- [ ] **Step 1: Write the failing gate tests**

Append to `api/src/routes/internalQuote.test.ts`:

```ts
describe('quote intent — submit gate (spec 2026-07-17, I3/I7)', () => {
  const TRIP = { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 80 })] };
  // The file's `patch` helper lives inside another describe, so it is NOT in scope here.
  // FOUNDER_COOKIE and App are module-scope, so this local helper is self-contained.
  const patchReq = (app: App, path: string, body: unknown) =>
    app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: FOUNDER_COOKIE }, body: JSON.stringify(body) });
  const draft = async (app: App, extra: Record<string, unknown> = {}) =>
    (await (await post(app, '/admin/quote/save', { ...TRIP, ...extra })).json()) as { id: string };

  it('400s draft → pending_review when nothing is recorded', async () => {
    const app = createApp();
    const q = await draft(app);
    const res = await patchReq(app, `/admin/quote/${q.id}`, { status: 'pending_review' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('requested_service_required');
  });

  it('allows draft → pending_review once it is recorded', async () => {
    const app = createApp();
    const q = await draft(app, { requestedService: 'private' });
    const res = await patchReq(app, `/admin/quote/${q.id}`, { status: 'pending_review' });
    expect(res.status).toBe(200);
  });

  it("gates the founder's draft → ready self-approve identically", async () => {
    const app = createApp();
    const q = await draft(app);
    const res = await patchReq(app, `/admin/quote/${q.id}`, { status: 'ready' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('requested_service_required');
  });

  it('does NOT gate the outcome flips (→ lost), which need no recorded request', async () => {
    const app = createApp();
    const q = await draft(app);
    const res = await patchReq(app, `/admin/quote/${q.id}`, { status: 'lost' });
    expect(res.status).toBe(200);
  });

  it('reads the STORED row, not the body — a client cannot smuggle the value past the gate', async () => {
    const app = createApp();
    const q = await draft(app);
    const res = await patchReq(app, `/admin/quote/${q.id}`, { status: 'pending_review', requestedService: 'both' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t "requested_service required"`
Expected: FAIL — the gated cases return 200 instead of 400.

- [ ] **Step 3: Add the gate**

`api/src/routes/internalQuote.ts`, inside `r.patch('/:id')`'s `if (body.status) {` block, after `if (!canTransition(current.status, to)) return c.json({ error: 'illegal_transition' }, 409);`:

```ts
      // Quote intent (spec 2026-07-17, I3): a quote may not enter review — or be
      // self-approved straight to ready — until the submitter has recorded what the customer
      // asked for. Checked against the STORED row, never the body: the client cannot supply it
      // here (only POST /save writes it), so trusting the body would be a hole, not a shortcut.
      // Deliberately NOT applied to /save (work-in-progress must always be savable) and NOT to
      // the outcome flips (won/lost/expired), which need no recorded request.
      if ((to === 'pending_review' || to === 'ready') && !current.requestedService) {
        return c.json({ error: 'requested_service_required' }, 400);
      }
```

- [ ] **Step 4: Run them to see them pass**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t "requested_service required"`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

Run: `cd api && npm run check`
Expected: all green. **If pre-existing PATCH tests now fail with 400**, that is the gate working: those fixtures create drafts with no recorded request and then submit them. Fix each by adding `requestedService: 'private'` to the fixture — do NOT weaken the gate.

```bash
git add api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts
git commit -m "feat(quote): require the recorded customer request before review"
```

---

### Task 3: The "Customer asked for" control

**Files:**
- Modify: `api/src/routes/ops-ui.html` — state init (~2039), the reset in `startNew` (~2300), the save payload (~2340), `reopenQuote`'s tool restore (~2472), and the service-chooser render (the `ch-svc-choose` block)
- Test: `api/src/routes/opsUi.test.ts`

**Interfaces:**
- Consumes: tool payload field `requestedService` (Task 1).
- Produces:
  - `state.requestedService` — `'private' | 'chauffeur' | 'both' | null`
  - `setRequestedService(v)` — sets it, marks dirty, re-renders
  - DOM: `[data-action="setRequestedService"][data-req="<value>"]`, container `.ch-req-choose`

- [ ] **Step 1: Write the failing shell test**

Append to `api/src/routes/opsUi.test.ts`:

```ts
it('renders the "Customer asked for" control, unselected by default (spec 2026-07-17)', async () => {
  const body = await (await createApp().request('/ops')).text();
  expect(body).toContain('Customer asked for');
  expect(body).toContain('data-action="setRequestedService"');
  expect(body).toContain('data-req="private"');
  expect(body).toContain('data-req="chauffeur"');
  expect(body).toContain('data-req="both"');
  // I4: never derived from the priced service.
  expect(body).toContain('requestedService: null');
  // It must ride in the save payload and restore on reopen.
  expect(body).toContain('requestedService: state.requestedService');
  expect(body).toContain('tool.requestedService');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd api && npx vitest run src/routes/opsUi.test.ts`
Expected: FAIL — "Customer asked for" is not in the body.

- [ ] **Step 3: Add state + setter**

`api/src/routes/ops-ui.html` — in the state object (near `service: 'private',` at ~2039), add:

```js
  requestedService: null,
```

Add the setter next to `setService` (after its closing brace):

```js
/* Quote intent (spec 2026-07-17): what the CUSTOMER asked for, recorded by the submitter.
   Independent of state.service (what we priced) — never derived from it (I4). Choosing
   'both' switches the chauffeur upsell on (I9); see toggleChauffeurUpsell for the override. */
function setRequestedService(v) {
  if (v !== 'private' && v !== 'chauffeur' && v !== 'both') return;
  if (state.requestedService === v) return;
  state.requestedService = v;
  _dirty = true;
  render();
}
```

- [ ] **Step 4: Reset it on new, send it on save, restore it on reopen**

In `startNew`'s reset block (~2300, beside `service: 'private',`):

```js
    requestedService: null,
```

In the save payload builder (~2340, beside `service: state.service || 'private',`):

```js
    requestedService: state.requestedService,
```

In `reopenQuote`'s tool restore (~2472, beside the `state.service = ...` line):

```js
  state.requestedService = (tool.requestedService === 'private' || tool.requestedService === 'chauffeur' || tool.requestedService === 'both')
    ? tool.requestedService : null;
```

- [ ] **Step 5: Render the control**

In the service-chooser render function, immediately AFTER the `parts.push('</div>');` that closes `.ch-svc-choose` and before the chauffeur caption block:

```js
  // Quote intent (spec 2026-07-17). Separate from the chooser above: that picks what we PRICE,
  // this records what the customer ASKED FOR. Starts unselected — no pre-fill (I4).
  var reqOpts = [['private', 'Point-to-point'], ['chauffeur', 'Chauffeur-guide'], ['both', 'Both']];
  parts.push('<div class="ch-req-choose">');
  parts.push('  <span class="ch-req-lbl">Customer asked for</span>');
  for (var i = 0; i < reqOpts.length; i++) {
    var rv = reqOpts[i][0];
    parts.push('  <button class="ch-req-chip' + (state.requestedService === rv ? ' active' : '') + '"'
      + ' data-action="setRequestedService" data-req="' + rv + '">' + esc(reqOpts[i][1]) + '</button>');
  }
  parts.push('</div>');
```

Add the CSS beside the existing `.qv .ch-svc-*` rules:

```css
  .qv .ch-req-choose { display: flex; align-items: center; gap: 8px; padding: 0 16px 12px; flex-wrap: wrap; }
  .qv .ch-req-lbl { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .4px; }
  .qv .ch-req-chip { border: 1.5px solid var(--line); background: #fff; border-radius: 999px; padding: 4px 12px; font-size: 12px; font-family: var(--sans); color: var(--muted); cursor: pointer; transition: border-color .15s, background .15s, color .15s; }
  .qv .ch-req-chip:hover:not(.active) { border-color: var(--muted-2); }
  .qv .ch-req-chip.active { border-color: var(--teal); background: rgba(10,185,182,.06); color: var(--teal-d); font-weight: 600; }
```

Wire the action into the builder's click dispatcher, beside the existing `setService` case:

```js
    case 'setRequestedService': setRequestedService(el.dataset.req); break;
```

> Match the surrounding dispatcher's style — if it uses `if (action === '...')` rather than a `switch`, follow that instead.

- [ ] **Step 6: Run it to see it pass**

Run: `cd api && npx vitest run src/routes/opsUi.test.ts`
Expected: PASS.

- [ ] **Step 7: Full gate + commit**

Run: `cd api && npm run check`

```bash
git add api/src/routes/ops-ui.html api/src/routes/opsUi.test.ts
git commit -m "feat(ops): record what the customer asked for in the quote builder"
```

---

### Task 4: `both` switches the chauffeur upsell on (I9)

**Files:**
- Modify: `api/src/routes/ops-ui.html` — `setRequestedService`
- Test: `api/src/routes/opsUi.test.ts`

**Interfaces:**
- Consumes: `setRequestedService` (Task 3), `outputIncludeChauffeurUpsell` (existing, declared ~3069).
- Produces: no new API.

- [ ] **Step 1: Write the failing test**

Append to `api/src/routes/opsUi.test.ts`:

```ts
it("recording 'both' switches the chauffeur upsell on so the second price can't be forgotten (I9)", async () => {
  const body = await (await createApp().request('/ops')).text();
  expect(body).toContain("if (v === 'both') outputIncludeChauffeurUpsell = true;");
  // Still overridable: the manual toggle must survive.
  expect(body).toContain("data-action=\"toggleChauffeurUpsell\"");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd api && npx vitest run src/routes/opsUi.test.ts`
Expected: FAIL — the string is absent.

- [ ] **Step 3: Implement**

In `setRequestedService`, after `state.requestedService = v;`:

```js
  // I9: 'both' means the customer wants to see both prices. The chauffeur option lives in a
  // separate Output-tab toggle, and leaving them decoupled means recording 'both' and then
  // sending one price because that toggle was forgotten. Default it on; still overridable.
  if (v === 'both') outputIncludeChauffeurUpsell = true;
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd api && npx vitest run src/routes/opsUi.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

Run: `cd api && npm run check`

```bash
git add api/src/routes/ops-ui.html api/src/routes/opsUi.test.ts
git commit -m "feat(ops): recording 'both' defaults the chauffeur option on"
```

---

### Task 5: The mismatch signal (I8/I10)

**Files:**
- Modify: `api/src/routes/ops-ui.html` — add `requestMismatch()` + render its line
- Test: `api/src/routes/opsUi.test.ts`

**Interfaces:**
- Consumes: `state.requestedService` (Task 3), `state.service` (existing).
- Produces: `requestMismatch(requested, priced)` → `string | null` (the message, or null when consistent).

- [ ] **Step 1: Write the failing table-driven test**

First extend the vitest import at the top of `api/src/routes/opsUi.test.ts` — the file currently imports only `{ describe, it, expect }`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
```

Then append. This extracts the pure function out of the inlined shell script and exercises it directly — the function has no DOM dependency, so it runs standalone:

```ts
// requestMismatch is pure and DOM-free, so we can lift it out of the inlined shell script and
// table-test all six (recorded, priced) combinations cheaply — an e2e per row would be absurd.
function loadRequestMismatch(body: string): (r: string | null, p: string) => string | null {
  const start = body.indexOf('function requestMismatch(');
  expect(start).toBeGreaterThan(-1);
  let depth = 0; let i = body.indexOf('{', start); const open = i;
  for (; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) break;
  }
  const src = body.slice(start, i + 1);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return requestMismatch;`)();
}

describe('requestMismatch (spec 2026-07-17, I8/I10)', () => {
  let f: (r: string | null, p: string) => string | null;
  beforeAll(async () => { f = loadRequestMismatch(await (await createApp().request('/ops')).text()); });

  it('is silent when nothing is recorded yet', () => {
    expect(f(null, 'private')).toBeNull();
  });
  it('is silent when the record matches what was priced', () => {
    expect(f('private', 'private')).toBeNull();
    expect(f('chauffeur', 'chauffeur')).toBeNull();
  });
  it("is silent for 'both' on a point-to-point quote — the upsell carries the second price", () => {
    expect(f('both', 'private')).toBeNull();
  });
  it('flags a recorded point-to-point priced as chauffeur', () => {
    expect(f('private', 'chauffeur')).toMatch(/Point-to-point/);
  });
  it('flags a recorded chauffeur priced as point-to-point', () => {
    expect(f('chauffeur', 'private')).toMatch(/Chauffeur-guide/);
  });
  it("flags 'both' on a chauffeur quote — the upsell is one-directional, so it cannot show both (I10)", () => {
    expect(f('both', 'chauffeur')).toMatch(/point-to-point/i);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd api && npx vitest run src/routes/opsUi.test.ts -t requestMismatch`
Expected: FAIL — `requestMismatch(` is not found in the body (the `expect(start).toBeGreaterThan(-1)` assertion).

- [ ] **Step 3: Implement the function**

In `api/src/routes/ops-ui.html`, beside `setRequestedService`:

```js
/* Quote intent (spec 2026-07-17, I8). Returns a message when the quote does not express what
   the customer asked for, else null. Signal only — never blocks (the reviewer decides).
   The 'both'+chauffeur row exists because the upsell is ONE-DIRECTIONAL (I10):
   appendChauffeurUpsell() adds a chauffeur total to a point-to-point message, and there is no
   "add point-to-point option" counterpart — so a chauffeur-priced quote structurally cannot
   show both prices. */
function requestMismatch(requested, priced) {
  if (!requested) return null;
  if (requested === 'both') {
    return priced === 'private' ? null
      : "Customer asked for both — a chauffeur-priced quote can't carry the point-to-point price. Price it point-to-point and add the chauffeur option.";
  }
  if (requested === priced) return null;
  return requested === 'private'
    ? 'Customer asked for Point-to-point — this quote is priced Chauffeur-guide.'
    : 'Customer asked for Chauffeur-guide — this quote is priced Point-to-point.';
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd api && npx vitest run src/routes/opsUi.test.ts -t requestMismatch`
Expected: PASS.

- [ ] **Step 5: Render the line**

In the service-chooser render, directly after the `.ch-req-choose` block from Task 3:

```js
  var _mm = requestMismatch(state.requestedService, state.service);
  if (_mm) parts.push('<div class="ch-req-mismatch">' + esc(_mm) + '</div>');
```

CSS beside the other `.ch-req-*` rules:

```css
  .qv .ch-req-mismatch { margin: -4px 16px 12px; padding: 7px 10px; border-radius: var(--r-sm); background: rgba(214,138,42,.09); border: 1px solid rgba(214,138,42,.28); color: #8a5a12; font-size: 11.5px; line-height: 1.35; font-weight: 500; }
```

> If `--r-sm` is not a token in this file, use the nearest existing radius token (check the `.qv` block).

- [ ] **Step 6: Add the render assertion**

Append to the same `opsUi.test.ts` describe:

```ts
it('renders the mismatch line from the live state', async () => {
  const body = await (await createApp().request('/ops')).text();
  expect(body).toContain('requestMismatch(state.requestedService, state.service)');
  expect(body).toContain('ch-req-mismatch');
});
```

- [ ] **Step 7: Full gate + commit**

Run: `cd api && npm run check`

```bash
git add api/src/routes/ops-ui.html api/src/routes/opsUi.test.ts
git commit -m "feat(ops): flag when a quote doesn't match what the customer asked for"
```

---

### Task 6: Disable Submit until it's recorded + surface the 400

**Files:**
- Modify: `api/src/routes/ops-ui.html` — the action-bar builder (~3626/3631) and `transition()`'s error path
- Test: `api/src/routes/opsUi.test.ts`, `web-tests/e2e/quote-approval.spec.js`

**Interfaces:**
- Consumes: `state.requestedService` (Task 3), the server's `requested_service_required` (Task 2).
- Produces: no new API.

- [ ] **Step 1: Write the failing test**

Append to `api/src/routes/opsUi.test.ts`:

```ts
it('disables Submit for review until the customer request is recorded (client mirror of the server gate)', async () => {
  const body = await (await createApp().request('/ops')).text();
  expect(body).toContain('!state.requestedService');
  expect(body).toContain('Record what the customer asked for first');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd api && npx vitest run src/routes/opsUi.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In the action-bar builder, the `B(...)` helper builds each button. Gate the two submit/approve buttons: where `submitForReview` and `approveReady` buttons are pushed (~3626 and ~3631), disable them and add a title when `!state.requestedService`.

Read the local `B()` signature first and follow it. If `B(action, label, cls)` has no disabled/title parameter, extend it minimally:

```js
  var _needReq = !state.requestedService;
  var _reqHint = 'Record what the customer asked for first';
```

and pass `_needReq` / `_reqHint` into the `submitForReview` and `approveReady` buttons only — leave `SAVE` always enabled (saving work-in-progress is never gated).

In `transition()`'s failure handling, map the server error so a bypassed client still explains itself:

```js
      if (err && err.error === 'requested_service_required') { toast('Record what the customer asked for first'); return; }
```

> Match the existing error-handling shape in `transition()` — if it reads `err.message` rather than `err.error`, follow that.

- [ ] **Step 4: Run it to see it pass**

Run: `cd api && npx vitest run src/routes/opsUi.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the e2e**

Append to `web-tests/e2e/quote-approval.spec.js`, following that file's existing setup:

```js
test('Submit for review is blocked until the customer request is recorded', async ({ page }) => {
  // Build a fresh draft, then assert Submit is unavailable until the chip is chosen.
  await expect(page.locator('[data-action="submitForReview"]')).toBeDisabled();
  await page.locator('[data-action="setRequestedService"][data-req="private"]').click();
  await expect(page.locator('[data-action="submitForReview"]')).toBeEnabled();
});
```

> This spec file's harness decides how a draft gets on screen — reuse it. If `quote-approval.spec.js` is an offline/stubbed spec and cannot build a draft, put this in `web-tests/e2e/quote-tool.spec.js` (CH_E2E_API) instead and follow that file's login + new-quote flow.

- [ ] **Step 6: Run both gates + commit**

Run: `cd api && npm run check`
Run: `cd web-tests && npm run test:all`

> `CH_E2E_API` specs need port 8787 free; `web-tests/global-setup.js` will name the owner if something else holds it.

```bash
git add api/src/routes/ops-ui.html api/src/routes/opsUi.test.ts web-tests/e2e/
git commit -m "feat(ops): block submit until the customer request is recorded"
```

---

### Task 7: Verify in the real app + open the PR

- [ ] **Step 1: Apply the migration locally**

Run: `cd api && npm run migrate`
Expected: `0017` applies. (Local dev never auto-migrates — only Render does, on boot.)

- [ ] **Step 2: Drive it end-to-end**

Use the `verify` skill, or boot the shell and drive it:
`cd api && PORT=8799 npm run dev`, open `http://localhost:8799/ops`, dev-login as founder.

Confirm, in the browser:
1. A new quote shows "Customer asked for" with nothing selected.
2. Submit for review is disabled; its title names the reason.
3. Choosing Point-to-point enables Submit.
4. Choosing Chauffeur-guide while the quote is priced point-to-point shows the mismatch line.
5. Choosing Both turns the Output tab's "Add chauffeur-guide option" on, and it can be turned back off.
6. Save, reopen the quote from the queue — the recorded value is still there.
7. Screenshot the control + mismatch line for the PR.

- [ ] **Step 3: Open the PR**

Body must include: the red→green evidence per CLAUDE.md rule 2, a link to the spec, the screenshot, and — prominently — **"Ships migration 0017 (`quotes.requested_service`). Merging applies it to prod on Render boot (fail-closed)."**

---

## Notes for the implementer

- **Do not gate `POST /save`.** Only `PATCH → pending_review|ready` (I3). A half-transcribed quote must stay savable.
- **Do not pre-fill the control** from `state.service` (I4). That is the whole point.
- **Do not add** price-box markers, a header line, or a queue pill (I6). The owner explicitly declined them: *"It's not about the eye landing. It's about the quote reviewer knowing which options to focus on."* The mismatch line is the one sanctioned exception.
- **The mismatch never blocks** (I8).
- If a pre-existing test breaks because a fixture submits a draft with no recorded request, **fix the fixture, not the gate** — that test is now asserting a workflow that no longer exists.
