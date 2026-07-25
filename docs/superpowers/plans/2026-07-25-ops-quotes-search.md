# Ops Quotes Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a search box to the `/ops` Quotes queue that matches customer name, quote reference, and trip route, flattening the queue into a single result list while a query is active.

**Architecture:** The queue already ships every ops quote to the browser, so filtering is client-side and instant. The only backend change is one derived field — `routeText` — added to the `/admin/quote/list` projection, because route names live inside `request_json.legs[]` and are not otherwise sent. One shared pure function derives that text for both the Postgres and in-memory repos.

**Tech Stack:** TypeScript + Hono + Drizzle (backend, `api/`), vanilla JS in a single HTML file (`api/src/routes/ops-ui.html`), Vitest (unit, both suites), Playwright (e2e, `web-tests/`).

**Spec:** `docs/superpowers/specs/2026-07-25-ops-quotes-search-design.md`

## Global Constraints

- **No database migration.** Route text is derived per request, never stored (spec D5). Do not add a column, do not write a `.sql` file in `api/drizzle/`.
- **Only one new CSS rule** is permitted, the mobile media query in Task 5. Everything else reuses existing classes (`.search`, `.qsection`, `.qsection-head`, `.qlist`, `.qempty`, `.qfilter`).
- **No `type="search"` and no `aria-live` region** (spec D8). The input is a plain `<input>` with `aria-label="Search quotes"`.
- **The place separator is exactly `' · '`** (space, U+00B7 middle dot, space) on both the backend and the front-end. They are split/joined independently and must agree.
- **Never rebuild the topbar while the search input exists** — that is the bug the Bookings search works around at `ops-ui.html:2285`, and avoiding it is the point.
- **Stage files by path.** The main checkout is shared with other sessions; never `git add -A`.
- Branch `feat/ops-quotes-search` in worktree `.claude/worktrees/quotes-search`, already cut from `origin/main` @ 7047afb.

## File Structure

| File | Responsibility |
|------|----------------|
| `api/src/db/quoteRouteText.ts` | **Create.** The pure route-text derivation, shared by both repos. No imports, no I/O. |
| `api/src/db/quoteRouteText.test.ts` | **Create.** Unit tests for the above — the load-bearing coverage, no DB needed. |
| `api/src/db/quoteRepo.ts` | **Modify.** Add `routeText` to `QuoteSummary`; derive it in `toSummary`. |
| `api/src/db/postgresQuoteRepo.ts` | **Modify.** Select `request_json->'legs'` in `list()` and derive `routeText`. |
| `api/src/routes/internalQuote.test.ts` | **Modify.** Assert `/admin/quote/list` carries `routeText`. |
| `api/src/db/postgres.test.ts` | **Modify.** Postgres-side plumbing assertion (skipped without `DATABASE_URL_TEST`). |
| `api/src/routes/ops-ui.html` | **Modify.** Search box, flat results, match-aware row route, one CSS rule. |
| `web-tests/unit/ops-quote-search.test.js` | **Create.** Unit tests for the two extracted front-end helpers. |
| `web-tests/e2e/ops-quote-search.spec.js` | **Create.** End-to-end: type → flatten → matched place visible → clear. |

---

### Task 1: `quoteRouteText` — the shared derivation

**Files:**
- Create: `api/src/db/quoteRouteText.ts`
- Test: `api/src/db/quoteRouteText.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `quoteRouteText(legs: unknown): string | null` and `requestLegs(request: unknown): unknown`, both used by Task 2.

- [ ] **Step 1: Write the failing test**

Create `api/src/db/quoteRouteText.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { quoteRouteText, requestLegs } from './quoteRouteText';

describe('quoteRouteText', () => {
  it('renders a point-to-point leg', () => {
    expect(quoteRouteText([{ from: 'Colombo', to: 'Galle' }])).toBe('Colombo · Galle');
  });

  it('collapses the handoff place between consecutive legs', () => {
    expect(quoteRouteText([
      { from: 'Colombo', to: 'Kandy' },
      { from: 'Kandy', to: 'Ella' },
    ])).toBe('Colombo · Kandy · Ella');
  });

  it('uses the full stop chain on a multi-stop leg', () => {
    expect(quoteRouteText([
      { from: 'Colombo', to: 'Ella', stops: ['Colombo', 'Kandy', 'Ella'] },
    ])).toBe('Colombo · Kandy · Ella');
  });

  it('keeps a genuine return to the same place', () => {
    expect(quoteRouteText([
      { from: 'Colombo', to: 'Kandy' },
      { from: 'Kandy', to: 'Colombo' },
    ])).toBe('Colombo · Kandy · Colombo');
  });

  it('renders a stay day as its single place', () => {
    expect(quoteRouteText([{ from: 'Kandy', to: 'Kandy', category: 'stay_day' }])).toBe('Kandy');
  });

  it('ignores blank and whitespace-only places', () => {
    expect(quoteRouteText([{ from: '   ', to: 'Galle' }])).toBe('Galle');
  });

  it('returns null when there is nothing usable', () => {
    expect(quoteRouteText(undefined)).toBeNull();
    expect(quoteRouteText([])).toBeNull();
    expect(quoteRouteText('not-an-array')).toBeNull();
    expect(quoteRouteText([null, 5])).toBeNull();
  });

  it('never throws on a malformed request', () => {
    expect(() => quoteRouteText([{ from: 5, to: {} }, { stops: 'nope' }])).not.toThrow();
    expect(quoteRouteText([{ from: 5, to: {} }, { stops: 'nope' }])).toBeNull();
  });
});

