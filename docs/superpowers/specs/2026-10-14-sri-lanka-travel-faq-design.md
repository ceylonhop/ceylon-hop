# Sri Lanka travel FAQ — design

**Status:** approved in mockup (v2, 2026-10-14). Source content: the team's Google Doc
*"Sri Lanka Travel FAQ: Your Questions, Answered"* (owner geethmadevan@gmail.com, last edited
2026-10-09). The mockups live in `.superpowers/brainstorm/` (gitignored) and are not the source
of truth — this document is.

## 1. What this is

A new page type: a **reference**, not an article. One page that collects the questions
customers ask us about Sri Lanka as a whole — visas, money, trains, safaris, leeches — grouped
by topic, ordered by when a traveller needs them, and designed to **keep growing** as new
questions come in. The team adds a question by editing one JSON file; the generator does the
rest.

It is deliberately different from the destination guides (`guides/<slug>/`): no itinerary, no
"things to see", no Where-next rail. A guide sells a place; this page answers a question and
gets out of the way.

Out of scope for this step (each is its own later step): a search box; splitting topics onto
their own URLs; back-links from trip pages or guides; a second reference page.

## 2. Reader and tone

Someone on a phone at a specific moment — booking flights, standing at an airport ATM, picking
a safari day. They want one answer and they want it fast. So:

- **Order by trip timeline, not by subject** (visa → before you fly → money → getting around …).
- **Every answer stands alone.** No answer depends on reading the one above it.
- **Answer first, evidence second.** In comparison topics the "Which should you pick?" box comes
  *before* the cards.
- Voice is the doc's own: first person, specific, "Our tip". Never pushy. One Ceylon Hop
  moment per topic at most, and only where it answers the question the reader already has.

## 3. URL, files, build

| Thing | Value |
| --- | --- |
| URL | `/sri-lanka-travel-faq/` — a sibling of the existing posts, depth 1 |
| Content source | `tools/faq/sri-lanka.json` — the team edits this, never the output |
| Generator | `tools/generate-faq.mjs`, called from `generateStaticPages()` in `tools/generate-static-pages.mjs` (next to `generateGuides()`), so the codegen drift test covers the output for free |
| Output | `sri-lanka-travel-faq/index.html` (committed, like every generated page) |
| Photos | `img/faq/<stem>-900.jpg` + `-1800.jpg`, same `sips` convention as `img/guides/` (committed); `img/faq/og.jpg` 1200×630 |
| Page script | `faq-page.js` (root, versioned by `assetV` like `guide-page.js`) |
| Styles | a `FAQ_STYLE` constant in the generator, tokens from `site.css`, same pattern as `GUIDE_STYLE` |
| Sitemap | `sri-lanka-travel-faq/` added to `SITEMAP_EXTRA` in `tools/generate-route-pages.mjs` |
| Blog hub | a crawlable static `.bcard` on `blog.html` under a "Know before you go" heading, placed above the destination-guides block |
| Credits | Unsplash attributions appended to `credits.html` as the guides do |

Rendered through `renderStandalone()` (`tools/render-page.mjs`): same header, footer, `<head>`
assets, analytics and error beacon as every other generated page. `active: 'blog.html'`,
`depth: 1`. Nothing in the chrome is bespoke.

**Splitting later (option C, owner decision 2026-10-14):** the JSON is already per-topic. A
future step may add an `ownPage: true` flag per topic to emit `/sri-lanka-travel-faq/<topic>/`
and turn the section on the main page into a summary + link. Not built now; the schema below
leaves room for it and nothing else about this design assumes one page forever.

## 4. Page anatomy (top to bottom)

Every block reads from the JSON; a topic with no items does not render and is not listed in
the index.

1. **Banner.** The posts' `post-hero has-photo` shape, not the guides' full-bleed hero: ~230px
   on phones / ~300px desktop, photo with the existing bottom scrim. Breadcrumb
   (Home › Travel Guide › Sri Lanka travel FAQ), eyebrow "Ceylon Hop · Travel FAQ", `<h1>`
   **Sri Lanka travel FAQ** (the words people search; "Sri Lanka, answered" was rejected),
   meta line "*N* answers · Updated *date*". *N* is computed by the generator.
2. **Lede.** One handwritten (Caveat) line + "— the Ceylon Hop team", as on the guides.
3. **Topic index.** A compact numbered list — number, topic name, count (e.g. "9" or
   "4 parks"). **Not** a chip row (10 topics don't fit one) and **not** a card grid (pushes
   content down). On desktop (≥ 900px) it is a sticky left column with the current section
   marked by a saffron dot (scroll-spy). On phones it sits inline under the lede.
