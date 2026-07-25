# Search on the ops Quotes queue — design

**Date:** 2026-07-25
**Status:** approved (owner, 2026-07-25)
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
  free — no new fetch, no new round-trip per keystroke.
- Route is **not** in that projection and there are no `from`/`to` columns on the `quotes`
  table. Route data lives only inside `request_json.legs[]` as `{from, to, stops?}`.
- Bookings' equivalent search (`?q=`) exists server-side in `ops.ts` but the UI filters
  client-side; the server param is unused by the UI.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Per-page search box on Quotes, mirroring Bookings — not a global ⌘K search | Smallest footprint, matches the pattern already on the page next door. ⌘K stays a possible follow-up. |
| D2 | Match on customer name + reference + route | Parity with the Bookings search. Name and reference alone can't find "the Galle trip". |
| D3 | While a query is active, flatten the role-aware sections into one result list | Sections are a triage device; search is retrieval. A match buried in the right section is still a scan. |
| D4 | Status chips still narrow results, but a zero-result-here / matches-elsewhere case says so explicitly and offers one-click escape | A chip silently hiding your match is the classic "where did it go" failure. Honest beats clever. |
| D5 | One JS derivation of route text, shared by both repos — no parallel SQL implementation | A `string_agg` in Postgres plus a JS version for the in-memory repo would be two implementations of one rule, free to drift apart. |

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

- **Postgres** (`postgresQuoteRepo.ts`): the projection additionally selects
  `request_json->'legs'` — the legs sub-document only, never the whole request blob — and runs
  `quoteRouteText` on it.
- **In-memory** (`quoteRepo.ts`): runs `quoteRouteText` on the stored request's `legs`.

Perf note, recorded deliberately: this makes `/list` carry a JSON sub-document per row.
Legs are small (~200 bytes each) and today's queue is ~24 rows, so the cost is noise.
**`/list` is already unbounded** — no limit, no pagination — so this rides an existing scaling
question rather than creating a new one. Out of scope here; see Not Doing.

### 2. Front-end — the search box

`viewQuotes()` currently clears the topbar (`$('#topbar').innerHTML=''`). It instead renders the
same `.search` markup Bookings uses — same class, same magnifier SVG, **no new CSS** — with the
placeholder `Search name, ref, route…`.

Render discipline, deliberately different from Bookings: `viewTickets` rebuilds the entire
topbar on every keystroke and then re-focuses the input and restores the caret by hand
(`ops-ui.html:2285`). That is a workaround for a self-inflicted wound. Here:

- The topbar markup is written **only when the search input is not already present**, so the
  background refresh and the 2–3 async paints per view entry cannot clobber an input mid-type.
- Keystrokes update `quoteQuery` and repaint **only `#view`**, through the existing
  `paintQuotesView` morphdom painter. The input is never re-created, so focus and caret are
  never lost and no restoration hack is needed.

Filtering is a pure function over the loaded rows:

```
haystack(row) = [row.customerName, row.reference, row.routeText]
                  .filter(Boolean).join(' ').toLowerCase()

match(q, row)  = haystack(row).includes(q.trim().toLowerCase())
```

Case-insensitive substring. Nullable fields are **filtered out, never interpolated** — a
template literal would render a missing `routeText` as the string `"null"`, and searching
`null` would then match every quote lacking a route. An empty/whitespace-only query filters
nothing. No debounce — the list is in memory and morphdom only repaints changed rows.

### 3. Search behaviour

While `quoteQuery` is non-empty:

- **Flat results.** The "Assigned to me" partition and the status sections collapse into a
  single block that reuses the existing `.qsection` / `.qsection-head` / `.qlist` chrome, titled
  **Results** with the usual count bubble. Order is the list's existing `createdAt desc`.
- **Subhead** reads `3 of 24 quotes match` in place of the usual `24 quotes · review, approve…`.
- **Chips still apply** and keep their whole-queue counts, exactly as they do today.
- **Row route swap.** A row's `.qprod` cell (`Private · Car`) shows `routeText` while a query is
  active, so a row that matched on route visibly says why. Same cell, no layout change; it
  reverts the instant the box is cleared. Rows with no `routeText` keep product · vehicle.
- **Empty states** (reusing `.qempty`):
  - 0 matches anywhere → "No quotes match" / "Try a different name, reference, or route."
  - 0 matches under the active chip but N elsewhere → "No match in *Ready to send*" /
    "N quotes match under other statuses" + a **Search all quotes** button that sets the chip
    back to All, preserving the query.
- Clearing the box restores the grouped queue exactly as it is today. The query is **not**
  persisted across a reload; it survives opening a quote and coming back (module-level state,
  like `queueFilter`).

### 4. Accessibility

- The input gets `aria-label="Search quotes"` and `type="search"`.
- The result count lives in an `aria-live="polite"` region so a screen reader hears
  "3 of 24 quotes match" as it narrows.
- `Escape` in a non-empty box clears the query and returns to the grouped queue.

## Testing

**Backend (vitest, `api/`)**

- `quoteRouteText` unit tests: point-to-point leg; multi-leg with the shared-place collapse;
  a multi-stop leg with `stops`; a `stay_day` leg; a genuine loop back to a repeated place;
  `null` for missing/empty/non-array legs; malformed leg objects don't throw.
- `internalQuote` route test: `GET /admin/quote/list` includes `routeText` on each row.
- Repo test: the in-memory and Postgres projections agree on the same fixture.

**Front-end**

- Vitest unit on the extracted match function (name hit, ref hit, route hit, case-insensitivity,
  whitespace-only query = no filter, and a regression test that the query `null` does **not**
  match a quote whose `routeText`/`customerName` is null).
- Playwright e2e: type → sections flatten to Results with the right count → row shows the route
  → clear → grouped queue returns identical. Plus the chip-mismatch empty state and its
  **Search all quotes** escape.

## Not doing

- Global ⌘K search across quotes and bookings (the command bar stays navigation-only).
- Server-side `?q=` on `/admin/quote/list`, and pagination or a row cap on that endpoint.
- Any change to the Bookings search, including its focus-restoration hack.
- Fuzzy matching, ranking, or match highlighting — plain substring only.
- Searching customer contact (email/phone) or assignee. Both are loaded and could be added
  cheaply later; they were not asked for.

## Delivery

Branch `feat/ops-quotes-search`, worktree `.claude/worktrees/quotes-search`, cut from
`origin/main` @ 7047afb. Stage by path only — the main checkout is shared with other sessions.
PR into `main`, which auto-deploys to staging. The production promote (`main` → `production`)
stays a separate, deliberate step.
