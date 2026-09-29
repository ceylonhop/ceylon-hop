# Destination guides — design

**Status:** approved in mockup (v22, 2026-09-28); first guide: Nuwara Eliya.
**Owner decisions recorded here were made in the mockup session; the mockup files live in
`.superpowers/brainstorm/` (gitignored) and are not the source of truth — this document is.**

## 1. What this is

A series of photo-led destination guides (Nuwara Eliya first; Ella, Kandy, Sigiriya, Colombo,
Arugam Bay, Trincomalee to follow) that we send to customers who have booked, and that Google
can rank. One template, one JSON content file per destination. Sections with no content are
omitted, so a thin guide and a rich guide are the same page shape.

Out of scope for this step (each is its own later step): sending the links from the booking
confirmation; timed pre-trip emails; partner/affiliate recommendations; day-hire booking.

## 2. Reader and tone

The reader is a customer who has booked with us, on a phone, before or during the trip. The page
answers "what do I do here, and how do I get on to the next place" in our own voice: honest,
specific, first-person ("From our drivers: …"). Never pushy. The only sales moments are the ones
that answer a question the reader already has at that point on the page.

## 3. URL, files, build

| Thing | Value |
| --- | --- |
| URL | `/guides/<slug>/` (e.g. `/guides/nuwara-eliya/`), trailing slash, depth 2 |
| Content source | `tools/guides/<slug>.json` — the team edits this, never the output |
| Generator | `tools/generate-guides.mjs`, called from `generateStaticPages()` in `tools/generate-static-pages.mjs` so the codegen drift test covers the output for free |
| Output | `guides/<slug>/index.html` (committed, like every generated page) |
| Photos | `img/guides/<slug>/<stem>-900.jpg` + `-1800.jpg`, same convention as `img/places/` (`sips` resize, committed) |
| Page script | `guide-page.js` (root, versioned by `assetV` like `route-list-fares.js`) |
| Sitemap | `guides/<slug>/` added to `SITEMAP_EXTRA` in `tools/generate-route-pages.mjs` |
| Blog hub | a crawlable "Destination guides" card block added to `blog.html` (hand-written page) |
| Credits | Unsplash attributions appended to `credits.html` under "Travel Guide" |

The page is rendered through `renderStandalone()` (`tools/render-page.mjs`) so it gets the same
header, footer, `<head>` assets, analytics and error beacon as every other generated page.
`active: 'blog.html'`, `depth: 2`. Nothing in the header/footer is bespoke.

## 4. Page anatomy (top to bottom)

Every block reads its content from the JSON; a missing/empty block does not render, and its
jump-nav chip is not emitted.

1. **Hero.** Full-bleed photo, bottom-only scrim, eyebrow "Ceylon Hop guide · <region>",
   `<h1>` destination name, one-sentence intro. Photo credit bottom-right.
2. **Facts strip.** Exactly four `{label, value}` pairs. Units set in Poppins (`.unit`) so
   Bodoni's degree sign does not gap.
3. **Jump nav.** Sticky chip row; smooth-scrolls under the sticky bar; the chip for the
   section in view is highlighted (IntersectionObserver); right-edge fade on phones.
4. **Lede.** One Bodoni sentence + a handwritten "— the Ceylon Hop team" (Caveat).
5. **Getting here — "We'll bring you up the hill".** One card per origin: car icon, title,
   distance · time · one-liner, three sentences selling *our driver on that road*, one
   **See price & book** button → `search.html?from=<originId>&to=<slug>`. **No prices on the
   page** (owner decision 2026-09-28: prices live on the search page). **No train row and no
   tuk-tuk mention in the cards.** The train is one collapsed `<details>` under the cards
   ("Thinking about the train?") whose text ends by bringing the reader back to us.