4. **Topics**, in this fixed order, each with its number, `<h2>`, one-line sub:

   | # | Topic | Shape | Seeds from the doc |
   | --- | --- | --- | --- |
   | 01 | Visa & entry | qa | ETA, the five ways to apply, cost, the Oct-2025 before-departure rule, extensions |
   | 02 | Before you fly | qa | SIM / eSIM, travel cards (Wise/Revolut limits), what to pack for temples and leeches |
   | 03 | Money | qa | exchange rate, where to change, cash vs card, ATMs + DCC, best ATMs, bargaining, tipping, small notes, daily budget |
   | 04 | Getting around | qa | Kandy–Ella train status + booking + class, public buses, Colombo metro buses (routes, paying, good-to-know), the scenic-road tip |
   | 05 | Where to start | qa | first night near the airport; solo, families, limited mobility; the one-direction route |
   | 06 | Wildlife & safaris | compare | Yala, Udawalawe, Wilpattu, Minneriya/Kaudulla; pick-by-priority; good-to-know |
   | 07 | Beaches | compare | Mirissa, Hiriketiya, Unawatuna, Weligama, Tangalle; the "only time for one" tip |
   | 08 | Culture & etiquette | qa | Buddha-statue photos, asking before photographing people, Temple of the Tooth dress + puja times, Poya days (moved here from Food) |
   | 09 | Food & drink | qa | vegan/veg ordering, arrack, Lion beer |
   | 10 | Health & safety | qa | repellent, leeches + salt, Samahan, dispensaries, pharmacies, when to go to hospital, 199, Colombo private hospitals |

   **qa topic:** `<details>` accordions, one column, same markup and animated open as the
   guides' "Your questions" (`.dc` grid-row transition). The first item of the first topic is
   open on load; everything else closed. Each answer may carry, in this order: body HTML; at
   most **one callout** — "Our tip" (saffron, Caveat heading) or "Good to know" (red) — the
   guides' two kinds, no third; at most **one offer row** (the guides' `.ch-row` markup: car
   icon, bold line, sub-line, arrow label); a **foot line**: optional "*what* checked *date*"
   on the left, **Copy link** on the right.

   **compare topic:** one section photo (16:8, credit bottom-right), then the **pick box**
   (cream, "Which should you pick?", bold-label bullets), then **text-only cards** — name,
   "Best for …", a two-column spec list rendered from the card's `spec` object in key order
   (parks use Crowds · Season · Go; beaches use Vibe · Swimming · Surf — any keys, labels are the
   keys title-cased), optional one link ("Mirissa guide →",
   "Tissamaharama transfers →") — two-up on desktop, stacked on phones; then optional notes
   bullets; then the foot line. No photo per card (owner-approved v2: one photo per
   comparison keeps new entries cheap).
5. **Still wondering? (blue band).** One WhatsApp button, prefilled
   "Hi Ceylon Hop, a question about Sri Lanka: ". The page's only generic contact prompt.
6. **Credits line + footer.**

**Phone-only:** a sticky black **"Topics ↑"** pill, bottom-centre, appears once the index has
scrolled out of view and scrolls back to it. Hidden on desktop (the column does that job).

**Photos — owner rule 2026-10-14:** no tuk-tuks and no motorcycles in any photo on this page
(banner or section). Hero candidates from Unsplash: misty tea hills near Nuwara Eliya
(Erik Esly, `ZWdrM9IBBIE`) or the Galle Fort ramparts (Zoshua Colah, `V0QYvYcwFf4`); safari
section: Yala leopard (Tommaso Delton, `_sFOJHDmO6A`); beaches section: Coconut Tree Hill
(Austin Curtis, `nkgwvrUhdUA`). Final picks are made when the photos are resized and credited.

## 5. Content schema (`tools/faq/sri-lanka.json`)

