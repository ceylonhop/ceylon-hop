# Trip pages redesign — route page, routes index, and honest list prices

**Date:** 2026-09-21 · **Owner ask:** "the trip pages are shit compared to other pages" → mockup approved
2026-09-21 → "write the spec, fix the index prices too".
**Mockup (the visual source of truth):** https://claude.ai/artifact/4hp7KNty4m8iM6zSfcEE36 — three views:
Kandy → Ella (private only), Airport → Sigiriya (with shared ride), All routes (`/trip/`).

## 1. Problem

The 44 generated `/trip/<a>-to-<b>/` pages (22 pairs, both directions; `trip/` also holds ~25 hand-built legacy directories this work does not touch) and the `/trip/` index are the outside-arrival landing pages (owner
decision 2026-09-19; they inherited the old site's rankings at the 2026-09-20 cutover). They are the first
thing a Google visitor sees, and they are the weakest pages on the site:

- **No photography.** The only `<img>` on a trip page is the logo. Home, tours and about all lead with photos.
- **The hero sells a WhatsApp chat, not a booking.** On a phone, price and Book are below the fold.
- **Half-empty desktop layout.** Body copy and FAQ sit in a ~480px column; on private-only routes half the
  options row is a grey "Not on this route" card.
- **Unstyled body.** A paragraph and browser-default bullets; all FAQ answers open; the H2 repeats the full
  route name and wraps to three lines on a phone.
- **No reassurance.** No trust strip, no "what's included", no review — on the page that most needs them.
- **Index:** a flat teal band unlike any other page, 44 identical text cards, no filter, origin name repeated
  on every card, regional grouping that files every "Ella → …" route under "South coast & east", no
  shared-seat signal, and no exit for "my route isn't listed" even though we price any two points.
- **List prices lie.** The index and the "Related routes" cards show the catalogue fare; the page they link
  to shows the engine fare (hot zones). Kandy → Ella: $59.99 on the index, $66 on its page.

## 2. Goals / non-goals

**Goals**
1. One new route-page template and one new index template, in the visual language the rest of the site
   already uses (photo hero + overlapping card, trust strip, eyebrow + Bodoni headings, photo cards).
2. Price and the Book action above the fold on desktop and phone.
3. Every list price on `/trip/` pages (index rows, "most booked" cards, related-route cards) shows the same
   engine fare its destination page shows.
4. No SEO regression: same URLs, titles, descriptions, H1 text, JSON-LD, crawlable links, static fares.

**Non-goals** (do not build)
- Homepage "Popular transfers" cards — same price gap, same fix would apply, but it is a separate request.
- Any change to pricing (`rateCard.ts`, `departureRepo.ts`), schema, or config.
- A date picker or booking form on the trip page. The CTA still hands off to `booking.html`.
- Nearby-dates lookup for shared rides, board changes, new route content. Copy in `route-content.json`
  is reused as is.
- Dark mode. The site is light-only by declaration.

## 3. Invariants (must survive; most are already guarded by tests)

Guard names are where coverage was found while writing this spec; the implementation plan re-verifies each
before relying on it.

| Invariant | Guard |
|---|---|
| `<title>`, meta description, legacy "taxi / shared taxi" vocabulary | `seo-legacy-keywords`, `seo-content`, `seo-generate` |
| H1 reads "{From} to {To}" to a crawler (the visually-hidden "to" stays) | `seo-invariants` |
| Both private fares, the seat price, and every boarding time are in **static markup** — page is complete with JS off | `route-page-unified` |
| JSON-LD (FAQPage, Breadcrumb, offer) stays catalogue-priced and matches the **visible** FAQ text | `seo-codegen`, `seo-content` |
| Header/footer ship in the HTML (`inject-static-chrome`) | `static-chrome-crawlable` |
| Private CTA carries `from,to,mode=private,vehicle,price(,rawPrice)` to `booking.html` | `route-page-unified` "links somewhere that actually books" |
| Hooks `data-live-fares`, `data-from-name`, `data-to-name`, `data-fare`, `.opt-private`, `.opt-cta`, `data-shared-cta` keep their meaning (`route-page.js`, `route-page-fares.js`, GA4 labels depend on them) | `route-page-fares.spec`, `service-labels.spec`, analytics tests |
| A fare that has been **shown** never changes; every engine failure ends at the catalogue fare, silently | `route-page-fares.spec` |
| All 44 index links are real `<a href>` in the HTML; filters only hide | new test (§9) |
| Generated output is never hand-edited; asset stamps come from `npm run generate` | codegen + stamp tests |

Tests whose **expectations legitimately change** (update in the same PR, red→green): the "says plainly when a
route has no shared option" copy assertion, `route-pages.spec.js` / `mobile-ux.spec.js` layout selectors, and
any FAQ-question text assertions for the three shortened questions (§4.7).

## 4. Route page template

All route-page CSS already lives inline in `tools/generate-route-pages.mjs`, so this template has **no
shared-component blast radius** — `site.css` is not touched except to reuse existing tokens/classes.
Sections, top to bottom:

### 4.1 Hero
- Full-bleed **destination** photo (`<img>`, not a CSS background: `fetchpriority="high"`, `width/height`,
  `srcset` 900w/1800w, real `alt`) under a left-weighted dark gradient.
- Left: breadcrumb → H1 (`Kandy ⤳ Ella`, existing swoosh + hidden "to") → one-line pitch (first sentence of
  the existing intro, trimmed at generate time to ≤ 120 chars on a sentence boundary; falls back to a
  template line) → chips: `135 km · 3h 45m`, `Runs every day`, `5.0 on Tripadvisor`.
- Right: the **fares card** (`article.opt.opt-private[data-live-fares]`), overlapping the hero's bottom edge
  by 64px like the home booking widget.
- The WhatsApp button leaves the hero (moves to §4.7).
- ≤ 900px: photo + copy stack first, fares card follows and overlaps the photo by 36px. The car fare and the
  CTA must be inside the first 812px at 375w (e2e assertion).

### 4.2 Fares card
- Kicker "Private transfer · door to door", H2 "Your own car, fixed price".
- Two vehicle tiles as a **radio group** (`<input type="radio" name="vehicle">` + label; car checked). Each
  keeps `<span data-fare="car|van">` and "total, fixed". With JS off the CTA books the car, as today.
- CTA `a.btn.btn-cta.opt-cta` — label "Choose date & book".
- Fine print: "Free cancellation up to 24h before · no change fees" (existing site claim).
- Shared routes only: a saffron strip "Or share the van — **$27.49** a seat · See who's going ↓" linking to
  `#share`.
- **CTA contract change (small, additive):** selecting a tile rewrites the CTA's `vehicle` and `price`
  (and `rawPrice` while catalogue fares are showing). `route-page-fares.js` currently rewrites `price` for
  the car only; it will store both engine fares on the card (`data-engine-car`, `data-engine-van`, cents) and
  the tile handler reads them. The `rawPrice`-must-not-ride-with-an-engine-fare rule is unchanged.
  `booking.js` already reads `vehicle` — no booking change.

### 4.3 Trust strip
The home strip's four claims, same icons: fully insured & safe drivers · AC cars & vans · free cancellation
24h before · WhatsApp support 7 days. ("Shared seats every Wed & Sat" is omitted: it is false for most routes.)

### 4.4 Shared ride
- **Private-only routes:** the grey half-width card is replaced by a one-line note: "No shared van runs
  {From} → {To}. For three or more, a private car often works out close to a seat price. Or start a ride on
  the board →" (links to `board.html?from=&to=`). The sentence still "says plainly" there is no shared
  option (keeps the intent of the existing unit test; update its string).
- **Shared routes:** a full-width `#share` section, two columns. Left: "Best value" tag, H2 "One van, split
  between you", seat price, the runs-once-3 line, boarding times (all static). Right:
  the existing `data-shared-cta` block, restyled — `route-page.js`'s "already going" list renders as
  **single-line rows** (avatars · `Mon 21 Sep · morning` · `5 going` · status pill).
- **Status copy fix:** "5 of 3 — running" → pill **Running**; below the minimum → pill **"1 more to run"**.
  Count text is "{n} going". Never render "n of min" once n ≥ min.
- Vocabulary stays per owner call: traveller copy says "shared taxi"/"van" as today; nothing here renames.

### 4.5 The drive
Two columns. Left: eyebrow "The drive", H2 = new optional `pairs[key].driveTitle` (fallback "The road from
{From} to {To}"), intro paragraph, then the existing highlights as a **route line**: origin dot → one stop
per highlight → destination dot. Highlights are strings today; render each as one line (no title/subtitle
split unless `route-content.json` later adds one — not in this spec). Right: a photo — `pairs[key].photo`
if set, else the **origin** place photo (hero is the destination, so a page never shows one photo twice) —
with a Caveat caption from the photo manifest.

### 4.6 What's included + proof
Four icon items from existing claims only: a fixed price · door to door · stops when you want · free
cancellation. Icons from the house **line** family (`img/icons/line`), not new inline one-offs. Then one
proof row: founder quote (home's) + "5.0 · {n} reviews on Tripadvisor" using the same review-count source
`ta-review-count.test.js` already guards (`ta-data.js` → `TA.reviews`) — never a hard-coded number.
No airport meet-and-greet language (guard test exists).

### 4.7 FAQ
Two columns: left eyebrow "Good to know", H2 "{From} to {To}, answered", helper line, **WhatsApp button
(its new home)**; right `<details>` accordion, first item open. Questions keep their **keyword-bearing**
forms ("How much is a taxi from {From} to {To}?", "Is there a shared taxi from {From} to {To}?" /
"How does the {From} to {To} shared taxi work?"); the three generic ones shorten ("How long does the drive
take?", "Can we stop along the way?", "How do I book?"). Visible text and JSON-LD change **together** from
the single `faqItems()` source. The `liveFares()` two-fare substitution and its shape assertion stay.

### 4.8 Where next
Eyebrow "Keep hopping", H2 "Where next from {To}?". Four photo cards (destination photo, name, est, "from
$X fixed"). `relatedRoutes()` selection logic is unchanged, but the reverse route is labelled **Return
trip**. Prices carry `data-list-fare` (§6). "See all Sri Lanka transfer routes →" stays.

### 4.9 Sticky mobile book bar (≤ 900px)
Fixed bottom bar: "AC {car|van} · total, fixed **$66**" + "Choose date & book" (same href as the card CTA,
kept in sync by the tile handler; figure carries `data-fare`). Appears only while the fares card is off
screen (IntersectionObserver); respects `env(safe-area-inset-bottom)`. Must not collide with the cookie
consent banner or the floating WhatsApp button (#685) if that ships on trip pages — check both in the
browser at 375w before merge. No JS → no bar (the in-page CTA still works).

## 5. Place photos

- New `tools/place-photos.json`: `{ "<placeId>": { "file": "img/places/ella.jpg", "alt": "...",
  "caption": "...", "credit": "...", "creditUrl": "...", "focal": "50% 60%" } }` for all 11–12 catalogue
  places, plus `"_index"` for the index hero.
- Files in `img/places/`, two widths each (`-900.jpg`, `-1800.jpg`), hero ≤ 250 KB at 1800w, card use
  the 900w. `width`/`height` attributes always set (no CLS). Everything but the hero is `loading="lazy"`.
- Source: existing library first (Ella ← `cta-nine-arch`, Sigiriya ← `tour-classic-hop`, Kandy/tea,
  Galle, Mirissa, Yala have candidates). Missing: Colombo Airport, Colombo city, Negombo, Nuwara Eliya,
  Arugam Bay → Unsplash, credited in `credits.html` like every other photo. **Owner approves the 12 picks
  as a contact sheet before PR 1 merges.**
- Generator throws if a place has no manifest entry or the file is missing (same fail-loud style as the
  `route-content.json` check).
- `<image-slot>` is **not** used: it is a root-page authoring tool that stores base64 in a sidecar; 44
  generated pages need plain cacheable files.

## 6. List prices = engine prices ("fix the index prices")

**Why it can't be done at build time:** hot zones are prod DB rows; CI cannot know them. It has to be a
client-side ask, like `route-page-fares.js`. **Why not reuse `/quote/v2/estimate`:** `ch-pricing.js` tracks one
intent at a time, so 44 routes = 44 sequential round trips (~1.7s cold each).

### 6.1 API — `POST /quote/v2/estimate-batch`  ⚠ interface addition (needs owner ok = approving this spec)
- Body: `{ intents: Intent[] }` — the **same** `Intent` schema as `/v2/estimate`, 1–60 items, Zod-validated.
- Response `200`: `{ results: ({ totalCents: number, currency: "USD" } | null)[] }`, index-aligned. A `null`
  is any per-intent failure (unknown place, distance unavailable, estimate marked `estimated`). One bad
  intent never fails the batch.
- Each intent runs through the **same** estimate function as `/v2/estimate` (no second pricing path), so a
  batch figure is identical to the single-route figure by construction — asserted in a test.
- Same feature gate (`v2Enabled` → 404 when off), same CORS allowlist, same rate-limit bucket (a batch
  counts as one request). No DB writes, no drafts.
- **Distance cost guard:** only intents whose legs are both *known catalogue places* are priced; anything else
  returns `null`. The implementation plan must confirm known-place pairs resolve from coords /
  `distance_cache` without a live Google call; if they do not, add a 10-minute in-memory result cache keyed
  on the intent JSON before shipping. (The distance-cache seed run is still pending — flag, don't block.)
- No schema, no migration, no config. Lives in `api/src/routes/quote.ts`; tests first in its test file
  (red → green): alignment, null isolation, parity with `/v2/estimate`, 404 when disabled, >60 rejected.

### 6.2 Client — new `route-list-fares.js`
- Finds every `[data-list-fare][data-from-name][data-to-name]`, de-duplicates pairs, sends **one** batch of
  car intents built with the byte-identical key order (`vehicle, product, pax, bags, legs, extras`).
- Same rules as `route-page-fares.js`: `<head>` sets `list-fares-pending` (figures held transparent, in
  place — no layout shift), 4s cap, a shown fare never changes, all failures fall back to the catalogue
  figure in the markup, `?api=off` honoured. Must not call real hosts in e2e (`serve-booking.js` already
  rewrites live-API traffic — add the new path to its stub).
- Used on: `/trip/` index (rows + "most booked" cards) and the "Where next" cards on every route page.
- Does not write into `chEst:*` sessionStorage (YAGNI).

**Release note:** Pages and the API both go live from `production`, so the client and endpoint ship in the
same promote. If the front end lands first, the 404 fallback shows catalogue prices — today's behaviour.

## 7. Routes index (`/trip/`)

1. **Hero** — photo (`_index`), H1 "Sri Lanka transfer routes" (unchanged), existing description lightly
   edited, chips (`{n} routes`, fixed prices, Tripadvisor). Right: a "Where are you going?" card with
   pick-up / drop-off fields and "See prices & book". This **reuses the home widget's place picker from
   `site.js`** (one of the three picker copies — do not write a fourth) and submits to `search.html` exactly
   as home does.
2. **Trust strip** (§4.3).
3. **Most booked** — four photo cards, fixed list in the generator (`cmb-airport→kandy`,
   `cmb-airport→sigiriya`, `kandy→ella`, `ella→mirissa`), shared-seat badge where a seat is sold.
4. **"Leaving from" chips** — Everywhere + one per origin, horizontally scrollable on a phone, sticky under
   the site header on desktop. Progressive enhancement: buttons toggle `hidden` on origin blocks; with JS off
   the chips are in-page anchor links (`#from-kandy`).
5. **Origin blocks** — grouped by **origin place** (replaces the four regional groups), fixed order: Airport,
   Colombo, Negombo, Kandy, Sigiriya, Nuwara Eliya, Ella, Galle, Mirissa, Yala, Arugam Bay. Each: origin
   photo, H2 "From {Place}", route count, then compact rows `→ {To}` · est · optional "Shared seat $X"
   badge · "from **$X**" (`data-list-fare`). Two columns desktop, one on phone. Every row is an `<a href>`.
6. **Closing band** — "Going somewhere that isn't listed?" → `search.html` ("Get a fixed price") and
   `plan.html` ("Plan a multi-stop trip").

H2s change from regional names to "From {Place}" — more query-aligned, not less; `seo-legacy-keywords`
covers titles, not these headings, but run it.

## 8. Accessibility & performance
- Radio tiles and chips are real controls with visible `:focus-visible`; accordion is native `<details>`.
- Text over the hero photo ≥ 4.5:1 against the gradient at its lightest point (check the brightest photo).
- One hero image is the LCP element; nothing else above the fold loads eagerly. No new fonts, no libraries.
- `prefers-reduced-motion`: card hover lift and any bar slide-in are disabled.

## 9. Testing
- **Unit (web-tests/unit):** new `trip-redesign.test.js` — every page has a hero `<img>` with alt/width/height
  and a manifest-backed file that exists; fares card has both `data-fare`s and two radios; private-only pages
  contain the no-shared sentence and a board link, and **no** `.opt-none` card; shared pages contain `#share`,
  seat price and all boarding times statically; FAQ is `<details>` and visible Q/A === JSON-LD Q/A; index has
  exactly one `<a>` per generated route, grouped under the right origin; every list price has
  `data-list-fare` + both names. Existing suites updated only where §3 says expectations change.
- **E2E:** extend `route-page-fares.spec` (tile selection rewrites `vehicle`/`price`, engine fare wins, late
  answer dropped); new `route-list-fares.spec` (one batch request, fallback on 404/timeout, shown fare never
  changes); `mobile-ux.spec` (375w: car fare + CTA within first viewport; sticky bar appears after scrolling
  past the card; no horizontal scroll); index chip filter hides/shows blocks and keeps links in the DOM.
  Width assertions use line Ranges, not height math; remember Linux fallback-font metrics are ~3.7% wider.
- **API:** §6.1 tests, red → green evidence in the PR.
- **Gates:** `cd api && npm run check`; `cd web-tests && npm run test:all` (includes Playwright);
  `npm run generate` leaves a clean diff. Visual check in the browser preview at 1280 and 375 for one
  private-only, one shared, and the index. Engine fares cannot be verified locally (no localhost origin in
  prod's allowlist) — verify on prod after the promote with `chEst:*` cleared.

## 10. Delivery — one step = one branch = one PR

| # | PR | Touches | Notes |
|---|---|---|---|
| 1 | Place photos + manifest + credits | `img/places/*`, `tools/place-photos.json`, `credits.html` | Owner approves contact sheet first. No page changes. |
| 2 | Route page template | `tools/generate-route-pages.mjs`, `route-page.js`, `route-page-fares.js`, regenerated `trip/*/index.html`, web-tests | The big one. Regenerate, never rebase, if `main` moves. |
| 3 | Index template | generator (`tripIndex`), regenerated `trip/index.html`, web-tests | Catalogue prices still; layout only. |
| 4 | `POST /quote/v2/estimate-batch` | `api/src/routes/quote.ts` + tests | Backend only; can run in parallel with 1–3. **Interface addition.** |
| 5 | `route-list-fares.js` wired into index + "Where next" | new root JS, generator `<head>`/hooks, `serve-booking.js` stub, e2e | Needs 4 on staging. |

Each PR: feature branch from a throwaway worktree → `main` (staging for API; **Pages only changes on the
`main → production` promote**) → owner-approved promote. Nothing here is a migration, pricing, or config
change. Generated pages are in the STOP-and-ask list — approving this spec is the ask for PRs 2, 3 and 5.

## 11. Open questions for the owner
1. **Photos:** OK to fill the five missing places from Unsplash, subject to your contact-sheet approval?
2. **Proof row:** founder quote (as mocked), or a real Tripadvisor review quote from the set
   `ta-review-quotes.test.js` guards? Default if unanswered: founder quote.
3. **"What's included":** keep (default) or cut to shorten the page?
