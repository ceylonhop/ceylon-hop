# Seven UI tweaks — design

Date: 2026-08-14
Status: approved by owner 2026-08-14 (see "Open questions" for what was decided)

Seven small front-end changes requested together. Six are contained to one page each; one
(#2) changes how a single-leg search is priced. They ship as separate branches/PRs per
CLAUDE.md rule 1, smallest first.

## Baseline

`origin/main` at design time: `b1a1bc6` — *feat(booking): the booking page prices through the
engine (phase 3) (#475)*. This matters for #2: phase 3 landed `ch-pricing.js` and the
`POST /quote/v2/estimate` endpoint, so the API-priced search needs **no new backend work**.

---

## 1. Stuck spinner after browser Back

**Symptom.** Submit the homepage hero form, then press Back. The CTA is still disabled and
still reads "Opening your trip…" / "Finding your prices…".

**Cause.** `goBook()` (index.html) sets `btn.disabled=true` and swaps `btn.innerHTML` to a
spinner immediately before assigning `window.location.href`. The browser then stores the live
DOM in the back/forward cache. Restoring from bfcache replays that DOM verbatim — no script
re-runs, so nothing ever puts the button back. There is currently **no `pageshow` handler
anywhere on the site** (verified by grep across all non-vendor `*.js` / `*.html`).

**Fix.** Add a `pageshow` listener on index.html. When `e.persisted` is true, or
`performance.getEntriesByType('navigation')[0].type === 'back_forward'`, re-enable `#go-btn`
and call the existing `update()`, which already derives the correct label from the current
mode (`'Plan this trip'` vs `'See prices & book'`) and re-applies `.needs-input`. Restoring
via `update()` rather than a hardcoded string is what keeps the two modes from diverging.

**Test.** Playwright: home → submit → `goBack()` → assert `#go-btn` is enabled and has the
single-transfer label.

**Out of scope, noted:** `plan.js` and `booking.js` use the same disable-and-swap-label
pattern before navigating and are likely to have the same bug. Not fixed here.

---

## 2. A single-leg search always lands on search.html

**Today.** `goBook()` sends the pair to `search.html` only when **both** places resolve in the
baked `TRANSFERS` catalogue; otherwise it falls through to `plan.html`
(`if(!fromR.known || !toR.known)`). `updateSearch()` in `search.js` has the same fall-through.
A Google-autocompleted place like "pasikudah, Kalkudah, Sri Lanka" is not in the catalogue, so
the traveller lands in the itinerary planner instead of on a price.

**Decision.** Prices for unknown places come from the API, not from a client-side Google
measurement.

**What exists already (phase 3, #475).** No new endpoint is needed:

- `POST /quote/v2/estimate` prices a `WebQuoteIntent` **without persisting anything**. It
  resolves each leg through the maps adapter (riding the Postgres distance cache from #458),
  runs the engine against the live card, and returns the public result plus `estimated` and
  `legs`. It is gated on `QUOTE_V2_ENABLED` and returns 404 when off.
- `ch-pricing.js` exposes `window.CH_PRICING.estimate(intent, {onResult, onUnavailable})` and
  already owns debounce (400ms), sessionStorage dedupe by intent, in-flight joining,
  out-of-order-response safety, a 3s timeout, and latching `available=false` on a 404.

**Change.**

1. Delete both fall-throughs, so a single leg always goes to `search.html?from=…&to=…`.
   Unknown places travel as free text (`fromName`/`toName` params) since they have no id.
2. `search.js` keeps the baked table as the fast path for known pairs — those still render
   instantly with no network. When either end is unknown it calls `CH_PRICING.estimate` with
   a `product:'private'` intent, once for `vehicle:'car'` and once for `vehicle:'van'`, with
   `pax:1, bags:0`. Sending `pax:1` is safe: the engine only ever uses pax/bags to *upgrade*
   the vehicle (`selectVehicle`), so it cannot distort a car price downward.
3. Render states: skeleton while in flight; price on `onResult`; and on `onUnavailable` — or
   on a `quote_unpriced` 422, or an `estimated:true` response — fall back to the existing
   "message us and we'll price it in minutes" panel. There is no local formula for an unknown
   place, so this panel is the only honest fallback.
4. Shared-seat card is suppressed for unknown routes: a shared corridor is a property of the
   baked table and does not exist for an arbitrary place.

**Config this depends on** (already required by phase 3, not new to this change):
`QUOTE_V2_ENABLED` must be on for the deploy, and `ALLOWED_ORIGINS` must contain the site
origin or the browser call is blocked by CORS. If either is missing, `ch-pricing` latches off
and every unknown route degrades to the enquiry panel — a soft failure, not a broken page.

**Cost note.** An uncached place pair costs one Google lookup. The distance cache absorbs
repeats and `ch-pricing`'s sessionStorage dedupe absorbs re-renders, but this is the first
path where an anonymous visitor can trigger a paid lookup from a page load.

---

## 3 & 4. Search page header

One visual change, shipped as one PR.

- **Remove** the `.srch-top` section entirely — the white strip and its "← Start a new search"
  link — plus the now-dead `.srch-top` / `.back-link` CSS. The nav logo already goes home.
- **Move** `#sl-edit` ("Edit search") out of `.route-actions` and onto the `<h1>` line,
  right-aligned. `.route-head` gains a flex row wrapping the title and the button;
  `.route-actions` keeps `#add-stops` alone. Below ~700px the button wraps to its own line so
  it never squeezes the route name.

Four assertions in `web-tests/e2e/search.spec.js` reference the button's position relative to
the form it opens; they are updated to the new layout, not deleted.

---

## 5. Stop cap hands over to the planner

At 3 mid-stops — pick-up + drop-off + 3 = 5 places — `#add-stop` relabels to "Add more stops
in the planner" and, on click, submits the trip to `plan.html?stops=…` carrying everything
typed so far, instead of appending another row. Below 3 mid-stops nothing changes. The
existing internal cap of 8 becomes unreachable from the homepage but stays as a guard.

Rationale: 5 places is where the hero card stops being a sensible place to build an
itinerary, and the planner is the tool that does it well. Handing over with the state intact
means nothing typed is lost.

---

## 6. Hero carousel

The hero photo is an `<image-slot>` whose image lives as a base64 blob in
`image-slots.state.json` — the owner's drag-and-drop workflow, not a file in `img/`.

Add `hero-photo-2` and `hero-photo-3` as sibling slots inside `#pc-img`, absolutely stacked.
Cross-fade every 6s; dots to jump; pause on hover and on keyboard focus; no rotation at all
under `prefers-reduced-motion: reduce`. **A slot with no image is excluded from the rotation**,
so with only `hero-photo` filled the page looks and behaves exactly as it does today, and the
carousel starts working the moment a second photo is dropped in. The existing parallax
transform continues to apply to the slot container, so it keeps working on whichever slide is
visible.

---

## 7. Trust strip shrinks instead of wrapping

Today `.trust-row` degrades from one flex line to a 3-column grid (951–1159px), a 2-column
grid (761–950px), and a horizontal swipe strip (≤760px). The two grid bands are what produce
the 3-then-2 stack in the report.

Remove both grid blocks. From 1159px down to 760px the row stays a single line, scaling
`font-size`, icon size and `gap` with `clamp()`. The swipe strip stays for ≤760px: five items
on one line on a 375px screen would be unreadable, and the strip is already a deliberate,
tested pattern.

`web-tests/e2e/trust-row.spec.js` currently asserts the grid behaviour explicitly. It is
rewritten to assert, across the 760–1440px range: one visual row, no label wrapping to two
lines, and no horizontal overflow.

---

## Delivery

| PR | Scope | Risk |
|----|-------|------|
| A | #1 spinner reset | tiny |
| B | #3 + #4 search header | low, visual |
| C | #5 stop cap | low |
| D | #7 trust strip | low, visual + spec rewrite |
| E | #6 hero carousel | low, additive |
| F | #2 API-priced search | highest — changes what the search page depends on |

Gate for each: `cd api && npm run check` where the API is touched (only F, and only if it
turns out to need a backend change — currently it does not), and `cd web-tests && npm test`
plus the Playwright suite for all of them.

## Open questions — resolved

- *Unknown-place pricing:* API (`/quote/v2/estimate`), not a client-side Google measurement.
- *Stop cap behaviour:* relabel **and** hand over to the planner.
- *Carousel slides:* three image-slots; owner fills 2 and 3.
- *Trust strip:* shrink to one line down to 760px; keep the swipe strip below that.