```jsonc
{
  "slug": "sri-lanka-travel-faq",
  "title": "Sri Lanka travel FAQ — visas, money, trains, safaris",   // <title>, ≤ 60 chars
  "description": "…",                                               // <meta>, ≤ 158 chars
  "updated": "2026-10-14",                                          // ISO; rendered "Updated 14 October 2026"
  "hero": { "photo": "hero", "alt": "…" },                          // stem in img/faq/
  "lede": "The things people ask us most, answered by the people who drive here every week.",
  "ask": { "wa": "Hi Ceylon Hop, a question about Sri Lanka: " },
  "topics": [
    { "id": "visa", "name": "Visa & entry", "sub": "What you need before you fly, and how to stay longer.",
      "shape": "qa",
      "items": [
        { "id": "how-to-get",                                       // anchor = <topic.id>-<item.id>
          "q": "How do I get a visa for Sri Lanka?",
          "a": "<p>…</p>",                                          // HTML; may contain {fare:…} tokens, see §6
          "tip": { "kind": "know", "text": "…" },                   // kind: "tip" | "know"; at most one
          "offer": { "title": "…", "sub": "…", "href": "search.html?from=kandy&to=nanu-oya", "label": "See price & book" },
          "checked": { "what": "Rules", "date": "2026-10-09" } }    // only on dated facts
      ] },
    { "id": "safaris", "name": "Wildlife & safaris", "sub": "…",
      "shape": "compare", "count": "4 parks",                       // index label; default is items.length
      "photo": "yala",
      "pick": { "q": "Which park should you pick?", "items": [{ "label": "Leopards", "text": "…" }] },
      "cards": [{ "name": "Yala", "bestFor": "…", "spec": { "crowds": "…", "season": "…", "go": "…" },
                  "link": { "text": "Tissamaharama transfers →", "href": "trip/" } }],
      "notes": ["Mornings (6 – 10 AM) give the best sightings…"],
      "checked": { "what": "Seasons & closures", "date": "2026-10-09" } }
  ],
  "photos": { "hero": { "alt": "…", "credit": "Erik Esly", "creditUrl": "…", "focal": "50% 60%", "w": 1800, "h": 1013 }, … }
}
```

Facts the generator computes, never the JSON: answer count, per-topic counts, anchor ids,
the Copy-link URLs, JSON-LD, the "Updated" line's long date, every `{fare:…}` figure.

**Anchor ids** are `<topic.id>-<item.id>` for qa items and `<topic.id>` for compare
sections and topic headings. They are part of the page's contract — the team will paste them
into WhatsApp replies — so once published an id is never renamed, only retired.

## 6. Prices never typed by hand

The doc hard-codes Ceylon Hop fares (USD 27.49, 19.99, 22.99, 29.99 …). Those are exactly the
figures the parity tests exist to keep out of hand-written files. Rule for this page:

- A Ceylon Hop fare appears in an answer only as a token, `{fare:<fromId>:<toId>:<service>}`
  (`service` = `shared` | `private`), which the generator resolves at build time from
  `transfers-data.js` via `loadTransfers()` — the same baked-catalogue source the guides'
  Where-next cards use for their `data-list-fare` figures.
- A unit test asserts the JSON contains no literal fare pattern (`/\bUSD\s?\d+\.(49|99)\b/`)
  and that every token resolves. Third-party numbers (the USD 20 visa fee, LKR ATM fees,
  "USD 25–50 a day") are ordinary text and stay in the JSON.
- The "What does a day cost?" answer keeps the doc's budget tiers but names at most two
  tokenised fares per tier and links to `trip/` for the rest.

## 7. Links — every one resolves