describe('requestLegs', () => {
  it('pulls legs out of the saved { tool, engine } envelope', () => {
    expect(requestLegs({ tool: { legs: [{ from: 'A', to: 'B' }] }, engine: {} }))
      .toEqual([{ from: 'A', to: 'B' }]);
  });

  it('falls back to top-level legs for a bare request', () => {
    expect(requestLegs({ legs: [{ from: 'A', to: 'B' }] })).toEqual([{ from: 'A', to: 'B' }]);
  });

  it('returns undefined for a non-object request', () => {
    expect(requestLegs(null)).toBeUndefined();
    expect(requestLegs('x')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/db/quoteRouteText.test.ts`
Expected: FAIL — `Failed to resolve import "./quoteRouteText"`.

- [ ] **Step 3: Write minimal implementation**

Create `api/src/db/quoteRouteText.ts`:

```ts
// Route text for the ops Quotes queue search (spec 2026-07-25 §1). Route names live only
// inside quotes.request_json.legs[] — there are no from/to columns — so the list projection
// derives this string instead of storing it (spec D5: no migration for a search box).
//
// ONE implementation, used by both the Postgres and in-memory repos, so the two can never
// disagree about what a quote's route says.
//
// The separator is load-bearing: ops-ui.html's quoteRouteWindow() splits on this exact
// string to window the route around a search match. Change one, change both.
const SEP = ' · ';

// Safely pull `legs` off a stored request_json blob. Everything about that blob is untrusted:
// it round-trips through the DB and predates several schema revisions.
export function requestLegs(request: unknown): unknown {
  if (!request || typeof request !== 'object') return undefined;
  const r = request as { tool?: unknown; legs?: unknown };
  // POST /save persists `{ tool, engine }` — "V19: persist the reopenable tool payload
  // alongside the engine request" (internalQuote.ts) — so the place names as the operator
  // typed or picked them live at request.tool.legs, NOT at the top level. Rows written before
  // that change, and repo-level callers that pass a bare request, keep legs at the top; fall
  // back rather than silently lose their route.
  if (r.tool && typeof r.tool === 'object') {
    const legs = (r.tool as { legs?: unknown }).legs;
    if (legs !== undefined) return legs;
  }
  return r.legs;
}

export function quoteRouteText(legs: unknown): string | null {
  if (!Array.isArray(legs)) return null;
  const places: string[] = [];
  for (const leg of legs) {
    if (!leg || typeof leg !== 'object') continue;
    const l = leg as { from?: unknown; to?: unknown; stops?: unknown };
    // `stops` is the full ordered chain when present (from/to are its first/last), so
    // preferring it avoids emitting the endpoints twice.
    const chain = Array.isArray(l.stops) ? l.stops : [l.from, l.to];
    for (const raw of chain) {
      if (typeof raw !== 'string') continue;
      const place = raw.trim();
      if (!place) continue;
      // Leg N's `to` is normally leg N+1's `from`. Collapse only that CONSECUTIVE repeat —
      // a trip that genuinely returns to Colombo later should still say so.
      if (places.length && places[places.length - 1].toLowerCase() === place.toLowerCase()) continue;
      places.push(place);
    }
  }
  return places.length ? places.join(SEP) : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/db/quoteRouteText.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add api/src/db/quoteRouteText.ts api/src/db/quoteRouteText.test.ts
git commit -m "feat(quotes): derive route text from a quote's legs"
```

---

### Task 2: Put `routeText` on the list projection

**Files:**
- Modify: `api/src/db/quoteRepo.ts` (the `QuoteSummary` interface ~line 96, `toSummary` ~line 225)
- Modify: `api/src/db/postgresQuoteRepo.ts` (`list()` ~line 181)
- Modify: `api/src/routes/internalQuote.test.ts`
- Modify: `api/src/db/postgres.test.ts`

**Interfaces:**
- Consumes: `quoteRouteText`, `requestLegs` from Task 1.
- Produces: `QuoteSummary.routeText: string | null`, present on every row of `GET /admin/quote/list`. Task 3 and Task 4 rely on this field name.

- [ ] **Step 1: Write the failing test**

Append to `api/src/routes/internalQuote.test.ts`, inside the existing
`describe('internal quoting tool route', ...)` block. This uses the file's existing `createApp`,
`post`, `authedGet`, and `leg` helpers — do not introduce new ones:

```ts
  it('carries routeText on every list row so the queue can search by route', async () => {
    const app = createApp();
    await post(app, '/admin/quote/save', {
      name: 'Maya', vehicle: 'car', passengerCount: 2, luggageCount: 2, requestedService: 'private',
      legs: [
        leg({ from: 'Colombo', to: 'Kandy', distanceKm: 120 }),
        leg({ from: 'Kandy', to: 'Ella', distanceKm: 140 }),
      ],
    });
    const list = await (await authedGet(app, '/admin/quote/list')).json();
    // The handoff place (Kandy) appears once, not twice — and this proves the derivation
    // reaches into request.tool.legs, which is where /save actually puts them.
    expect(list.quotes[0].routeText).toBe('Colombo · Kandy · Ella');
  });
```

Append to `api/src/db/postgres.test.ts`, inside the existing `describe.skipIf(!TEST_URL)` block,
using its module-scoped `quotes` repo handle:

```ts
  it('derives routeText from request_json legs in the list projection', async () => {
    const saved = await quotes.save({
      product: 'private', vehicle: 'car', totalCents: 12100, currency: 'USD',
      rateCardVersion: 'test',
      request: { tool: { legs: [{ from: 'Colombo', to: 'Kandy' }, { from: 'Kandy', to: 'Ella' }] } },
      result: {},
    });
    const listed = await quotes.list({});
    expect(listed.find((r) => r.id === saved.id)?.routeText).toBe('Colombo · Kandy · Ella');
  });
```

> This test does **not** run in default CI (gated on `DATABASE_URL_TEST`) — a known, accepted gap
> recorded in the spec. It exists so the Postgres plumbing is provable when a DB is available.
> Note the neighbouring test at `postgres.test.ts:262` saves a **bare** `request: { legs: [...] }`
> with no `tool` envelope, so the fallback in `requestLegs` and the SQL `COALESCE` below are both
> exercised by the existing fixtures — they are not speculative.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t routeText`
Expected: FAIL — `expected undefined to be 'Colombo · Kandy · Ella'`.

- [ ] **Step 3: Write minimal implementation**

In `api/src/db/quoteRepo.ts`, add the import at the top of the file:

```ts
import { quoteRouteText, requestLegs } from './quoteRouteText';
```

Add the field to `QuoteSummary` (after `assignedTo`, before `createdAt`):

```ts
  // Trip places, joined for the queue's search (spec 2026-07-25). Derived per request from
  // request_json.legs — NOT a stored column. Null when a quote has no usable legs.
  routeText: string | null;
```

Add it to `toSummary`:

```ts
    routeText: quoteRouteText(requestLegs(q.request)),
```

In `api/src/db/postgresQuoteRepo.ts` — `sql` is already imported — add to the `list()` select
object, after `createdAt`:

```ts
        // The legs sub-document only: enough to derive routeText without shipping request_json's
        // other fields. Legs are most of that blob by size, so this is bounded by the row count,
        // not by the projection — see the spec's cost note and D5's revisit trigger.
        // COALESCE because /save writes `{ tool, engine }` while older rows (and repo-level
        // callers) put legs at the top level. Mirrors requestLegs() — change one, change both.
        legs: sql<unknown>`COALESCE(${quotes.requestJson}->'tool'->'legs', ${quotes.requestJson}->'legs')`,
```

and to the returned object mapping, after `createdAt: r.createdAt,`:

```ts
      routeText: quoteRouteText(r.legs),
```

with the import at the top of the file:

```ts
import { quoteRouteText } from './quoteRouteText';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && npm run typecheck && npx vitest run src/routes/internalQuote.test.ts`
Expected: typecheck clean, all tests PASS.

Run the whole suite to catch any other construction of a `QuoteSummary`:

Run: `cd api && npm test`
Expected: PASS. If TypeScript reports a missing `routeText` anywhere, add it there rather than making the field optional — every summary must carry it.

- [ ] **Step 5: Commit**

```bash
git add api/src/db/quoteRepo.ts api/src/db/postgresQuoteRepo.ts api/src/routes/internalQuote.test.ts api/src/db/postgres.test.ts
git commit -m "feat(quotes): ship routeText on the quote list projection"
```

---

### Task 3: Front-end search helpers

**Files:**
- Modify: `api/src/routes/ops-ui.html` (add two functions immediately after `quoteUsdWhole`, ~line 1643)
- Test: `web-tests/unit/ops-quote-search.test.js`

**Interfaces:**
- Consumes: `QuoteSummary.routeText` from Task 2.
- Produces: `quoteMatches(q, row) -> boolean` and `quoteRouteWindow(routeText, q) -> string`, both used by Tasks 4 and 5.

Both functions MUST be self-contained (no DOM, no module state) and formatted with their closing
brace in column 0, because the unit test extracts them from the HTML by source regex and evals
them — the same trick as `web-tests/unit/ops-route-choice-trigger.test.js`.

- [ ] **Step 1: Write the failing test**

Create `web-tests/unit/ops-quote-search.test.js`:

```js
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// quoteMatches and quoteRouteWindow are self-contained (no DOM, no state) inside ops-ui.html —
// extract them by source markers and eval, same trick as ops-route-choice-trigger.test.js.
function loadFn(signature) {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const re = new RegExp('function ' + signature.replace(/[()]/g, '\\$&') + ' \\{[\\s\\S]*?\\n\\}');
  const m = html.match(re);
  if (!m) throw new Error(signature + ' not found in ops-ui.html');
  // eslint-disable-next-line no-new-func
  return new Function('return (' + m[0] + ')')();
}
const quoteMatches = loadFn('quoteMatches(q, row)');
const quoteRouteWindow = loadFn('quoteRouteWindow(routeText, q)');

const row = (o) => ({ customerName: 'Sonja', reference: 'Q-9VUHS', routeText: 'Colombo · Galle', ...o });

describe('quoteMatches', () => {
  it('matches on customer name, case-insensitively', () => {
    expect(quoteMatches('SONJA', row())).toBe(true);
  });
  it('matches on reference', () => {
    expect(quoteMatches('9vuhs', row())).toBe(true);
  });
  it('matches on a place in the route', () => {
    expect(quoteMatches('galle', row())).toBe(true);
  });
  it('does not match an unrelated term', () => {
    expect(quoteMatches('kandy', row())).toBe(false);
  });
  it('matches everything on an empty or whitespace-only query', () => {
    expect(quoteMatches('', row())).toBe(true);
    expect(quoteMatches('   ', row())).toBe(true);
  });
  it('finds an unnamed draft by the label the row actually shows', () => {
    expect(quoteMatches('untitled', row({ customerName: null }))).toBe(true);
  });
  it('does NOT let the query "null" match a quote with null fields', () => {
    // Regression: a template literal would render null as the string "null" and match everything.
    expect(quoteMatches('null', row({ customerName: null, routeText: null }))).toBe(false);
  });
  it('survives a row with no route', () => {
    expect(quoteMatches('sonja', row({ routeText: null }))).toBe(true);
  });
});

describe('quoteRouteWindow', () => {
  it('windows from the matched place, marking the dropped prefix', () => {
    expect(quoteRouteWindow('Colombo Airport · Galle · Ella', 'ella')).toBe('… Ella');
  });
  it('keeps the whole route when the match is in the first place', () => {
    expect(quoteRouteWindow('Colombo Airport · Galle', 'colombo')).toBe('Colombo Airport · Galle');
  });
  it('keeps the whole route when nothing matches the route', () => {
    expect(quoteRouteWindow('Colombo · Galle', 'sonja')).toBe('Colombo · Galle');
  });
  it('keeps the whole route on an empty query', () => {
    expect(quoteRouteWindow('Colombo · Galle', '')).toBe('Colombo · Galle');
  });
  it('returns an empty string when there is no route', () => {
    expect(quoteRouteWindow(null, 'ella')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-tests && npx vitest run unit/ops-quote-search.test.js`
Expected: FAIL — `quoteMatches(q, row) not found in ops-ui.html`.

- [ ] **Step 3: Write minimal implementation**

In `api/src/routes/ops-ui.html`, immediately after the `quoteUsdWhole` function (~line 1643), add:

```js
/* ── Quotes queue search (spec 2026-07-25) ───────────────────────────────────
   Both helpers are deliberately self-contained — no DOM, no module state — so
   web-tests/unit can extract and eval them straight out of this file. */
function quoteMatches(q, row){
  const needle=(q||'').trim().toLowerCase();
  if(!needle)return true;
  if(!row)return false;
  /* Nullable fields are FILTERED OUT, never interpolated: `${null}` renders the string
     "null", which would make the query "null" match every quote lacking a route.
     customerName falls back to the label the row actually displays, so searching
     "untitled" finds unnamed drafts instead of silently matching nothing. */
  const hay=[row.customerName||'Untitled',row.reference,row.routeText]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(needle);
}
/* Render the route AROUND the match rather than from the start. .qprod is a 1fr grid cell
   with text-overflow:ellipsis, so a multi-leg route would otherwise ellipse the searched
   place out of view — the row would match on "Ella" and never say Ella. Windows on whole
   places, never mid-name. The separator must match quoteRouteText's SEP in
   api/src/db/quoteRouteText.ts. */
function quoteRouteWindow(routeText, q){
  if(!routeText)return '';
  const needle=(q||'').trim().toLowerCase();
  if(!needle)return routeText;
  const places=routeText.split(' · ');
  const i=places.findIndex(p=>p.toLowerCase().includes(needle));
  if(i<=0)return routeText;
  return '… '+places.slice(i).join(' · ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-tests && npx vitest run unit/ops-quote-search.test.js`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/ops-ui.html web-tests/unit/ops-quote-search.test.js
git commit -m "feat(ops): add quote search match + route-window helpers"
```

---

### Task 4: The search box, flat results, and empty states

**Files:**
- Modify: `api/src/routes/ops-ui.html` — `let queueFilter='all';` (line 1639), `viewQuotes()` (lines 1749–1806), and the keydown listener at line 2301.

**Interfaces:**
- Consumes: `quoteMatches` from Task 3; `routeText` from Task 2.
- Produces: module-level `quoteQuery` string and `renderQuotesTopbar()`. Task 5 relies on `viewQuotes` passing the trimmed query as the third argument to `quoteRowHtml`.

- [ ] **Step 1: Add the query state and the guarded topbar**

Change line 1639 from:

```js
let queueFilter='all';
```

to:

```js
let queueFilter='all';
let quoteQuery='';
/* The search input is rendered ONCE and never re-rendered. viewTickets rebuilds the whole
   topbar per keystroke and then re-focuses and restores the caret by hand (see the '#q'
   handler); that dance exists only because the input gets destroyed. Guarding here means
   the background refresh and the 2–3 async paints per view entry can't clobber it mid-type. */
function renderQuotesTopbar(){
  const tb=$('#topbar');
  if(tb.querySelector('#qq'))return;
  tb.innerHTML='<div class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>'
    +'<input id="qq" aria-label="Search quotes" placeholder="Search name, ref, route&hellip;" autocomplete="off" spellcheck="false"></div>';
  /* Re-entering Quotes from another view rebuilds the topbar from scratch; restore the query
     that survived in module state so the box and the list agree. */
  $('#qq').value=quoteQuery;
}
```

- [ ] **Step 2: Replace `viewQuotes()`**

Replace the whole function at lines 1749–1806 with:

```js
function viewQuotes(){
  renderQuotesTopbar();
  const query=quoteQuery.trim();
  const sections=isApprover()?QUEUE_SECTIONS_APPROVER:QUEUE_SECTIONS_SUPPORT;
  // "Assigned to me" is a PARTITION, not an overlay: a quote assigned to me is lifted out of
  // its status section rather than duplicated into two. The status sections already tile the
  // queue exactly once each (their status lists don't overlap), and a row appearing twice in
  // one list reads as a bug. The status pill on the row still says where it is in the flow.
  // Open states only — a sent/won/lost quote assigned to me is history, not work.
  const mineRows=opsQuotes.filter(q=>isMineEmail(q.assignedTo)&&MINE_STATUSES.includes(q.status));
  const mineIds=new Set(mineRows.map(q=>q.id));
  const byStatus={};opsQuotes.forEach(q=>{if(mineIds.has(q.id))return;(byStatus[q.status]=byStatus[q.status]||[]).push(q);});
  const activeFilter=QUEUE_FILTERS.find(f=>f.id===queueFilter)||QUEUE_FILTERS[0];
  const allowed=activeFilter.statuses?new Set(activeFilter.statuses):null;
  // Search results come from opsQuotes DIRECTLY — never from mineRows/byStatus, which partition
  // the queue between them and would duplicate or drop rows once flattened into one list.
  const hits=query?opsQuotes.filter(q=>quoteMatches(query,q)):[];
  const results=query&&allowed?hits.filter(q=>allowed.has(q.status)):hits;
  const sub=query
    ? `<b>${results.length} of ${opsQuotes.length} quote${opsQuotes.length===1?'':'s'} match</b>`
    : `<b>${opsQuotes.length} quote${opsQuotes.length===1?'':'s'}</b> · ${isApprover()?'review, approve, and track every quote':'submit new quotes and send approved ones to customers'}`;
  let html=`<div class="qhead pagehead">
      <h1>Quotes</h1>
      <button class="qnew" data-qnew><span class="qnew-plus">+</span> New quote</button>
    </div>
    <p class="pagesub">${sub}</p>`;
  if(!opsQuotesLoaded){html+='<p class="muted">Loading quotes…</p>';paintQuotesView(html);return;}
  if(!opsQuotes.length){
    html+=`<div class="qempty"><div class="qempty-icon">📝</div><div class="qempty-title">No quotes yet</div><div class="qempty-sub">Start one with <b>+ New quote</b> above.</div></div>`;
    paintQuotesView(html);return;
  }
  // Filter toggles (coarse status groups). Counts reflect the whole queue, not the section.
  html+='<div class="qfilters">'+QUEUE_FILTERS.map(f=>{
    const n=f.statuses?opsQuotes.filter(q=>f.statuses.includes(q.status)).length:opsQuotes.length;
    return `<button class="qfilter ${queueFilter===f.id?'on':''}" data-qfilter="${f.id}">${f.label}<span class="qfilter-n">${n}</span></button>`;
  }).join('')+'</div>';
  // Searching: one flat list. The role-aware sections are a triage device; a match buried in
  // the right section is still a scan.
  if(query){
    if(results.length){
      html+=`<div class="qsection qsec-results">
        <div class="qsection-head">
          <h2 class="qsection-title">Results<span class="qsection-count">${results.length}</span></h2>
        </div>
        <div class="qlist">${results.map(q=>quoteRowHtml(q,false,query)).join('')}</div>
      </div>`;
    }else if(hits.length){
      // The active chip is hiding every match. Say so — a filter you forgot was on is the
      // classic "where did it go" — and offer the one-click way out, reusing the existing
      // [data-qfilter] delegation so no new handler is needed.
      html+=`<div class="qempty"><div class="qempty-icon">🔍</div><div class="qempty-title">No match in ${activeFilter.label}</div><div class="qempty-sub">${hits.length} quote${hits.length===1?'':'s'} match under other statuses.</div><button class="qfilter" data-qfilter="all" style="margin-top:14px">Search all quotes</button></div>`;
    }else{
      html+=`<div class="qempty"><div class="qempty-icon">🔍</div><div class="qempty-title">No quotes match</div><div class="qempty-sub">Try a different name, reference, or route.</div></div>`;
    }
    paintQuotesView(html);return;
  }
  let rendered=0;
  const mineVisible=allowed?mineRows.filter(q=>allowed.has(q.status)):mineRows;
  if(mineVisible.length){
    rendered++;
    html+=`<div class="qsection qsec-mine">
      <div class="qsection-head">
        <h2 class="qsection-title">Assigned to me<span class="qsection-count">${mineVisible.length}</span></h2>
        <span class="qsection-hint">Handed to you — yours to move</span>
      </div>
      <div class="qlist">${mineVisible.map(q=>quoteRowHtml(q,true)).join('')}</div>
    </div>`;
  }
  sections.forEach(sec=>{
    const secStatuses=allowed?sec.statuses.filter(s=>allowed.has(s)):sec.statuses;
    const rows=secStatuses.reduce((acc,s)=>acc.concat(byStatus[s]||[]),[]);
    if(!rows.length)return;
    rendered++;
    html+=`<div class="qsection qsec-${sec.id}">
      <div class="qsection-head">
        <h2 class="qsection-title">${sec.label}<span class="qsection-count">${rows.length}</span></h2>
        ${sec.hint?`<span class="qsection-hint">${sec.hint}</span>`:''}
      </div>
      <div class="qlist">${rows.map(q=>quoteRowHtml(q)).join('')}</div>
    </div>`;
  });
  if(!rendered)html+=`<div class="qempty"><div class="qempty-title">No quotes in this filter</div><div class="qempty-sub">Try a different toggle above.</div></div>`;
  paintQuotesView(html);
}
```

- [ ] **Step 3: Wire the input and Escape**

Immediately **before** the existing line `document.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.detail){...}});` (line 2301), insert:

```js
/* Quotes search. Repaints only #view — never the topbar — so the input keeps focus and caret
   with no restoration hack (contrast the '#q' handler above). */
document.addEventListener('input',e=>{
  if(e.target.id!=='qq')return;
  quoteQuery=e.target.value;
  viewQuotes();
});
/* Escape clears the box. Registered BEFORE the detail-sheet Escape handler below and using
   stopImmediatePropagation, because both listeners sit on `document` — plain stopPropagation
   would not stop a sibling listener on the same node. An already-empty box passes Escape
   through so it can still close whatever is behind. (The ⌘K bar returns early when hidden,
   so it is not in play here.) */
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape'||e.target.id!=='qq'||!e.target.value)return;
  e.stopImmediatePropagation();
  e.target.value='';
  quoteQuery='';
  viewQuotes();
});
```

- [ ] **Step 4: Verify by hand in the browser**

Run: `cd api && npm run dev`, open `/ops`, sign in, land on Quotes.

Expected:
- A search box appears top-left with placeholder `Search name, ref, route…`.
- Typing a customer name collapses the sections into one **Results** block; the subhead reads `N of M quotes match`.
- The caret never jumps and focus never drops, including while the background booking refresh runs.
- Selecting a chip that excludes every match shows *"No match in <chip>"* plus a working **Search all quotes** button.
- Escape clears the box and the grouped queue returns unchanged.

- [ ] **Step 5: Run the existing suites for regressions**

Run: `cd api && npm test && cd ../web-tests && npx vitest run`
Expected: PASS, no new failures.

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/ops-ui.html
git commit -m "feat(ops): search the Quotes queue by name, ref, and route"
```

---

### Task 5: Match-aware route on the row, visible on mobile

**Files:**
- Modify: `api/src/routes/ops-ui.html` — `quoteRowHtml` (lines 1720–1728) and the mobile media query (line 177).

**Interfaces:**
- Consumes: `quoteRouteWindow` from Task 3; the `query` third argument passed by Task 4.
- Produces: nothing downstream.

- [ ] **Step 1: Show the windowed route in the product cell**

Replace `quoteRowHtml` (lines 1720–1728) with:

```js
function quoteRowHtml(q,hideAssignee,query){
  /* While searching, the product cell carries the route instead — a row that matched on a
     place has to say which place. Windowed around the match because this cell ellipses. */
  const route=query?quoteRouteWindow(q.routeText,query):'';
  const prodHtml=route
    ? esc(route)
    : `${esc(q.product||'')}${q.vehicle?' · '+esc(q.vehicle):''}`;
  return `<div class="qrow${route?' qrow-searching':''}" data-qopen="${esc(q.id)}" role="button" tabindex="0" aria-label="Quote ${esc(q.reference||q.id)} — ${esc(q.customerName||'Untitled')}, ${esc((QSTATUS[q.status]||{}).label||q.status||'')}, ${esc(quoteUsd(q.totalCents))}">
    <span class="qref">${esc(q.reference||q.id)}</span>
    <span class="qcust">${esc(q.customerName||'Untitled')}</span>
    <span class="qprod">${prodHtml}</span>
    <span class="qtotal" title="${esc(quoteUsd(q.totalCents))}">${esc(quoteUsdWhole(q.totalCents))}</span>
    <span class="qstat">${hideAssignee?'':(q.assignedTo?assigneeChip(q.assignedTo):unassignedChip())}${quoteAgeChip(q)}${statusPill(q.status)}</span>
  </div>`;
}
```

- [ ] **Step 2: Un-hide the cell on mobile while searching**

Line 177 currently ends the mobile block with `.qrow .qprod{display:none}`. Immediately after
that entire `@media(max-width:640px){...}` rule, add one new rule:

```css
  /* Searching: .qprod carries the route, so it must survive the mobile hide above — as its own
     full-width line rather than a squeezed column. Only applied when there IS a route. */
  @media(max-width:640px){.qrow.qrow-searching .qprod{display:block;grid-column:1/-1}}
```

- [ ] **Step 3: Verify by hand, desktop and mobile**

Run: `cd api && npm run dev`, open `/ops` on Quotes.

Expected (desktop): searching a place shows that place in the row — e.g. searching `ella` on
`Colombo Airport · Galle · Ella` renders `… Ella`, not a truncated `Colombo Airp…`.
Expected (responsive mode, ≤640px): the route appears as its own full-width line under the row
while searching, and disappears when the box is cleared.
Expected: a quote with no route still shows `Private · Car` while searching.

- [ ] **Step 4: Run the suites**

Run: `cd web-tests && npx vitest run && cd ../api && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/ops-ui.html
git commit -m "feat(ops): show the matched place on searched quote rows"
```

---

### Task 6: End-to-end coverage

**Files:**
- Create: `web-tests/e2e/ops-quote-search.spec.js`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces: nothing.

- [ ] **Step 1: Write the test**

Create `web-tests/e2e/ops-quote-search.spec.js`:

```js
import { test, expect } from '@playwright/test';

// Search on the Quotes queue (spec 2026-07-25). The filter itself is unit-tested in
// web-tests/unit/ops-quote-search.test.js; this covers the wiring — flatten, matched place,
// the chip-mismatch escape hatch, and clearing back to the grouped queue.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const q = (o) => ({
  customerContact: null, currency: 'USD', assignedTo: null, vehicle: 'car', product: 'private', ...o,
});
const QUOTES = [
  q({ id: 'q1', reference: 'Q-AAAAA', status: 'ready', customerName: 'Sonja', totalCents: 10700,
      createdAt: '2026-07-20T00:00:00.000Z', routeText: 'Colombo Airport · Galle · Ella' }),
  q({ id: 'q2', reference: 'Q-BBBBB', status: 'draft', customerName: 'Nikolaj', totalCents: 11500,
      createdAt: '2026-07-19T00:00:00.000Z', routeText: 'Colombo · Kandy' }),
  q({ id: 'q3', reference: 'Q-CCCCC', status: 'sent', customerName: null, totalCents: 4500,
      createdAt: '2026-07-18T00:00:00.000Z', routeText: null }),
];

async function setup(page) {
  await page.addInitScript(() => { window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } } }; });
  await page.route('**/admin/**', (r) => r.fulfill(json({}))); // catch-all FIRST so the specific routes below win
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: QUOTES })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'f@e2e.test', role: 'founder', caps: ['quote:manage', 'quote:approve'] })));
  await page.goto(OPS_FILE + '#quotes');
  await page.waitForSelector('#view .qrow', { timeout: 10000 });
}

test('searching flattens the queue and shows the matched place', async ({ page }) => {
  await setup(page);
  await expect(page.locator('#view .qsection')).toHaveCount(3); // grouped: mine + status sections
  await expect(page.locator('#view .qrow')).toHaveCount(3);

  await page.fill('#qq', 'ella');

  await expect(page.locator('#view .qsec-results')).toHaveCount(1);
  await expect(page.locator('#view .qsection-title')).toHaveText(/^Results1$/);
  await expect(page.locator('#view .qrow')).toHaveCount(1);
  await expect(page.locator('#view .qrow .qprod')).toHaveText('… Ella');
  await expect(page.locator('#view .pagesub')).toContainText('1 of 3 quotes match');
});

test('an unnamed draft is findable by the label the row shows', async ({ page }) => {
  await setup(page);
  await page.fill('#qq', 'untitled');
  await expect(page.locator('#view .qrow')).toHaveCount(1);
  await expect(page.locator('#view .qrow .qcust')).toHaveText('Untitled');
});

test('a chip that hides every match says so and offers a way out', async ({ page }) => {
  await setup(page);
  await page.locator('#view [data-qfilter="progress"]').click(); // draft/pending/changes only
  await page.fill('#qq', 'ella');                                // q1 is 'ready'

  await expect(page.locator('#view .qempty-title')).toHaveText('No match in In progress');
  await expect(page.locator('#view .qempty-sub')).toContainText('1 quote match');

  await page.locator('#view .qempty [data-qfilter="all"]').click();
  await expect(page.locator('#view .qrow')).toHaveCount(1);
  await expect(page.locator('#qq')).toHaveValue('ella'); // the query survived the chip reset
});

test('Escape clears the box and restores the grouped queue', async ({ page }) => {
  await setup(page);
  await page.fill('#qq', 'ella');
  await expect(page.locator('#view .qrow')).toHaveCount(1);

  await page.locator('#qq').press('Escape');

  await expect(page.locator('#qq')).toHaveValue('');
  await expect(page.locator('#view .qsec-results')).toHaveCount(0);
  await expect(page.locator('#view .qrow')).toHaveCount(3);
});
```

- [ ] **Step 2: Run it**

Run: `cd web-tests && npx playwright test e2e/ops-quote-search.spec.js`
Expected: 4 passed.

The `toHaveCount(3)` on the grouped queue is exact, not a guess: `assignedTo` is null on all
three fixtures so "Assigned to me" does not render, and with `quote:approve` the approver
sections match one fixture each — `Ready to send` (q1, ready), `In progress` (q2, draft),
`Sent & closed` (q3, sent), while `Needs your review` has no `pending_review` row and is
skipped. If this count comes out different, something rendered wrong — investigate rather than
relax the assertion.

- [ ] **Step 3: Full suite**

Run: `cd api && npm run check && cd ../web-tests && npm run test:all`
Expected: typecheck clean, lint clean, all unit and e2e green.

- [ ] **Step 4: Commit and open the PR**

```bash
git add web-tests/e2e/ops-quote-search.spec.js
git commit -m "test(ops): e2e coverage for Quotes queue search"
git push -u origin feat/ops-quotes-search
gh pr create --base main --title "feat(ops): search the Quotes queue" --body "$(cat <<'EOF'
Adds a search box to the /ops Quotes queue — matches customer name, quote
reference, and trip route.

Spec: docs/superpowers/specs/2026-07-25-ops-quotes-search-design.md

- Backend: one derived `routeText` field on the /admin/quote/list projection.
  No migration — route text is derived per request (spec D5).
- Front-end: the sections flatten into one Results list while a query is
  active; a chip hiding every match says so and offers a one-click escape.
- Rows show the matched place, windowed so a multi-leg route doesn't ellipse
  the searched term out of view, and visible on mobile while searching.

Known gap, deliberate: the Postgres-side plumbing assertion lives in
postgres.test.ts, which is skipped without DATABASE_URL_TEST. `routeText` is
additive — a null degrades to "route not searchable", never a broken queue.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Post-merge

`main` auto-deploys to staging. The production promote (`main` → `production`) is a separate,
deliberate PR — do not open it as part of this work.
