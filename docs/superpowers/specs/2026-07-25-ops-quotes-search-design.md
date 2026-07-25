# Search on the ops Quotes queue — design

**Date:** 2026-07-25
**Status:** approved (owner, 2026-07-25); revised after self-critique, same day
**Surface:** `/ops` → Quotes (`api/src/routes/ops-ui.html`), `GET /admin/quote/list` (`api/src/routes/internalQuote.ts`)

## Problem

The Quotes queue has no search. The only way to narrow it is the coarse status chips
(All / In progress / Ready to send / Sent to customer). Finding "that quote for Sonja" or
"the Galle trip" means scanning the list by eye, and the list only grows.

Bookings already has search — a topbar box filtering on customer name, reference, and route
(`ops-ui.html`, `viewTickets`). Quotes should have the same affordance.

### What already exists (verified against `origin/main` @ 7047afb)

- `GET /admin/quote/list` returns **every** ops-channel quote (no limit, no pagination) with a
  narrow scalar projection: `id, reference, status, product, vehicle, customerName,
  customerContact, totalCents, currency, assignedTo, createdAt`.
- The whole list therefore already sits in the browser as `opsQuotes`. A client-side filter is
  free — no new fetch, no round-trip per keystroke.
- Route is **not** in that projection and there are no `from`/`to` columns on the `quotes`
  table. Route data lives only inside `request_json` as `{from, to, stops?}` per leg — and it is
  nested: `POST /save` persists `{ tool, engine }` ("V19: persist the reopenable tool payload
  alongside the engine request"), so the operator-entered place names are at
  **`request_json.tool.legs[]`**, not the top level. Rows written before that change, and
  repo-level callers, still carry `legs` at the top; both shapes are live in the fixtures today.
- The router applies a blanket `requireCap('quote:manage')` (`internalQuote.ts:503`), so
  everyone who can load the queue can already see every field on it.
- Bookings' equivalent search (`?q=`) exists server-side in `ops.ts` but the UI filters
  client-side; the server param is unused by the UI.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Per-page search box on Quotes, mirroring Bookings — not a global ⌘K search | Smallest footprint, matches the pattern already on the page next door. ⌘K stays a possible follow-up. |
| D2 | Match on customer name + reference + route | Parity with the Bookings search. Name and reference alone can't find "the Galle trip". |
| D3 | While a query is active, flatten the role-aware sections into one result list | Sections are a triage device; search is retrieval. A match buried in the right section is still a scan. |
| D4 | Status chips still narrow results, but a zero-here / matches-elsewhere case says so and offers a one-click escape | A chip silently hiding your match is the classic "where did it go" failure. |
| D5 | Route text is **derived per request**, not stored in a new column | A column would make `/list` cheaper and could grow into indexed server-side search — but it costs a migration, and migrations auto-apply on boot in prod and fail closed. That is a production risk taken on behalf of a search box, at 24 quotes, in maintenance mode. Nothing is lost by waiting: a real server-side search would need its own migration and index regardless. **If the queue reaches the thousands, adding a `route_text` column is the known next move.** |
| D6 | One shared JS derivation used by both repos — no parallel SQL implementation | A `string_agg` in Postgres plus a JS version for the in-memory repo would be two implementations of one rule, free to drift apart. |
| D7 | The in-row route is **match-aware**, and visible on mobile | A row that matched on route must show *why*. Rendering from the start of the route defeats that on exactly the multi-leg quotes that motivated it (see §3). |
| D8 | No `aria-live` region for the result count | The file contains no live region and no `sr-only` class today. Introducing both — plus the announcement debounce a per-keystroke count would require — is a new pattern for a search box. The visible count sits next to the input. |

## Design

### 1. Backend — `routeText` on the list projection

Add one field to `QuoteSummary` (`api/src/db/quoteRepo.ts`):

```ts
routeText: string | null;   // "Colombo Airport · Galle · Ella"
```

A pure exported function derives it:

```ts
export function quoteRouteText(legs: unknown): string | null
```

Rules:

- Walks `legs[]` in order. For each leg, takes `stops` when present (it is the full ordered
  chain, 2–8 entries), otherwise `[from, to]`.
- Drops empty/blank entries; collapses a place repeated **consecutively** (leg N's `to` is
  normally leg N+1's `from`) so a 3-leg trip reads `A · B · C · D`, not `A · B · B · C · C · D`.
  A place that genuinely recurs later (a loop back to Colombo) is kept — it is real.
- Returns `null` for no legs, a non-array, or nothing usable. A `stay_day` leg contributes its
  place like any other.
- Never throws on a malformed `request_json`: every field is treated as untrusted.

Repo wiring:

Both repos locate the legs through one shared helper, `requestLegs(request)`, which reads
`request.tool.legs` and falls back to a top-level `request.legs` for pre-V19 rows.

- **Postgres** (`postgresQuoteRepo.ts`): the projection additionally selects
  `COALESCE(request_json->'tool'->'legs', request_json->'legs')` and runs `quoteRouteText` on it.
- **In-memory** (`quoteRepo.ts`): runs `quoteRouteText(requestLegs(q.request))`.

**Honest cost.** An earlier draft of this spec called that "the legs sub-document only, never the
whole request blob". That was a fig leaf: `ToolRequestSchema` (`internalQuote.ts:87`) is about ten
small scalars plus `legs[]`, so legs *are* the request by byte count. This effectively ships the
whole request for every row. Legs are small in absolute terms (~200 bytes each) and today's queue
is ~24 rows, so the cost is genuinely noise — but the reason it is acceptable is the small `N`,
not a narrow projection. `/list` is already unbounded, which is what makes `N` the thing to watch;
see D5 for the trigger to revisit.

**Exposure.** `routeText` is place names — no cost, no margin. It needs no `margin:view` gate, and
`/list` already sits behind `requireCap('quote:manage')`. Stated explicitly because this file
gates `marginCents` carefully and a reader will look for the equivalent note here.

### 2. Front-end — the search box

`viewQuotes()` currently clears the topbar (`$('#topbar').innerHTML=''`). It instead renders the
same `.search` markup Bookings uses — same class, same magnifier SVG, plain `<input>` with
`aria-label="Search quotes"` and the placeholder `Search name, ref, route…`.

Deliberately **not** `type="search"`: it would layer the browser's native clear-× over the custom
magnifier styling and diverge from the Bookings input for no gain.

Render discipline, deliberately different from Bookings: `viewTickets` rebuilds the entire topbar
on every keystroke and then re-focuses the input and restores the caret by hand
(`ops-ui.html:2285`). That is a workaround for a self-inflicted wound. Here:

- The topbar markup is written **only when the search input is not already present**, so the
  background refresh and the 2–3 async paints per view entry cannot clobber an input mid-type.
- Keystrokes update `quoteQuery` and repaint **only `#view`**, through the existing
  `paintQuotesView` morphdom painter. The input is never re-created, so focus and caret are never
  lost and no restoration hack is needed.

Filtering is a pure function over the loaded rows:

```
haystack(row) = [row.customerName || 'Untitled', row.reference, row.routeText]
                  .filter(Boolean).join(' ').toLowerCase()

match(q, row)  = haystack(row).includes(q.trim().toLowerCase())
```

Case-insensitive substring. Notes:

- Nullable fields are **filtered out, never interpolated** — a template literal would render a
  missing `routeText` as the string `"null"`, and searching `null` would then match every quote
  lacking a route.
- The name falls back to `'Untitled'`, which is what the row actually *displays* for a null
  customer name. Searching "untitled" finds unnamed drafts instead of silently matching nothing.
- An empty or whitespace-only query filters nothing.
- No debounce — the list is in memory and morphdom only repaints changed rows.

### 3. Search behaviour

While `quoteQuery` is non-empty:

- **Flat results.** The "Assigned to me" partition and the status sections collapse into a single
  block reusing the existing `.qsection` / `.qsection-head` / `.qlist` chrome, titled **Results**
  with the usual count bubble. Order is the list's existing `createdAt desc`.
  The flat list is built by filtering **`opsQuotes` directly** (then the active chip's status
  set) — never from the `mineRows` / `byStatus` buckets, which partition the queue and would
  duplicate or drop rows.
- **Assignee chips show on every result row** (`quoteRowHtml(q, false)`). The "Assigned to me"
  header is what justified hiding them; in a flat list there is no header to say who holds a quote.
- **Subhead** reads `3 of 24 quotes match` in place of the usual `24 quotes · review, approve…`.
- **Chips still apply** and keep their whole-queue counts, exactly as today.

**Row route, match-aware (D7).** A row's `.qprod` cell (`Private · Car`) shows the route while a
query is active. Two constraints make the naive version useless:

- `.qrow` is a 5-column grid and `.qprod` is `minmax(0,1fr)` with `nowrap; overflow:hidden;
  text-overflow:ellipsis` (`ops-ui.html:150,154`). `Colombo Airport · Galle · Ella · Nuwara Eliya`
  ellipses after roughly the first place — so a search for "Ella" shows a row that still doesn't
  say Ella.
- At ≤640px `.qprod` is `display:none` (`ops-ui.html:177`), so the route would vanish entirely on
  a phone.

So:

- The cell renders `routeText` **split on `·` and windowed from the first place containing the
  query**, prefixed with `…` when earlier places were dropped. Searching "Ella" on the route above
  yields `… Ella · Nuwara Eliya`. Windowing on places, not characters, avoids cutting a name in
  half. When the row matched on name or reference rather than route, the route renders from the
  start as normal. CSS ellipsis still handles any remaining overflow.
- One new media-query rule un-hides the cell on mobile *only while searching*, as a full-width
  line under the row: `@media(max-width:640px){.qrow.qrow-searching .qprod{display:block;
  grid-column:1/-1}}`. This is the spec's only new CSS.
- Rows with no `routeText` keep `product · vehicle`.

**Empty states** (reusing `.qempty`):

- 0 matches anywhere → "No quotes match" / "Try a different name, reference, or route."
- 0 matches under the active chip but N elsewhere → "No match in *Ready to send*" / "N quotes
  match under other statuses" + a **Search all quotes** button that resets the chip to All,
  preserving the query.

**Clearing.** Clearing the box restores the grouped queue exactly as today. `Escape` in a
non-empty box clears the query and **calls `stopPropagation()`** — `ops-ui.html:2301` binds a
global Escape that closes the detail sheet, and the kbar binds its own at `2248`; clearing a
search must not also close something behind it. On an already-empty box, Escape propagates
normally. The query is module-level state like `queueFilter`: it survives opening a quote and
coming back, and does not survive a reload.

## Testing

**Backend (vitest, `api/`)**

- `quoteRouteText` unit tests — the load-bearing coverage, no DB required: point-to-point leg;
  multi-leg with the consecutive-place collapse; a multi-stop leg with `stops`; a `stay_day` leg;
  a genuine loop back to a repeated place; `null` for missing/empty/non-array legs; malformed leg
  objects don't throw.
- `internalQuote` route test: `GET /admin/quote/list` includes `routeText` on each row
  (in-memory repo, runs in CI).

**Known gap, accepted.** The Postgres-side assertion — that `request_json->'legs'` comes back at
all, and in order — belongs in `api/src/db/postgres.test.ts`, which is
`describe.skipIf(!TEST_URL)` on `DATABASE_URL_TEST` (`postgres.test.ts:33`) and therefore **does
not run in default CI**. The test will be written and will pass when a DB is present, but the
residual risk in D6 is real: the shared derivation is proven, its Postgres plumbing is not.
Mitigation is deliberate and cheap — the field is additive and a null `routeText` degrades to
"route not searchable", never a broken queue.

**Front-end**

- Vitest unit on the extracted match function: name hit, ref hit, route hit, case-insensitivity,
  whitespace-only query = no filter, `Untitled` matches a null customer name, and a regression
  test that the query `null` does **not** match a quote whose `routeText` is null.
- Vitest unit on the route-window function: match in the middle yields a `…`-prefixed window;
  match in the first place yields no prefix; no match yields the route from the start.
- Playwright e2e (alongside the existing `ops-*.spec.js`, which already stub
  `/admin/quote/list`): type → sections flatten to Results with the right count → a route-matched
  row shows the matched place → clear → grouped queue returns identical. Plus the chip-mismatch
  empty state and its **Search all quotes** escape.

## Not doing

- Global ⌘K search across quotes and bookings (the command bar stays navigation-only).
- Server-side `?q=` on `/admin/quote/list`, and pagination or a row cap on that endpoint.
- A `route_text` column or migration (D5) — revisit at thousands of quotes.
- An `aria-live` region for the result count (D8).
- Any change to the Bookings search, including its focus-restoration hack.
- Fuzzy matching, ranking, or match highlighting — plain substring only.
- Searching customer contact (email/phone) or assignee. Both are loaded and could be added
  cheaply later; they were not asked for.

## Delivery

Branch `feat/ops-quotes-search`, worktree `.claude/worktrees/quotes-search`, cut from
`origin/main` @ 7047afb. Stage by path only — the main checkout is shared with other sessions.
PR into `main`, which auto-deploys to staging. The production promote (`main` → `production`)
stays a separate, deliberate step.