| Link | Target |
| --- | --- |
| Header / footer | `renderChrome()` output — identical to every generated page |
| Topic index entries, "Topics ↑" pill | in-page `#<id>` |
| Copy link | `https://ceylonhop.com/sri-lanka-travel-faq/#<topic>-<item>` (absolute, from `ORIGIN`) |
| Offer rows | `search.html?from=<id>&to=<id>`, `plan.html?…`, `trip/`, or `https://wa.me/94779669662?text=<encoded>` (the chrome's `WA`) — relative links resolved for depth 1 |
| Compare-card links | `guides/<slug>/` or `trip/<from>-to-<to>/` (must exist) |
| Still wondering | `https://wa.me/94779669662?text=<encoded ask.wa>` |
| Breadcrumb | `index.html`, `blog.html` |
| Photo credits | `credits.html` |

A unit test walks every relative `href`/`src` in the generated page and asserts the file
exists in the repo, exactly as `guide-pages.test.js` does.

## 8. SEO

- `<title>`, `<meta name="description">`, self-canonical
  `https://ceylonhop.com/sri-lanka-travel-faq/`, OG tags (`img/faq/og.jpg`) — via
  `renderStandalone`.
- JSON-LD: `FAQPage` whose `mainEntity` is every qa item plus, for each compare topic, one
  `Question` (the pick box's `q`) whose answer is the pick-box text; `Article`
  (author/publisher Organization "Ceylon Hop", `dateModified` = `updated`);
  `BreadcrumbList` (Home › Travel Guide › Sri Lanka travel FAQ).
- In `sitemap.xml`; linked from `blog.html` in static HTML (crawlable without JS).
- Closed `<details>` content is still indexed; the FAQPage markup carries the rich result.

## 9. Behaviour (`faq-page.js`, classic script, no dependencies)

- **Deep link on load:** if `location.hash` matches a qa item, open that `<details>` and
  scroll it under the sticky bar. If it matches a topic, scroll to the heading.
- **Copy link:** writes the absolute URL to the clipboard (`navigator.clipboard`, with a
  `execCommand('copy')` fallback), swaps the label to "Copied" for 1.5 s, sets `aria-live`.
  Also sets `location.hash` without scrolling (`history.replaceState`) so the address bar
  matches what was copied.
- **Scroll-spy** on the desktop index: IntersectionObserver with the guides' rootMargin
  (`-40% 0px -55% 0px`), marks the current topic.
- **Topics pill:** shown when the index's bottom edge is above the viewport
  (IntersectionObserver on the index), click scrolls to the index.
- Accordion open/close is native `<details>`; the animation is CSS (`.dc`), copied from the
  guides. Reveal-on-scroll: the site's `.reveal` rule and timing, as the guides.
- Every animation and smooth scroll disabled under `prefers-reduced-motion`.

## 10. Mobile

Container/media rules at < 900px: single column; index inline; compare cards stacked; pill
visible; spec lists stay two columns; banner 230px. Verified at 390px in the v2 mockup
(2026-10-14) alongside 1180px desktop.

## 11. Content work in this step

The doc is migrated into the JSON by the implementer with these editorial changes, each a
visible diff for the team to review in the PR:

1. Fix the doc's numbering ("10. SIM cards" inside Money → moves to *Before you fly*).
2. Poya-day alcohol rule moves from *Food & drink* to *Culture & etiquette* (it's a calendar
   fact, and it is duplicated in the doc — keep one).
3. Budget tiers: fares tokenised per §6; prose otherwise kept.
4. *Where to start* answers are phrased as the question the reader has ("I'm travelling solo —
   where should I start?").
5. Beaches: Mirissa and Hiriketiya cards link to their guides; Weligama/Unawatuna/Tangalle
   have no link yet.
6. "MediHelp" is dropped from the hospital list until the team supplies an address.
7. `checked` dates (2026-10-09, the doc's last edit) go on: all of *Visa & entry*; the
   exchange rate; ATM fees and caps; Kandy–Ella line status; the Colombo metro items; park
   seasons and closures; whale season; Temple of the Tooth puja times; the hospital list.
   Nothing else carries one.
8. Facts are **not re-verified** in this step (same stance as the guides, §11 there). The
   `checked` lines make staleness visible; verification is the team's.

## 12. Testing

- **Unit (vitest, `web-tests/unit/faq-page.test.js`):** the generator emits
  `sri-lanka-travel-faq/index.html`; canonical, `FAQPage`, `Article` and `BreadcrumbList`
  present; FAQPage `mainEntity` count = qa items + compare topics; header and footer present
  without JS (same shape as `static-chrome-crawlable.test.js`); topic order matches §4 and the
  index lists exactly the topics with items; every anchor id is unique and every index `href`
  matches a section id; the first item is `open`, no other `<details>` is; **no literal fare
  pattern in the JSON and every `{fare:…}` token resolved** (§6); `checked` renders only where
  the JSON has it; every relative href/src resolves; the sitemap lists the page; `blog.html`
  links it; **no "tuk-tuk" or "tuktuk" in any photo `alt`** (§4 photo rule).
- **Codegen drift:** covered automatically by `seo-codegen.test.js` via `generateStaticPages()`.
- **E2E (Playwright, `web-tests/e2e/faq-page.spec.js`, offline via `blockLiveApi`):** page
  loads; clicking an index entry scrolls to the topic; a closed item opens on click; loading
  with `#visa-extend` opens that item; Copy link puts the absolute URL on the clipboard (grant
  `clipboard-read`/`clipboard-write`) and sets the hash; at 390px the Topics pill is hidden
  at the top and visible after scrolling past the index, and clicking it returns to the
  index; at 1180px the index column is sticky and marks the topic in view.
- Gate: `cd web-tests && npm run test:all` green; `npm run generate` then `npm run stamp`
  leave no diff.

## 13. Risks and choices

- **Dated facts will drift** — the FX rate, metro routes, park closures, the Kandy–Ella line.
  Per-item `checked` lines are the mitigation; the Still-wondering band is the feedback path.
  A recurring "re-check the dated items" task is the team's, not this page's.
- **The Kandy → Nanu Oya offer row** is correct only while the line is closed. When the line
  reopens the item's answer and offer both change — that is a content edit, not a code change.
- **Search was considered and dropped** for v1 (needs a client-side filter, only finds words
  on the page, and the index does the job at ~47 questions). Revisit past ~100.
- **Per-topic URLs** (option B) were weighed against one page (A); the owner chose one page
  now, splittable later (C). The schema and anchor contract are the only things that
  prepare for it.
- **Photos are Unsplash placeholders**, credited on the page and in `credits.html`; replace
  with the team's own over time by swapping files in `img/faq/` (same stems).