6. **Things to see & do.** Numbered place cards; the first is a wide feature card. Each card:
   photo, title, paragraph, a quiet **spec grid** (From town · Open · Give it · Ticket — only
   the keys present), at most **one tip block** ("From our drivers", saffron; or "Good to
   know", red), and optionally one **offer row** (car icon, bold line, sub-line, "Ask for a
   price →" → WhatsApp prefilled). Never the pill stack.
7. **Further afield.** Small cards: "2 h · each way" pill, name, text. Optional.
8. **Itinerary.** Day cards with a timeline; Ceylon Hop moments in saffron. A day may carry a
   footer with "Opens the planner with …" and **Book this day with us** →
   `plan.html?stops=<A>|<B>&nights=…` **only when every stop is a catalogue place the planner
   can price** (Day 2 in Nuwara Eliya). A sightseeing day (Day 1) has **no button** until day
   hires are bookable (owner decision 2026-09-28).
9. **When to come.** Four month blocks (label, title, text, optional tag).
10. **On the way (dark band).** Roadside stops with photo on top on phones; each has
    **Add this stop to my booking →** → WhatsApp prefilled with the stop and the guide name
    (booking.html has no notes URL parameter; WhatsApp is the honest path today).
11. **Eat & stay.** Photo cards in one fixed shape: 2-line title slot, 3-line clamped summary
    with fade, **More ▾** that slides the summary open in place, price band + flags, and
    "See on map ↗" (Eat only, Google Maps search link). **No "Check availability" / affiliate
    links.** The last card in each row is a collector: "Where did you eat well?" / "Stayed
    somewhere great?" with a single **Tell us on WhatsApp** button (prefilled). No input field.
12. **Your questions.** Tabs (Planning · Trains · Pack & wear · Good to know), one column,
    `<details>` accordions with animated open. All groups stay in the DOM.
13. **Where next.** The trip pages' `a.rt-card` markup, byte-compatible with
    `route-list-fares.js`: every rate-card corridor that touches the destination, both
    directions, "Return trip" badge where applicable, `data-list-fare` figures baked from the
    catalogue and replaced live by the engine. On phones the row is a swipeable snap row
    (`#next .next`), "Swipe for more routes →" hint. Live prices stay here (asked for at the
    start; not revisited). "See all Sri Lanka transfer routes →" → `trip/`.
14. **Ask us (blue band).** One WhatsApp button — the page's only generic contact prompt.
15. **Credits line + footer.**

## 5. Content schema (`tools/guides/<slug>.json`)

```jsonc
{
  "slug": "nuwara-eliya", "name": "Nuwara Eliya", "region": "Hill country",
  "placeId": "nuwara-eliya",                     // transfers-data id — drives Where next + search links
  "title": "…", "description": "…",              // <title>/<meta>; ≤ 60 / ≤ 158 chars
  "hero": { "photo": "hero", "intro": "…" },     // photo = stem in img/guides/<slug>/
  "facts": [{ "label": "Stay", "value": "2 nights" }, …4],
  "lede": "…", "ledeEm": "…",
  "gettingHere": { "heading": "…", "sub": "…",
    "origins": [{ "id": "kandy", "title": "From Kandy", "from": "75 km · 2 h 45 · …", "sell": "…" }],
    "train": "…" },                              // the collapsed line; omit to hide
  "places": [{ "id": "horton-plains", "name": "…", "photo": "horton", "text": "…",
    "spec": { "from": "…", "open": "…", "give": "…", "ticket": "…" },
    "tip": { "kind": "drivers|warn", "text": "…" },
    "offer": { "title": "…", "sub": "…", "wa": "…prefilled text…" } }],
  "furtherAfield": [{ "time": "2 h", "name": "…", "text": "…" }],
  "itinerary": [{ "title": "Day 1 · The plains", "sub": "…",
    "steps": [{ "time": "5:30", "title": "…", "text": "…", "us": true }],
    "book": { "stops": ["Nuwara Eliya", "Ella"], "nights": [0, 0], "preload": "…" } }],
  "months": [{ "label": "Dec – Feb", "title": "…", "text": "…", "tag": "…", "tone": "best|wet" }],
  "onTheWay": { "heading": "…", "sub": "…", "stops": [{ "km": "…", "name": "…", "text": "…", "photo": "…" }] },
  "eat": [{ "tier": "Family", "pick": true, "photo": "…", "name": "…", "text": "…", "band": "$$$", "flags": ["Dinner", "Book ahead"], "warn": ["Cash only"], "map": "The Hill Club Nuwara Eliya" }],
  "stay": [ …same shape, no "map" ],
  "faq": [{ "tab": "Planning", "items": [{ "q": "…", "a": "<p>…</p>" }] }],
  "photos": { "hero": { "alt": "…", "credit": "Juho S", "creditUrl": "…", "focal": "50% 45%", "w": 1800, "h": 1013 }, … },
  "checked": "September 2026"
}
```

Facts the generator computes, never the JSON: the Where-next cards (from `transfers-data.js`
via `loadTransfers()` and `BASE_PAIRS`), the search links, JSON-LD, read time.

## 6. Links — every one resolves

| Link | Target |
| --- | --- |
| Header / footer | `renderChrome()` output — identical to every other generated page |
| See price & book | `../../search.html?from=<originId>&to=<placeId>` (search.js reads `from`/`to` ids) |
| Book this day with us | `../../plan.html?stops=<names>&nights=<n>` (plan.js reads both) |
| Where next card | `../../trip/<from>-to-<to>/` (exists for every BASE_PAIRS corridor) |
| See all routes | `../../trip/` |
| All travel guides | `../../blog.html` |
| WhatsApp | `https://wa.me/94779669662?text=<encoded>` (the chrome's `WA` constant) |
| See on map | `https://www.google.com/maps/search/?api=1&query=<encoded name>` |
| Photo credits | `../../credits.html` |

A unit test walks every relative `href`/`src` in the generated page and asserts the file
exists in the repo (`web-tests/unit/guide-pages.test.js`).

## 7. SEO

- `<title>`, `<meta name="description">`, self-canonical `https://ceylonhop.com/guides/<slug>/`,
  OG tags — all via `renderStandalone`.
- JSON-LD: `Article` (author/publisher Organization "Ceylon Hop"), `FAQPage` built from every
  FAQ item across all tabs, `BreadcrumbList` (Home › Travel Guide › <name>).
- In `sitemap.xml`; linked from `blog.html` in static HTML (crawlable without JS).
- The train facts remain in the page (collapsed) so "Nuwara Eliya train" queries still land.

## 8. Behaviour (`guide-page.js`, classic script, no dependencies)

- Reveal-on-scroll: the site's `.reveal` rule and `initReveal()` timing, copied verbatim.
- Jump nav: smooth scroll offset by the sticky bar height; scroll-spy highlights the chip;
  reduced-motion honoured (`matchMedia`).
- FAQ tabs: click switches `.group.on`; no hash, no history entries.
- Eat/Stay "More": toggles `.open` on the card, label More ↔ Less, `aria-expanded`.
- `route-list-fares.js` does the Where-next prices, exactly as on the trip pages; the page's
  `<head>` sets/releases `list-fares-pending` on the same 4.5 s timer.
- Hero Ken-Burns settle on load; every animation disabled under `prefers-reduced-motion`.

## 9. Mobile

Container-query rules at < 760px: Getting-here cards stack; spec grid stays two columns;
On-the-way stops go photo-on-top; Where next becomes a snap row with 76%-width cards,
`scroll-padding` so the first card sits on the gutter; section padding 48px; jump-nav fade.
Verified at 375 × 812 in the mockup.

## 10. Testing

- **Unit (vitest, `web-tests/unit/guide-pages.test.js`):** the generator emits
  `guides/nuwara-eliya/index.html`; canonical, `FAQPage` and `BreadcrumbList` present; header
  and footer present without JS and the `trip/` link exists (same shape as
  `static-chrome-crawlable.test.js`); Where-next cards carry `data-list-fare` +
  `data-from-name`/`data-to-name` and link to existing trip pages; **no `$` price appears
  inside the Getting-here section**; no "tuk-tuk" in Getting here; every relative href/src
  resolves to a file; the sitemap lists the guide; blog.html links it.
- **Codegen drift:** covered automatically by `seo-codegen.test.js` via `generateStaticPages()`.
- **E2E (Playwright, `web-tests/e2e/guide-page.spec.js`, offline via `blockLiveApi`):** page
  loads; jump chip scrolls and highlights; FAQ tab switch; Eat "More" expands; Where next shows
  4 cards with the catalogue fares; at 375px the Where-next row is horizontally scrollable.
- Gate: `cd web-tests && npm run test:all` green; `npm run generate` leaves no diff.

## 11. Risks and choices

- **Numbers in the content are unverified.** Hours, fees, distances and season dates in
  `nuwara-eliya.json` were drafted from general knowledge; the team must confirm before
  publishing. The page carries a "checked <month>" line so staleness is visible.
- **Photos are Unsplash placeholders** chosen for mood, not the actual venue; credited on the
  page and in `credits.html`. Replace with real photos over time by swapping files in
  `img/guides/<slug>/` (same stems).
- **Trip → guide back-links** (a "Read our Nuwara Eliya guide" line on the four relevant trip
  pages) are deferred to a follow-up step; they regenerate 4 committed pages and are better
  reviewed on their own.
- **Day-hire booking** and **collecting suggestions into a table** are deferred; WhatsApp
  prefills carry both today.
