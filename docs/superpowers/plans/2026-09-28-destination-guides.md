# Destination Guides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first destination guide (`/guides/nuwara-eliya/`) as a generated page from a JSON content file, wired into the site's chrome, sitemap, blog hub, live-fare script and test gates.

**Architecture:** A new generator `tools/generate-guides.mjs` reads `tools/guides/<slug>.json` and renders through `renderStandalone()` (same chrome/head as every generated page). It is called from `generateStaticPages()` so the existing codegen-drift test covers the output. Page behaviour lives in one classic script `guide-page.js`; Where-next prices reuse `route-list-fares.js` unchanged.

**Tech Stack:** Node 20 ESM generators (`tools/*.mjs`), hand-written CSS on `site.css` tokens, vanilla JS, Vitest (`web-tests/unit`), Playwright (`web-tests/e2e`). No new dependencies.

Spec: `docs/superpowers/specs/2026-09-28-destination-guides-design.md`.

## Global Constraints

- Branch `feat/destination-guides` in the worktree at `/private/tmp/claude-501/-Users-roshenw-claude-code-ceylon-hop/1205c0ba-cadd-4617-a384-2045a494c60b/scratchpad/wt-guides` (never the shared tree). Start every command chain with `cd <worktree> || exit 1`.
- Generated output is committed; `npm run generate` (repo root) must leave no diff. Never hand-edit `guides/*/index.html`.
- No prices, no train row, no "tuk-tuk" inside the Getting-here section. Prices stay on Where next.
- Every relative `href`/`src` in the page must resolve to a file in the repo.
- Header/footer come only from `renderChrome()`; nothing bespoke.
- Gate before the PR: `cd web-tests && npm run test:all` (vitest + Playwright) green, `cd api && npm run check` untouched (no `api/` changes in this step).
- Photos: Unsplash, credited on the page and in `credits.html`, downloaded at `w=1800&h=1125&fit=crop` (16:10) — hero at `w=1800&h=1013` (16:9) — then `sips -Z 900` for the 900 file.
- Commit attribution line: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File structure

| File | Responsibility |
| --- | --- |
| `tools/guides/nuwara-eliya.json` | All guide content (team-editable) |
| `img/guides/nuwara-eliya/*-900.jpg`, `*-1800.jpg` | Guide photos |
| `tools/generate-guides.mjs` | JSON → HTML (sections, CSS, JSON-LD, where-next cards) |
| `guide-page.js` | Reveal, jump nav, FAQ tabs, More toggles |
| `tools/generate-static-pages.mjs` | Calls `generateGuides()` |
| `tools/generate-route-pages.mjs` | Exports `BASE_PAIRS`; `SITEMAP_EXTRA` gains the guide |
| `guides/nuwara-eliya/index.html` | Generated output (committed) |
| `blog.html` | Static "Destination guides" card block |
| `credits.html` | Unsplash attributions |
| `web-tests/unit/guide-content.test.js` | JSON + photo files sanity |
| `web-tests/unit/guide-pages.test.js` | Generated page contract |
| `web-tests/e2e/guide-page.spec.js` | Behaviour in a real browser, offline |

---

### Task 1: Content file and photos

**Files:**
- Create: `tools/guides/nuwara-eliya.json`
- Create: `img/guides/nuwara-eliya/<stem>-1800.jpg` and `<stem>-900.jpg` for 17 stems
- Modify: `credits.html` (append 17 rows after the last `Tour gallery` row, before `</ul>`)
- Test: `web-tests/unit/guide-content.test.js`

**Interfaces:**
- Produces: the JSON shape in spec §5, read by Task 2's `loadGuides()`; photo stems referenced by `hero.photo`, `places[].photo`, `onTheWay.stops[].photo`, `eat[].photo`, `stay[].photo` must all be keys in `photos`.

- [ ] **Step 1: Write the failing test**

`web-tests/unit/guide-content.test.js`:

```js
// Every destination guide's JSON must be internally consistent and every photo it names must
// exist at both sizes with the dimensions the JSON declares (the <img width/height> reserve
// the box; a wrong ratio shifts layout — same lesson as tools/place-photos.mjs).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'tools/guides');
const guides = readdirSync(DIR).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(readFileSync(path.join(DIR, f), 'utf8')));

const photoKeys = g => [
  g.hero.photo,
  ...g.places.map(p => p.photo),
  ...(g.onTheWay?.stops || []).map(s => s.photo),
  ...g.eat.map(e => e.photo),
  ...g.stay.map(s => s.photo),
].filter(Boolean);

describe('destination guide content', () => {
  it('has at least the Nuwara Eliya guide', () => {
    expect(guides.map(g => g.slug)).toContain('nuwara-eliya');
  });
  for (const g of guides) {
    describe(g.slug, () => {
      it('has exactly four facts, a placeId, a title and description within SERP limits', () => {
        expect(g.facts).toHaveLength(4);
        expect(g.placeId).toBeTruthy();
        expect(g.title.length).toBeLessThanOrEqual(70);
        expect(g.description.length).toBeLessThanOrEqual(160);
      });
      it('names only photos it declares, and every declared photo exists at 900 and 1800', () => {
        for (const k of photoKeys(g)) expect(g.photos, `photo "${k}"`).toHaveProperty(k);
        for (const [k, meta] of Object.entries(g.photos)) {
          for (const size of [900, 1800]) {
            const f = path.join(ROOT, 'img/guides', g.slug, `${k}-${size}.jpg`);
            expect(existsSync(f), f).toBe(true);
          }
          expect(meta.alt, `${k}.alt`).toBeTruthy();
          expect(meta.credit, `${k}.credit`).toBeTruthy();
          expect(meta.creditUrl, `${k}.creditUrl`).toMatch(/^https:\/\/unsplash\.com\//);
        }
      });
      it('declares the real pixel size of each -1800 file', () => {
        for (const [k, meta] of Object.entries(g.photos)) {
          const f = path.join(ROOT, 'img/guides', g.slug, `${k}-1800.jpg`);
          const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', f], { encoding: 'utf8' });
          const w = Number(/pixelWidth:\s*(\d+)/.exec(out)[1]);
          const h = Number(/pixelHeight:\s*(\d+)/.exec(out)[1]);
          expect([w, h], k).toEqual([meta.w, meta.h]);
        }
      });
      it('credits every photographer in credits.html', () => {
        const credits = readFileSync(path.join(ROOT, 'credits.html'), 'utf8');
        for (const [k, meta] of Object.entries(g.photos)) {
          expect(credits, `${k} → ${meta.credit}`).toContain(meta.creditUrl);
        }
      });
    });
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd <worktree>/web-tests && npx vitest run unit/guide-content.test.js`
Expected: FAIL — `ENOENT … tools/guides` (directory has no JSON yet).

- [ ] **Step 3: Download and resize the photos**

```bash
cd <worktree> || exit 1
mkdir -p img/guides/nuwara-eliya && cd img/guides/nuwara-eliya || exit 1
dl() { # stem, unsplash file id, h
  curl -sL -o "$1-1800.jpg" "https://images.unsplash.com/$2?auto=format&fit=crop&w=1800&h=$3&q=80&fm=jpg"
  sips -Z 900 "$1-1800.jpg" --out "$1-900.jpg" >/dev/null
}
dl hero          photo-1708338914870-797de586672d 1013
dl horton        photo-1671432751719-d1a032c1a369 1125
dl pedro         photo-1586193804147-64d5c02ef9c1 1125
dl gregory       photo-1756645579704-10a7f619956c 1125
dl hakgala       photo-1656497107000-d0859a4017ee 1125
dl town          photo-1764600276944-537340511979 1125
dl single-tree   photo-1677223625838-efaac01a5efb 1125
dl moon-plains   photo-1706795561189-c40c8d312a51 1125
dl ambewela      photo-1619974643633-12acfdcedd16 1125
dl lovers-leap   photo-1609681980718-340e7f4b11d7 1125
dl ramboda       photo-1609515286252-3429567a66fd 1125
dl strawberries  photo-1760028723962-efd99c636031 1125
dl hill-club     photo-1743525700011-afac212694d7 1125
dl pedro-cafe    photo-1544015759-237f87d55ef3 1125
dl rice-curry    photo-1742281095650-dd3c50c08772 1125
dl heritance     photo-1701544872167-7f5ee73cb435 1125
dl grand-hotel   photo-1665915664670-5d255395be1c 1125
for f in *-1800.jpg; do sips -g pixelWidth -g pixelHeight "$f" | tr '\n' ' '; echo; done
```

Expected: 17 pairs of files; every `-1800` reports `pixelWidth: 1800`, `pixelHeight: 1125` (hero: 1013). Also call the Unsplash `track_download` tool once per photo id (API guideline).

- [ ] **Step 4: Write the content file**

`tools/guides/nuwara-eliya.json` (the exact content approved in mockup v22; `text`/`a`/`sell`/`intro` fields may hold inline HTML, everything else is plain text):

```json
{
  "slug": "nuwara-eliya",
  "name": "Nuwara Eliya",
  "region": "Hill country",
  "placeId": "nuwara-eliya",
  "title": "Nuwara Eliya guide — Horton Plains, tea, where to stay | Ceylon Hop",
  "description": "What to do in Nuwara Eliya, from Horton Plains at dawn to the tea estates: hours, how far from town, what to wear, where to eat and stay, and how we drive you up the hill.",
  "checked": "September 2026",
  "hero": {
    "photo": "hero",
    "intro": "Mornings are misty, nights are cold, and it feels nothing like the coast. A hill-country town at 1,868 m, ringed by tea — the British called it Little England and built it to match."
  },
  "facts": [
    { "label": "Stay", "value": "2 nights" },
    { "label": "Altitude", "value": "1,868 m" },
    { "label": "Daytime", "value": "18–24", "unit": "°C" },
    { "label": "Between", "value": "Kandy & Ella" }
  ],
  "lede": "Most people stay two nights, usually on their way between Kandy and Ella —",
  "ledeEm": "one day for Horton Plains, one for the town and tea.",
  "gettingHere": {
    "heading": "We’ll bring you up the hill",
    "sub": "Hotel to hotel, fixed price, one driver who knows the road. From wherever you are.",
    "origins": [
      { "id": "kandy", "title": "From Kandy", "from": "75 km · 2 h 45 · most people arrive from here",
        "sell": "The A5 is 60 km of hairpins after Gampola. Our drivers do it every week — no overtaking on the bends, a stop at Ramboda Falls, and they know which roadside stall has the good strawberries." },
      { "id": "ella", "title": "From Ella", "from": "55 km · 1 h 45 · the return leg of the loop",
        "sell": "Up through the Ella Gap with the southern plain opening below you, past Hakgala gardens, then tea all the way. We can stop at the gardens on the way in if you’d like." },
      { "id": "cmb-airport", "title": "Straight from the airport", "from": "CMB · 170 km · about 5 h 30 with a lunch stop",
        "sell": "Your driver meets you at arrivals with your name; you sleep in the hills that night. The easiest way to start a trip if you want the cool air first and the beaches last." }
    ],
    "train": "It’s a beautiful ride and we’ll never tell you not to. Two things to know: the line stops at <b>Nanu Oya, 9 km from town</b>, so you still need a ride at the end; and reserved seats go on sale 30 days ahead and sell out in season (the unreserved carriages always have room if you don’t mind standing). From Kandy it’s about 4 h, from Ella about 3 h. Message us and we’ll check seats for your date — and tell you which side to sit on."
  },
  "places": [
    { "id": "horton-plains", "name": "Horton Plains & World’s End", "photo": "horton",
      "text": "A high plateau with a 9.5 km walking loop that leads to World’s End — a cliff with a drop of around 880 m — and Baker’s Falls. It is not near town: 32 km and about an hour on a narrow mountain road, which is why the early start matters.",
      "spec": { "from": "32 km · about 1 h from town", "open": "Gate opens 6 AM · last entry mid-afternoon", "give": "3–4 hours on the loop", "ticket": "≈ Rs 7,000 foreign adult · pay at the gate" },
      "tip": { "kind": "drivers", "text": "Go first thing in the morning. By mid-morning the mist usually rolls in and the view disappears. No phone signal on the plains — download the map before you leave the hotel. Leave the hotel by 5:30 and you’ll be at World’s End before the tour buses. Bring a jumper you can take off — it’s 8° at the gate and 20° by ten." },
      "offer": { "title": "5:30 AM pickup with Ceylon Hop", "sub": "Wait at the park and the drive back included",
        "wa": "Hi Ceylon Hop — I’m reading your Nuwara Eliya guide. Could you give me a price for a 5:30 AM Horton Plains pickup from my hotel, with the wait and the drive back?" } },
    { "id": "pedro", "name": "Pedro Tea Estate", "photo": "pedro",
      "text": "A working tea estate 3 km from town. A short tour shows you withering, rolling and firing, then you get a cup in the café over the bushes it came from.",
      "spec": { "from": "3 km · 10 min from town", "open": "Tours Mon–Sat, mornings · factory idle Sun", "give": "45 min–1 h" },
      "tip": { "kind": "drivers", "text": "Go in the morning while the machines are running — an idle factory is just a big shed. Lover’s Leap waterfall is a 20-minute walk up from the estate gate and free." } },
    { "id": "gregory-lake", "name": "Gregory Lake", "photo": "gregory",
      "text": "The lake in the middle of town. It’s nice for a slow walk in the morning or late afternoon; the full loop is about 4 km and flat.",
      "spec": { "from": "In town · walk from most hotels", "open": "Open all day · small entry fee to the lakeside park", "give": "1 h for the loop" },
      "tip": { "kind": "warn", "text": "If you fancy a boat or horse ride, agree on the price first. It isn’t fixed, and some visitors felt short rides weren’t great value." } },
    { "id": "hakgala", "name": "Hakgala Botanical Garden", "photo": "hakgala",
      "text": "A cool, shady botanical garden on the road to Ella — ferns, roses, an orchid house and a lot of monkeys. Easy walking, good for families and for the day after Horton Plains.",
      "spec": { "from": "10 km · 20 min, on the Ella road", "open": "Opens 7:30 AM · closes late afternoon", "give": "1–2 hours" },
      "tip": { "kind": "drivers", "text": "If you’re leaving for Ella, we stop here on the way out — no need to come back for it." } },
    { "id": "town", "name": "Victoria Park & the old town", "photo": "town",
      "text": "A neat Victorian park next to the red-brick post office, with the racecourse and the golf course beyond it. Birdwatchers come for the hill-country species; everyone else comes in April when the flower beds peak. Give the town itself an hour: the covered market for strawberries and vegetables, the post office, a look at the Hill Club from the road.",
      "spec": { "from": "In town", "open": "Park opens 7 AM · small entry fee", "give": "1 h with the market" } },
    { "id": "single-tree-hill", "name": "Single Tree Hill at sunrise", "photo": "single-tree",
      "text": "The viewpoint above town. A steep 40-minute walk up through tea from the Haddon Hill road, and the whole valley below you as the mist burns off. The morning you’re not doing Horton Plains, do this.",
      "spec": { "from": "2 km · start on foot from town", "open": "Free · go for 6 AM", "give": "2 hours there and back" } },
    { "id": "moon-plains", "name": "Moon Plains", "photo": "moon-plains",
      "text": "The gentle alternative to Horton Plains: a grassland plateau 15 minutes from town with a jeep ride to a 360° viewpoint and, on a clear day, Adam’s Peak on the horizon. Sambar deer most mornings.",
      "spec": { "from": "6 km · 15 min from town", "open": "Opens 7 AM · jeep included in the ticket", "give": "1–1.5 hours" },
      "tip": { "kind": "drivers", "text": "Can’t face the 5:30 start, or travelling with small children? This gives you the plains feeling without the long road." } },
    { "id": "ambewela", "name": "Ambewela farms", "photo": "ambewela",
      "text": "Dairy country on the way to Horton Plains — black-and-white cows, wide green paddocks and a farm shop with fresh milk, yoghurt and cheese. Locals call it Little New Zealand. Children love it; adults like the yoghurt.",
      "spec": { "from": "20 km · on the Horton Plains road", "open": "Open daily, daytime · small entry fee", "give": "45 min" },
      "tip": { "kind": "drivers", "text": "The easy add-on to a Horton Plains morning — you pass the gate on the way back down." } },
    { "id": "lovers-leap", "name": "Lover’s Leap waterfall", "photo": "lovers-leap",
      "text": "A 30 m fall above the Pedro estate with a legend attached (a prince, a village girl, a leap). The walk up from the estate is 20 minutes through tea, the pool at the bottom is cold, and it costs nothing.",
      "spec": { "from": "4 km · walk up from Pedro estate", "open": "Free · daylight", "give": "1 h with the walk" } }
  ],
  "furtherAfield": [
    { "time": "2 h", "name": "Adam’s Peak (Sri Pada)", "text": "The night climb to the summit for sunrise: 5,500 steps, pilgrims all the way up. Season is December to May; outside it the path is dark and the tea shops shut. We drive you to Dalhousie the evening before." },
    { "time": "1 h 45", "name": "Lipton’s Seat & Haputale", "text": "Where Sir Thomas Lipton looked at his tea. A tuk-tuk up through the Dambatenne estate, five provinces in view on a clear morning. Combine with the road to Ella." },
    { "time": "1 h 15", "name": "Ramboda & the tea-country waterfalls", "text": "Ramboda, Devon and St Clair’s, all on or just off the Kandy road — the reason to do that drive in daylight rather than by night bus." }
  ],
  "itinerary": {
    "eyebrow": "If you have two days", "heading": "A plan that works",
    "sub": "The order matters here: mist by mid-morning, factories closed on Sundays, cold after dark.",
    "days": [
      { "title": "Day 1 · The plains", "sub": "Early start, easy afternoon", "steps": [
        { "time": "5:30", "title": "Pickup from your hotel", "text": "It’s cold. Jacket, water, no plastic bags.", "us": true },
        { "time": "6:30", "title": "Horton Plains loop", "text": "World’s End first while it’s clear, then Baker’s Falls. 3–4 h." },
        { "time": "11:00", "title": "Pedro Tea Estate", "text": "Factory running, tea in the café after." },
        { "time": "16:00", "title": "Gregory Lake", "text": "Slow walk, agree any boat price first." },
        { "time": "19:00", "title": "Dinner at The Hill Club", "text": "Smart dress code. Ask for extra blankets at the hotel." } ] },
      { "title": "Day 2 · Town, gardens, onward", "sub": "Unhurried, then the road to Ella", "steps": [
        { "time": "9:00", "title": "Hakgala Botanical Garden", "text": "Shady, easy walking, 1–2 h." },
        { "time": "11:30", "title": "Victoria Park & the post office", "text": "Cash from the ATMs in town while you’re here." },
        { "time": "13:00", "title": "Lunch, then check out" },
        { "time": "14:00", "title": "Onward to Ella with us", "text": "1 h 45 by car, past Hakgala and down through the Ella Gap with the whole southern plain opening up below you. Or the 3 h train from Nanu Oya, if you have a seat.", "us": true } ],
        "book": { "stops": ["Nuwara Eliya", "Ella"], "nights": [0, 0], "preload": "Opens the planner with <b>Nuwara Eliya → Ella</b> already in — we stop at Hakgala on the way." } }
    ]
  },
  "months": {
    "heading": "The weather, month by month",
    "sub": "Two monsoons hit the hill country from opposite sides, so the town has two wet seasons and one long clear one. Views are never guaranteed, but the odds change a lot.",
    "blocks": [
      { "label": "Dec – Feb", "title": "Clear & cold", "text": "The best odds of a view at World’s End. Nights can touch 5°; hotels sell out over Christmas.", "tag": "Best for Horton Plains", "tone": "best" },
      { "label": "Mar – Apr", "title": "Season", "text": "Flower shows, the races, Sinhala & Tamil New Year in April. Warm days, busy town — book everything early.", "tag": "Busiest", "tone": "best" },
      { "label": "May – Sep", "title": "South-west monsoon", "text": "Rain and mist on the western slopes, often clearing by afternoon. Fewer people, greener tea, cheaper rooms.", "tone": "wet" },
      { "label": "Oct – Nov", "title": "Showers", "text": "The wettest weeks: afternoon storms most days. Mornings are still your friend. Leech socks for the plains.", "tone": "wet" }
    ]
  },
  "onTheWay": {
    "eyebrow": "On the road from Kandy", "heading": "Worth stopping for",
    "sub": "These are on the way, not in town. Your driver can stop — just ask.",
    "note": "Stops are free on a Ceylon Hop transfer — the link opens WhatsApp with the stop already typed, and we tell the driver.",
    "stops": [
      { "km": "Ramboda · on the A5", "name": "Seetha Amman Temple & Ramboda Falls", "photo": "ramboda",
        "text": "A temple linked to the Ramayana, with a tall waterfall nearby. Cover shoulders and knees; shoes off at the temple.",
        "wa": "Hi Ceylon Hop — on my Kandy → Nuwara Eliya transfer, could we stop at Ramboda Falls and Seetha Amman Temple? (From your Nuwara Eliya guide.)" },
      { "km": "Roadside · above 1,500 m", "name": "Strawberry & veggie stalls", "photo": "strawberries",
        "text": "The hill country grows strawberries, carrots and leeks. Stalls sell them fresh along the road — great for snacks.",
        "wa": "Hi Ceylon Hop — on my Kandy → Nuwara Eliya transfer, could we stop at a roadside strawberry stall? (From your Nuwara Eliya guide.)" }
    ]
  },
  "eat": [
    { "tier": "Family", "pick": true, "photo": "hill-club", "name": "The Hill Club",
      "text": "Old-style dining in a 19th-century club — five courses, a fire in the grate. <em>Smart dress code: jacket for men, and they lend one.</em>",
      "band": "$$$", "flags": ["Dinner", "Book ahead"], "map": "The Hill Club, Nuwara Eliya" },
    { "tier": "Café", "photo": "pedro-cafe", "name": "Pedro Tea Estate café",
      "text": "A cup of the estate’s own tea looking over the bushes it came from. <em>Go after the factory tour, before the mist.</em>",
      "band": "$", "flags": ["Morning"], "warn": ["Cash only"], "map": "Pedro Tea Estate, Nuwara Eliya" },
    { "tier": "Budget", "photo": "rice-curry", "name": "Rice & curry by the bus stand",
      "text": "The lunch places around the bus stand and the market do a plate of rice, dhal and four curries for a few hundred rupees, 11:30 to about 2. <b>This is where our drivers eat.</b> <em>Ask for it “not too spicy” if you mean it.</em>",
      "band": "$", "flags": ["Lunch"], "warn": ["Cash only"], "map": "Nuwara Eliya bus stand" }
  ],
  "eatCollector": { "title": "Where did you eat well?", "text": "Tell us your favourite place in Nuwara Eliya and we’ll check it out for the next traveller.", "fine": "A photo of the menu is even better.",
    "wa": "Hi Ceylon Hop — a place I ate well in Nuwara Eliya: " },
  "stay": [
    { "tier": "Luxury", "pick": true, "photo": "heritance", "name": "Heritance Tea Factory",
      "text": "A real 1930s tea factory turned hotel, 15 min above town, tea bushes to the door. <em>The one people talk about afterwards.</em>",
      "band": "$$$", "flags": ["Couples", "Out of town"] },
    { "tier": "Luxury", "photo": "grand-hotel", "name": "The Grand Hotel · Jetwing St Andrew’s",
      "text": "The two colonial classics in town — lawns, afternoon tea, walking distance to the lake and the park. <em>Grand is bigger; St Andrew’s is quieter.</em>",
      "band": "$$$", "flags": ["Families", "In town"] },
    { "tier": "Mid-range", "photo": "gregory", "name": "Guesthouses around Gregory Lake",
      "text": "The family-run places on the lake road and up Haddon Hill are where most of our customers stay: $30–60 a night with breakfast, hot water, and owners who’ll book your Horton Plains driver at reception. <em>Ask for a room with a heater or a fireplace — it’s worth the extra.</em> Travelling solo? There are two or three decent hostels in the centre — message us and we’ll say which.",
      "band": "$–$$", "flags": ["Couples, families, solo", "Near town"] }
  ],
  "stayCollector": { "title": "Stayed somewhere great?", "text": "Guesthouse, hostel, homestay — tell us and we’ll add the good ones here.",
    "wa": "Hi Ceylon Hop — a place I stayed and liked in Nuwara Eliya: " },
  "faq": [
    { "tab": "Planning", "items": [
      { "q": "Is Nuwara Eliya worth visiting?", "a": "<p>If you like cool air, tea country and a morning on the plains — yes, and it breaks the Kandy–Ella journey in the right place. If you want beaches, nightlife or a warm swim, this isn’t that. The town itself is a half-day; the country around it is the point.</p>" },
      { "q": "How many days do I need?", "a": "<p>Two nights. One morning for Horton Plains, one for the town and a tea estate. A single night works if you skip the plains; three if you want Adam’s Peak or a slow day.</p>" },
      { "q": "When is the best time to visit?", "a": "<p>December to April for clear mornings; April is the busiest and the most fun. May to November is wetter but quieter and cheaper — mornings are usually still fine. <a href=\"#when\">Month by month ↑</a></p>" },
      { "q": "Can I do it as a day trip from Kandy?", "a": "<p>You can, but it’s five and a half hours of driving for a few hours in town, and you miss the one thing worth coming for — the plains at dawn. Stay the night.</p>" } ] },
    { "tab": "Trains", "items": [
      { "q": "Does the train go into Nuwara Eliya?", "a": "<p>Not quite. The train stops at Nanu Oya, about 9 km from town, so you’ll still need a ride for the last stretch.</p><p>If you’d rather skip the change, we do the whole trip from Kandy hotel to hotel, and stop at Ramboda Falls on the way. <a href=\"#here\">See how we get you here ↑</a></p>" },
      { "q": "Which train should I take?", "a": "<p>From Kandy, take the train to Nanu Oya. To carry on to Ella, take Nanu Oya → Ella — one of the prettiest stretches on the whole line.</p>" },
      { "q": "Can I go from Kandy to Ella in one day?", "a": "<p>You can, but it’s a very long day. Stopping in Nuwara Eliya makes it much easier.</p>" },
      { "q": "Are train tickets easy to get?", "a": "<p>Reserved seats go on sale 30 days ahead and sell out fast in season. If they’re gone, the unreserved second-class carriages always have space — you may stand for part of it, and it’s the same view. Message us on WhatsApp and we’ll check what’s left for your date.</p>" },
      { "q": "What if the train is delayed or cancelled?", "a": "<p>It happens, especially in heavy rain. Don’t plan anything tight on the same day.</p>" } ] },
    { "tab": "Pack & wear", "items": [
      { "q": "How cold does it really get?", "a": "<div class=\"temps\"><div><b>18–24°</b><small>Day</small></div><div><b>10–14°</b><small>Night</small></div><div><b>8–10°</b><small>Dawn</small></div><div><b>Colder</b><small>Horton</small></div></div><p>Mist and rain can show up any time, which makes it feel colder than the number says.</p>" },
      { "q": "What should I wear?", "a": "<ul class=\"pack\"><li>Layers: t-shirt, jumper, jacket</li><li>Long trousers</li><li>A rain jacket</li><li>Closed shoes with grip</li></ul>" },
      { "q": "What should I bring for Horton Plains?", "a": "<p>A warm layer for the early start, a rain jacket, sunscreen and water. Plastic bags aren’t allowed in the park.</p>" },
      { "q": "Will my hotel have heating?", "a": "<p>Many places don’t. Ask for extra blankets when you check in, or pick a room with a fireplace — the guesthouses here charge a little more for them and it’s worth it in December.</p>" },
      { "q": "What if I get ill or hurt up here?", "a": "<p>There are pharmacies along the main street and a district general hospital in town. Altitude and cold catch people out more than anything else — drink water, take the first day slowly.</p>" } ] },
    { "tab": "Good to know", "tips": [
      "Carry some cash. Tea factories, stalls and small shops are often cash-only. The bank ATMs are around the post office — and they can run dry on long weekends, so don’t arrive with nothing.",
      "Tuk-tuk fares aren’t metered. Agree the price first: a few hundred rupees across town, more to the tea estates, and a proper negotiation for Horton Plains. Your hotel will tell you what’s fair today.",
      "No phone signal on Horton Plains and patchy on the Kandy road. Download your map and this page before you set off.",
      "The Hill Club means it about the dress code — jacket and tie for men at dinner (they lend both), no trainers. Ask the day before.",
      "If someone says a place is “closed today” and offers another, check with us first — it usually isn’t.",
      "Leeches in the wet months at Horton Plains. Long socks, or buy leech socks at the gate.",
      "The roads are twisty. If you get car sick, take a tablet before the drive up.",
      "April is busy — flower shows, horse races, New Year travel. Book early.",
      "Full-moon (Poya) days: alcohol isn’t sold, the temples are packed and some places close early. Check the date before you plan a big dinner.",
      "Views aren’t guaranteed. The mist comes and goes." ] }
  ],
  "ask": { "eyebrow": "Real people, real answers", "heading": "Not sure about something?",
    "text": "Train seats, factory opening days, what the entrance fee is this month — message us and we’ll check. That’s what we’re here for.",
    "wa": "Hi Ceylon Hop — a question about Nuwara Eliya: " },
  "photos": {
    "hero":         { "alt": "Tea-covered hills of Nuwara Eliya under a blue sky", "credit": "Juho S", "creditUrl": "https://unsplash.com/@jhshelsinki?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/a-lush-green-hillside-covered-in-lots-of-trees-uDk9n1yKxTw?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 45%", "w": 1800, "h": 1013 },
    "horton":       { "alt": "Golden grassland of Horton Plains at sunrise, cloud sitting on the hills behind", "credit": "Madhawa Mihiran", "creditUrl": "https://unsplash.com/@madhawams?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/a-grassy-field-with-a-hill-in-the-background-gG-4Lu0G46A?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 60%", "w": 1800, "h": 1125 },
    "pedro":        { "alt": "Rows of tea bushes on a bright hillside", "credit": "Rowan Heuvel", "creditUrl": "https://unsplash.com/@insolitus?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/green-grass-field-under-cloudy-sky-during-daytime-Fh4CAo8ba6c?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 50%", "w": 1800, "h": 1125 },
    "gregory":      { "alt": "Boats moored on Gregory Lake with the town and hills behind", "credit": "Saaketh PVR", "creditUrl": "https://unsplash.com/@pvrs02?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/boats-docked-by-a-misty-lakeside-town-with-green-hills-RG9VTsSH8Ow?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 55%", "w": 1800, "h": 1125 },
    "hakgala":      { "alt": "A garden with a fountain and flower beds", "credit": "Secret Travel Guide", "creditUrl": "https://unsplash.com/@secrettravelguide?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/a-garden-with-a-fountain-and-flowers--SEDkuh-T8Y?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 50%", "w": 1800, "h": 1125 },
    "town":         { "alt": "The red-brick colonial post office in Nuwara Eliya town", "credit": "Ranmali Kirinde", "creditUrl": "https://unsplash.com/@ranmali_k?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/historic-red-brick-building-with-white-trim-and-gables-RvawCDaJmo0?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 50%", "w": 1800, "h": 1125 },
    "single-tree":  { "alt": "The sun rising behind a lone tree above a sea of cloud in the hill country", "credit": "Kennett Etugala", "creditUrl": "https://unsplash.com/@etugala?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/the-sun-shines-through-the-clouds-in-the-mountains-q_GXjVnIs1w?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 40%", "w": 1800, "h": 1125 },
    "moon-plains":  { "alt": "A sambar stag resting in long grass on the plains", "credit": "Bianca Ahangama", "creditUrl": "https://unsplash.com/@wildlifeserendipitywithbianca?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/a-deer-laying-down-in-a-grassy-field-W9j4pYCrRIU?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 45%", "w": 1800, "h": 1125 },
    "ambewela":     { "alt": "Green pasture beside water under a blue sky", "credit": "Subodha Karunarathne", "creditUrl": "https://unsplash.com/@mr_subz?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/green-grass-field-near-body-of-water-under-blue-sky-during-daytime-PuWCoG8WHok?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 50%", "w": 1800, "h": 1125 },
    "lovers-leap":  { "alt": "A tall waterfall dropping down a green cliff", "credit": "Thushal Madhushankha", "creditUrl": "https://unsplash.com/@thushal98?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/waterfall-cascading-down-lush-mountain-cliff-Wak57_M4JKM?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 50%", "w": 1800, "h": 1125 },
    "ramboda":      { "alt": "A waterfall in the hills near Nuwara Eliya", "credit": "Heshan Weeramanthri", "creditUrl": "https://unsplash.com/@kolithaheshan?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/waterfalls-in-the-middle-of-green-grass-field-ytNk5s_4Wys?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 50%", "w": 1800, "h": 1125 },
    "strawberries": { "alt": "A roadside fruit stall in warm light", "credit": "Divyansh Dwivedi", "creditUrl": "https://unsplash.com/@iamdivyanshdwivedi?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/street-vendor-stall-with-scooter-and-produce-displayed--aycSBI7ZKo?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 50%", "w": 1800, "h": 1125 },
    "hill-club":    { "alt": "A spread of Sri Lankan curries", "credit": "Zoshua Colah", "creditUrl": "https://unsplash.com/@zoshuacolah?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/a-variety-of-delicious-appetizing-curry-dishes-i0Dd1oxMz6c?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 50%", "w": 1800, "h": 1125 },
    "pedro-cafe":   { "alt": "Tea fields seen from above", "credit": "Jerry Kavan", "creditUrl": "https://unsplash.com/@jerrykavan?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/aerial-photography-of-green-fields-during-daytime-i9eaAR4dWi8?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 50%", "w": 1800, "h": 1125 },
    "rice-curry":   { "alt": "Rice and curry served on a banana leaf", "credit": "Zoshua Colah", "creditUrl": "https://unsplash.com/@zoshuacolah?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/a-sri-lankan-meal-is-presented-on-a-leaf-3gvwRZ_Omgw?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 50%", "w": 1800, "h": 1125 },
    "heritance":    { "alt": "A white hotel building on a tea-covered hillside", "credit": "Tharindu Madhusanka", "creditUrl": "https://unsplash.com/@tharindu_madhusanka?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/a-large-white-building-sitting-on-top-of-a-lush-green-hillside-bJrOfRUgItU?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 50%", "w": 1800, "h": 1125 },
    "grand-hotel":  { "alt": "A formal garden with flower beds and trees", "credit": "Uravrgphotographer", "creditUrl": "https://unsplash.com/@uravrgphotographer_2611?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/a-garden-with-flowers-and-trees-CUtp0OVGKJQ?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 50%", "w": 1800, "h": 1125 }
  }
}
```

- [ ] **Step 5: Append the credits**

In `credits.html`, after the last `<li><span class="where">Tour gallery</span>…</li>` and before `</ul>`, add one row per photo, in this exact shape (17 rows; `where` = `Nuwara Eliya guide`, text = alt, links = `creditUrl` / `photoUrl` from the JSON):

```html
    <li><span class="where">Nuwara Eliya guide</span><span>Tea-covered hills of Nuwara Eliya — photo by <a href="https://unsplash.com/@jhshelsinki?utm_source=ceylon_hop&utm_medium=referral">Juho S</a> on <a href="https://unsplash.com/photos/a-lush-green-hillside-covered-in-lots-of-trees-uDk9n1yKxTw?utm_source=ceylon_hop&utm_medium=referral">Unsplash</a></span></li>
```

(Repeat for horton, pedro, gregory, hakgala, town, single-tree, moon-plains, ambewela, lovers-leap, ramboda, strawberries, hill-club, pedro-cafe, rice-curry, heritance, grand-hotel — generate the 17 lines from the JSON with a one-off node one-liner to avoid typos.)

- [ ] **Step 6: Run the test to see it pass**

Run: `cd <worktree>/web-tests && npx vitest run unit/guide-content.test.js`
Expected: PASS (4 tests for nuwara-eliya + 1).

- [ ] **Step 7: Commit**

```bash
cd <worktree> || exit 1
git add tools/guides/nuwara-eliya.json img/guides/nuwara-eliya credits.html web-tests/unit/guide-content.test.js
git commit -m "feat(guides): Nuwara Eliya guide content and photos

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Generator, page script, wiring

**Files:**
- Create: `tools/generate-guides.mjs`
- Create: `guide-page.js`
- Modify: `tools/generate-route-pages.mjs` — `const BASE_PAIRS` → `export const BASE_PAIRS`; add `'guides/nuwara-eliya/'` to `SITEMAP_EXTRA`
- Modify: `tools/generate-static-pages.mjs` — import and spread `generateGuides()`
- Test: `web-tests/unit/guide-pages.test.js`

**Interfaces:**
- Consumes: `renderStandalone({title, description, canonicalPath, depth, active, style, bodyHtml})` from `tools/render-page.mjs`; `loadTransfers()` → `T.byId[id].name`, `T.privateQuote(from,to)` → `{km, durationMin, estimated, car, van}`; `loadPlacePhotos()`, `photoFor(photos,id)`, `imgTag(photo,{p,sizes})` from `tools/place-photos.mjs`; `assetV(file)`, `WA` from `tools/site-chrome.mjs`; `formatRouteEstimate({distanceKm,durationMin,state})` from `route-estimate.js`.
- Produces: `generateGuides(): Map<'guides/<slug>/index.html', string>`, `loadGuides(): object[]`, `guidePath(slug): string`.

- [ ] **Step 1: Write the failing test**

`web-tests/unit/guide-pages.test.js`:

```js
// Contract for generated destination guides (spec 2026-09-28-destination-guides-design.md §6, §7, §10).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { generateGuides } from '../../tools/generate-guides.mjs';
import { generateStaticPages } from '../../tools/generate-static-pages.mjs';
import { generateAll, ROOT } from '../../tools/generate-route-pages.mjs';

const out = generateGuides();
const REL = 'guides/nuwara-eliya/index.html';
const html = out.get(REL);
const noJs = h => h.replace(/<script[\s\S]*?<\/script>/g, '');
const section = (h, id) => {
  const i = h.indexOf(`id="${id}"`); expect(i, `section #${id}`).toBeGreaterThan(-1);
  const j = h.indexOf('</section>', i); return h.slice(i, j);
};

describe('generateGuides', () => {
  it('emits the Nuwara Eliya guide and generateStaticPages includes it', () => {
    expect(html).toBeTruthy();
    expect(generateStaticPages().has(REL)).toBe(true);
  });
  it('carries canonical, OG, Article + FAQPage + BreadcrumbList JSON-LD', () => {
    expect(html).toContain('<link rel="canonical" href="https://ceylonhop.com/guides/nuwara-eliya/">');
    expect(html).toContain('property="og:url" content="https://ceylonhop.com/guides/nuwara-eliya/"');
    expect(html).toMatch(/"@type":\s*"Article"/);
    expect(html).toMatch(/"@type":\s*"FAQPage"/);
    expect(html).toMatch(/"@type":\s*"BreadcrumbList"/);
    expect(html).toContain('Is Nuwara Eliya worth visiting?');
  });
  it('ships the site chrome without JavaScript (header, footer, route index link)', () => {
    const h = noJs(html);
    expect(h).toMatch(/<header class="nav/);
    expect(h).toMatch(/<footer/);
    expect(h).toMatch(/href="\.\.\/\.\.\/trip\/"/);
    expect(h).toContain('href="../../blog.html"');
  });
  it('Getting here sells the car only: no price, no train row, no tuk-tuk', () => {
    const s = section(html, 'here');
    expect(s).toContain('search.html?from=kandy&amp;to=nuwara-eliya');
    expect(s).toContain('search.html?from=ella&amp;to=nuwara-eliya');
    expect(s).toContain('search.html?from=cmb-airport&amp;to=nuwara-eliya');
    const cards = s.slice(0, s.indexOf('<details'));
    expect(cards).not.toMatch(/\$\d/);
    expect(cards.toLowerCase()).not.toContain('tuk-tuk');
    expect(cards.toLowerCase()).not.toContain('train');
    expect(s).toContain('Thinking about the train?');
  });
  it('Where next reuses the trip-page card with live-fare hooks, one card per corridor direction', () => {
    const s = section(html, 'next');
    const cards = s.match(/<a class="rt-card"/g) || [];
    expect(cards).toHaveLength(4);
    for (const href of ['trip/nuwara-eliya-to-kandy/', 'trip/nuwara-eliya-to-ella/', 'trip/kandy-to-nuwara-eliya/', 'trip/ella-to-nuwara-eliya/']) {
      expect(s).toContain(`href="../../${href}"`);
      expect(existsSync(path.join(ROOT, href, 'index.html')), href).toBe(true);
    }
    expect(s).toMatch(/<b data-list-fare data-from-name="Nuwara Eliya" data-to-name="Ella">\$\d/);
    expect(html).toContain('route-list-fares.js?v=');
    expect(html).toContain('list-fares-pending');
  });
  it('the Day 1 card has no booking button; Day 2 books Nuwara Eliya → Ella in the planner', () => {
    const s = section(html, 'plan');
    expect((s.match(/Book this day with us/g) || []).length).toBe(1);
    expect(s).toContain('plan.html?stops=Nuwara+Eliya%7CElla&amp;nights=0%2C0');
  });
  it('collectors and offers go to WhatsApp with a prefilled message', () => {
    expect(html).toMatch(/https:\/\/wa\.me\/94779669662\?text=[^"]*Nuwara/);
    expect(html).not.toContain('<input');
    expect(html).not.toContain('Check availability');
  });
  it('every relative href/src resolves to a file in the repo', () => {
    const refs = [...html.matchAll(/\b(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)].map(m => m[1])
      .filter(u => !/^(https?:|mailto:|tel:|javascript:)/.test(u));
    expect(refs.length).toBeGreaterThan(20);
    for (const u of refs) {
      const clean = u.split('?')[0];
      const abs = path.resolve(path.join(ROOT, 'guides/nuwara-eliya'), clean);
      const ok = existsSync(abs) || existsSync(path.join(abs, 'index.html'));
      expect(ok, `${u} → ${abs}`).toBe(true);
    }
  });
  it('is in the sitemap', () => {
    expect(generateAll().get('sitemap.xml')).toContain('<loc>https://ceylonhop.com/guides/nuwara-eliya/</loc>');
  });
  it('the committed page equals the generator output (run npm run generate if this fails)', () => {
    expect(readFileSync(path.join(ROOT, REL), 'utf8')).toBe(html);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd <worktree>/web-tests && npx vitest run unit/guide-pages.test.js`
Expected: FAIL — `Cannot find module '../../tools/generate-guides.mjs'`.

- [ ] **Step 3: Export `BASE_PAIRS` and add the sitemap entry**

In `tools/generate-route-pages.mjs`:
- line 19: `const BASE_PAIRS = [` → `export const BASE_PAIRS = [`
- in `SITEMAP_EXTRA`, after `'why-we-started-ceylon-hop/',` add:
  ```js
  // Destination guides (tools/generate-guides.mjs). One line per guide; the guide test pins it.
  'guides/nuwara-eliya/',
  ```

- [ ] **Step 4: Write `tools/generate-guides.mjs`**

```js
// tools/generate-guides.mjs
// Destination guides: one JSON per destination in tools/guides/, one generated page at
// guides/<slug>/index.html. Design: docs/superpowers/specs/2026-09-28-destination-guides-design.md
//
// The page is rendered through renderStandalone() so header, footer, <head> assets, analytics
// and the error beacon are byte-identical to every other generated page. Where-next cards are
// the trip pages' a.rt-card markup, so route-list-fares.js prices them live without changes.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { renderStandalone, ORIGIN } from './render-page.mjs';
import { ROOT, BASE_PAIRS } from './generate-route-pages.mjs';
import { loadTransfers } from './load-transfers.mjs';
import { loadPlacePhotos, photoFor, imgTag } from './place-photos.mjs';
import { assetV, WA } from './site-chrome.mjs';

const require = createRequire(import.meta.url);
const { formatRouteEstimate } = require('../route-estimate.js');

const GUIDES_DIR = join(ROOT, 'tools/guides');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const stripTags = s => String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const price = n => Number.isInteger(n) ? String(n) : n.toFixed(2);
const wa = text => `${WA}?text=${encodeURIComponent(text)}`;
const mapsUrl = q => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;

const CAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 17h14M5 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM23 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM3 17l2-7h14l2 7M7 10V6h10v4"/></svg>';

export function loadGuides() {
  return readdirSync(GUIDES_DIR).filter(f => f.endsWith('.json')).sort()
    .map(f => JSON.parse(readFileSync(join(GUIDES_DIR, f), 'utf8')));
}
export const guidePath = slug => `guides/${slug}/`;

/** A guide photo at both sizes. `key` is a stem in img/guides/<slug>/; meta comes from guide.photos. */
function gimg(guide, key, { p, sizes, eager = false, cls = '' }) {
  const ph = guide.photos[key];
  if (!ph) throw new Error(`guide "${guide.slug}": photos missing "${key}"`);
  const base = `${p}img/guides/${guide.slug}/${key}`;
  return `<img${cls ? ` class="${cls}"` : ''} src="${base}-900.jpg" srcset="${base}-900.jpg 900w, ${base}-1800.jpg 1800w" sizes="${sizes}" `
    + `width="${ph.w}" height="${ph.h}" alt="${esc(ph.alt)}" style="object-position:${esc(ph.focal || '50% 50%')}" `
    + (eager ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"') + '>';
}

const eyebrow = t => `<div class="eyebrow">${esc(t)}</div>`;
const sh = (eb, h2, sub) => `<div class="sh reveal">${eyebrow(eb)}<h2>${h2}</h2>${sub ? `<p>${sub}</p>` : ''}</div>`;

function hero(g, p) {
  return `<div class="g-hero">
    ${gimg(g, g.hero.photo, { p, sizes: '100vw', eager: true })}
    <div class="wrap">
      <div class="eyebrow">Ceylon Hop guide · ${esc(g.region)}</div>
      <h1>${esc(g.name)}</h1>
      <p class="sub">${g.hero.intro}</p>
    </div>
    <span class="credit">Photo: ${esc(g.photos[g.hero.photo].credit)} / Unsplash</span>
  </div>`;
}

function facts(g) {
  return `<div class="facts"><div class="wrap">${g.facts.map(f =>
    `<div class="fact"><small>${esc(f.label)}</small><b>${esc(f.value)}${f.unit ? `<span class="unit">${esc(f.unit)}</span>` : ''}</b></div>`).join('')}</div></div>`;
}

function jumpNav(items) {
  return `<div class="jump" id="jump"><div class="wrap">${items.map(([id, label], i) =>
    `<a href="#${id}"${i === 0 ? ' class="on"' : ''}>${esc(label)}</a>`).join('')}</div></div>`;
}

function gettingHere(g, p) {
  const gh = g.gettingHere;
  const cards = gh.origins.map(o => `<div class="route reveal">
        <span class="ic">${CAR}</span>
        <h3>${esc(o.title)}</h3><p class="from">${esc(o.from)}</p>
        <p class="sell">${o.sell}</p>
        <a class="btn btn-cta" href="${p}search.html?from=${encodeURIComponent(o.id)}&amp;to=${encodeURIComponent(g.placeId)}">See price &amp; book</a>
      </div>`).join('\n      ');
  const train = gh.train ? `
    <details class="alt reveal"><summary>Thinking about the train?</summary><div class="dc"><div><p>${gh.train}</p></div></div></details>` : '';
  return `<section class="section" id="here"><div class="wrap">
    ${sh('Getting here', esc(gh.heading), esc(gh.sub))}
    <div class="routes">
      ${cards}
    </div>${train}
  </div></section>`;
}

const SPEC_LABELS = { from: 'From town', open: 'Open', give: 'Give it', ticket: 'Ticket' };
function placeCard(g, pl, i, p) {
  const spec = pl.spec ? `<div class="spec">${Object.entries(SPEC_LABELS).filter(([k]) => pl.spec[k])
    .map(([k, label]) => `<div><small>${label}</small><b>${esc(pl.spec[k])}</b></div>`).join('')}</div>` : '';
  const tip = pl.tip ? `<div class="tip${pl.tip.kind === 'warn' ? ' warn' : ''}"><b>${pl.tip.kind === 'warn' ? 'Good to know' : 'From our drivers'}</b>${pl.tip.text}</div>` : '';
  const offer = pl.offer ? `<a class="ch-row" href="${wa(pl.offer.wa)}"><span class="ic">${CAR}</span><span><b>${esc(pl.offer.title)}</b><small>${esc(pl.offer.sub)}</small></span><span class="arr">Ask for a price →</span></a>` : '';
  return `<article class="poi${i === 0 ? ' feature' : ''} reveal" id="${esc(pl.id)}">
        ${gimg(g, pl.photo, { p, sizes: i === 0 ? '(max-width:760px) 100vw, 60vw' : '(max-width:760px) 100vw, 50vw' })}
        <span class="n">${i + 1}</span>
        <div class="bd">
          <h3>${esc(pl.name)}</h3>
          <p>${pl.text}</p>
          ${spec}${tip}${offer}
        </div>
      </article>`;
}

function seeAndDo(g, p) {
  const n = g.places.length;
  const words = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
  const far = g.furtherAfield && g.furtherAfield.length ? `
    <div class="sh reveal far-head">${eyebrow('Further afield')}<h2 class="h2-small">Worth a whole day, if you have one</h2></div>
    <div class="far">${g.furtherAfield.map(f => `<div class="fx reveal"><span class="km">${esc(f.time)}<small>each way</small></span><b>${esc(f.name)}</b><p>${f.text}</p></div>`).join('')}</div>` : '';
  return `<section class="section" id="see"><div class="wrap">
    ${sh('Things to see & do', `${words[n] || n} things worth your time`, 'In the order we’d do them. Every one has hours, how far from town, how long to give it, and our honest tip.')}
    <div class="poi-list">
      ${g.places.map((pl, i) => placeCard(g, pl, i, p)).join('\n      ')}
    </div>${far}
    <div class="checked"><i></i>Hours and fees checked ${esc(g.checked)} — <a href="${wa(g.ask.wa)}">tell us on WhatsApp</a> if something has changed</div>
  </div></section>`;
}

function itinerary(g, p) {
  const it = g.itinerary; if (!it) return '';
  const days = it.days.map(d => {
    const steps = d.steps.map(s => `<li${s.us ? ' class="us"' : ''}><time>${esc(s.time)}</time><div><b>${esc(s.title)}</b>${s.text ? `<span>${s.text}</span>` : ''}</div></li>`).join('');
    const book = d.book ? `<div class="dayfoot"><div class="preload">${d.book.preload}</div>
          <a class="btn btn-cta" href="${p}plan.html?${esc(new URLSearchParams({ stops: d.book.stops.join('|'), nights: d.book.nights.join(',') }).toString())}">Book this day with us</a></div>` : '';
    return `<div class="day reveal"><h3>${esc(d.title)}</h3><p class="sub">${esc(d.sub)}</p><ul class="tl">${steps}</ul>${book}</div>`;
  }).join('\n      ');
  return `<section class="section" id="plan"><div class="wrap">
    ${sh(it.eyebrow, esc(it.heading), esc(it.sub))}
    <div class="days">
      ${days}
    </div>
  </div></section>`;
}

function months(g) {
  const m = g.months; if (!m) return '';
  return `<section class="section" id="when"><div class="wrap">
    ${sh('When to come', esc(m.heading), esc(m.sub))}
    <div class="months">${m.blocks.map(b => `<div class="mo ${esc(b.tone || '')} reveal"><small>${esc(b.label)}</small><b>${esc(b.title)}</b><p>${b.text}</p>${b.tag ? `<span class="tag">${esc(b.tag)}</span>` : ''}</div>`).join('')}</div>
  </div></section>`;
}

function onTheWay(g, p) {
  const w = g.onTheWay; if (!w || !w.stops.length) return '';
  return `<section class="section band" id="way"><div class="wrap">
    ${sh(w.eyebrow, esc(w.heading), esc(w.sub))}
    <div class="stops">${w.stops.map(s => `<div class="stop reveal">${gimg(g, s.photo, { p, sizes: '(max-width:760px) 100vw, 190px' })}<div class="bd"><div class="km">${esc(s.km)}</div><h3>${esc(s.name)}</h3><p>${s.text}</p><a class="add" href="${wa(s.wa)}">Add this stop to my booking →</a></div></div>`).join('')}</div>
    <p class="cta-line reveal">${w.note}</p>
  </div></section>`;
}

function placeRow(g, items, collector, p, withMap) {
  const cards = items.map(e => `<article class="pl reveal">
          ${gimg(g, e.photo, { p, sizes: '(max-width:760px) 100vw, 25vw' })}
          <span class="tier">${esc(e.tier)}</span>${e.pick ? '<span class="pick">Our pick</span>' : ''}
          <div class="bd"><h3>${esc(e.name)}</h3><p class="why">${e.text}</p><button class="tg" type="button" aria-expanded="false">More</button>
            <div class="m"><span class="pb">${esc(e.band)}</span>${(e.flags || []).map(f => `<span>${esc(f)}</span>`).join('')}${(e.warn || []).map(f => `<span class="warn">${esc(f)}</span>`).join('')}</div>
            ${withMap && e.map ? `<a class="go" href="${mapsUrl(e.map)}" target="_blank" rel="noopener">See on map ↗</a>` : ''}</div>
        </article>`).join('\n        ');
  const ask = `<div class="pl ask reveal"><div><h3>${esc(collector.title)}</h3><p>${collector.text}</p><a class="wa" href="${wa(collector.wa)}"><i></i>Tell us on WhatsApp</a>${collector.fine ? `<p class="fine">${esc(collector.fine)}</p>` : ''}</div></div>`;
  return `<div class="es">
        ${cards}
        ${ask}
      </div>`;
}

function eatStay(g, p) {
  return `<section class="section" id="eat"><div class="wrap">
    <div class="es-block">
      ${sh('Where to eat', 'Eat', 'Nothing fancy on this list unless it earns it. Cash for most places.')}
      ${placeRow(g, g.eat, g.eatCollector, p, true)}
    </div>
    <div class="es-block">
      ${sh('Where to stay', 'Stay', 'Nights are cold and most places don’t have heating — ask for extra blankets wherever you stay.')}
      ${placeRow(g, g.stay, g.stayCollector, p, false)}
    </div>
  </div></section>`;
}

function faq(g) {
  const tabs = g.faq.map((t, i) => `<button type="button"${i === 0 ? ' class="on"' : ''} data-g="${i}">${esc(t.tab)}</button>`).join('');
  const groups = g.faq.map((t, i) => {
    const body = t.items
      ? t.items.map((q, j) => `<details${i === 0 && j === 0 ? ' open' : ''}><summary>${esc(q.q)}</summary><div class="dc"><div>${q.a}</div></div></details>`).join('')
      : `<ul class="tips">${t.tips.map(x => `<li>${x}</li>`).join('')}</ul>`;
    return `<div class="group${i === 0 ? ' on' : ''}">${body}</div>`;
  }).join('\n      ');
  return `<section class="section qa" id="qa"><div class="wrap">
    ${sh('Your questions, answered', 'The things people ask us', 'Pick a topic, tap a question.')}
    <div class="qtabs" id="qtabs">${tabs}</div>
    <div class="groups">
      ${groups}
    </div>
  </div></section>`;
}

/** Every rate-card corridor that touches the destination, outbound first, then the way in.
    Byte-compatible with the trip pages' cards so route-list-fares.js prices them live. */
function whereNext(g, T, placePhotos, p) {
  const id = g.placeId;
  const legs = [];
  for (const [a, b] of BASE_PAIRS) { if (a === id) legs.push([a, b]); else if (b === id) legs.push([b, a]); }
  for (const [a, b] of BASE_PAIRS) { if (a === id) legs.push([b, a]); else if (b === id) legs.push([a, b]); }
  if (!legs.length) throw new Error(`guide "${g.slug}": placeId "${id}" is on no BASE_PAIRS corridor`);
  const cards = legs.map(([from, to]) => {
    const q = T.privateQuote(from, to);
    const est = formatRouteEstimate({ distanceKm: q.km, durationMin: q.durationMin, state: q.estimated ? 'estimated' : 'browse' });
    const f = T.byId[from].name, t = T.byId[to].name;
    return `<a class="rt-card" href="${p}trip/${from}-to-${to}/">${imgTag(photoFor(placePhotos, to), { p, sizes: '(max-width:760px) 76vw, 25vw' })}<span class="rt-bd"><span class="rt-name">${esc(f)} → ${esc(t)}</span><span class="rt-meta">${est}</span><span class="rt-fare">from <b data-list-fare data-from-name="${esc(f)}" data-to-name="${esc(t)}">$${price(q.car)}</b> fixed</span><span class="rt-go">Choose date &amp; book</span></span></a>`;
  }).join('');
  return `<section class="section" id="next"><div class="wrap">
    ${sh('Keep hopping', `Where next from ${esc(g.name)}?`, 'Fixed prices, air-conditioned car, door to door. Pick a date and we’ll do the rest.')}
    <div class="next reveal">${cards}</div>
    <span class="swipe-hint">Swipe for more routes →</span>
    <div class="live"><i></i>Live prices from our booking engine — what you see is what you pay</div>
    <p class="all"><a href="${p}trip/">See all Sri Lanka transfer routes →</a></p>
  </div></section>`;
}

function askBand(g) {
  return `<section class="section-tight ask"><div class="wrap">
    <div class="reveal">${eyebrow(g.ask.eyebrow)}<h2>${esc(g.ask.heading)}</h2><p>${g.ask.text}</p></div>
    <a class="wa reveal" href="${wa(g.ask.wa)}"><i></i>Message us on WhatsApp</a>
  </div></section>`;
}

function credits(g, p) {
  const names = [...new Set(Object.values(g.photos).map(x => x.credit))];
  return `<div class="credits"><div class="wrap"><span>Photos:</span>${names.map(n => `<span>${esc(n)}</span>`).join('')}<span>— on Unsplash · <a href="${p}credits.html">all credits</a></span></div></div>`;
}

function jsonLd(g, url, p) {
  const items = g.faq.flatMap(t => (t.items || []).map(q => ({
    '@type': 'Question', name: q.q, acceptedAnswer: { '@type': 'Answer', text: stripTags(q.a) },
  })));
  return [
    { '@context': 'https://schema.org', '@type': 'Article', headline: `${g.name} guide`, description: g.description,
      author: { '@type': 'Organization', name: 'Ceylon Hop', url: `${ORIGIN}/` },
      publisher: { '@type': 'Organization', name: 'Ceylon Hop', url: `${ORIGIN}/` },
      mainEntityOfPage: { '@type': 'WebPage', '@id': url }, image: `${ORIGIN}/img/guides/${g.slug}/${g.hero.photo}-1800.jpg`, inLanguage: 'en' },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
      { '@type': 'ListItem', position: 2, name: 'Travel Guide', item: `${ORIGIN}/blog.html` },
      { '@type': 'ListItem', position: 3, name: `${g.name} guide`, item: url } ] },
  ].map(o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n');
}

export function renderGuide(g, T, placePhotos) {
  const p = '../../';
  const url = `${ORIGIN}/${guidePath(g.slug)}`;
  const nav = [['here', 'Getting here'], ['see', 'See & do']];
  if (g.itinerary) nav.push(['plan', 'Itinerary']);
  if (g.months) nav.push(['when', 'When to come']);
  if (g.onTheWay && g.onTheWay.stops.length) nav.push(['way', 'On the way']);
  nav.push(['eat', 'Eat & stay'], ['qa', 'Your questions'], ['next', 'Where next']);

  const head = `<script>(function(){var q=new URLSearchParams(location.search).get('api');window.CEYLON_HOP_API=(q==='off')?'':(q||window.CEYLON_HOP_API||'https://ceylon-hop-api.onrender.com');
  /* Where-next fares are held (transparent, in place) until route-list-fares.js has the engine's
     answer — the same hold as the trip pages, released by that script or by this timer. */
  if(window.CEYLON_HOP_API){var d=document.documentElement;d.classList.add('list-fares-pending');setTimeout(function(){d.classList.remove('list-fares-pending');},4500);}
  document.documentElement.classList.add('js');})();</script>`;

  return renderStandalone({
    title: g.title, description: g.description, canonicalPath: `/${guidePath(g.slug)}`, depth: 2, active: 'blog.html',
    style: GUIDE_STYLE,
    bodyHtml: `${head}
${jsonLd(g, url, p)}
  ${hero(g, p)}
  ${facts(g)}
  ${jumpNav(nav)}
  <section class="lede-s"><div class="wrap reveal"><p class="lede">${g.lede} <em>${g.ledeEm}</em></p><span class="hand">— the Ceylon Hop team</span></div></section>
  ${gettingHere(g, p)}
  ${seeAndDo(g, p)}
  ${itinerary(g, p)}
  ${months(g)}
  ${onTheWay(g, p)}
  ${eatStay(g, p)}
  ${faq(g)}
  ${whereNext(g, T, placePhotos, p)}
  ${askBand(g)}
  ${credits(g, p)}
<script src="${p}${assetV('route-list-fares.js')}"></script>
<script src="${p}${assetV('guide-page.js')}"></script>`,
  });
}

export function generateGuides() {
  const T = loadTransfers();
  const placePhotos = loadPlacePhotos();
  const out = new Map();
  for (const g of loadGuides()) out.set(`${guidePath(g.slug)}index.html`, renderGuide(g, T, placePhotos));
  return out;
}

// ── styles ────────────────────────────────────────────────────────────────────────────────
// Tokens (--blue, --paper, --display, …) come from site.css. Phone rules at 759px match the
// site's own breakpoints; the mockup used container queries only to preview both widths.
const GUIDE_STYLE = `
  .g-hero{position:relative;min-height:560px;display:flex;align-items:flex-end;color:#fff;isolation:isolate;overflow:hidden;margin-top:-74px}
  .g-hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-2;transform:scale(1.06);animation:g-kb 9s cubic-bezier(.2,.7,.2,1) forwards}
  @keyframes g-kb{to{transform:scale(1)}}
  .g-hero::before{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(9,38,36,.35) 0%,rgba(9,38,36,0) 22%,rgba(9,38,36,.55) 68%,rgba(9,38,36,.82) 100%)}
  .g-hero .wrap{padding-top:120px;padding-bottom:34px;width:100%}
  .g-hero .eyebrow{color:var(--saffron)}.g-hero .eyebrow::before{background:var(--saffron)}
  .g-hero h1{color:#fff;font-size:clamp(3.2rem,10vw,6.4rem);line-height:.98;margin:0 0 .5rem;font-variation-settings:"opsz" 96;text-shadow:0 2px 24px rgba(0,0,0,.25)}
  .g-hero .sub{max-width:34rem;margin:0;font-size:1.05rem;line-height:1.6;color:rgba(255,255,255,.95)}
  .g-hero .credit{position:absolute;right:14px;bottom:10px;font-size:.66rem;color:rgba(255,255,255,.7)}
  @media(min-width:760px){.g-hero{min-height:680px}.g-hero .wrap{padding-bottom:64px}.g-hero .sub{font-size:1.2rem}}
  .facts{background:var(--paper);border-bottom:1px solid var(--line)}
  .facts .wrap{display:grid;grid-template-columns:1fr 1fr}
  .fact{padding:18px 0 18px 16px;border-right:1px solid var(--line)}
  .fact:nth-child(odd){padding-left:0}.fact:nth-child(even){border-right:0}
  .fact:nth-child(-n+2){border-bottom:1px solid var(--line)}
  .fact small{display:block;font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft);font-weight:600;line-height:1.4}
  .fact .unit{font-family:var(--body);font-weight:600;font-size:.62em;margin-left:.15em;vertical-align:.12em}
  .fact b{font-family:var(--display);font-weight:700;font-size:1.5rem;line-height:1.15;display:block;margin-top:.15rem}
  @media(min-width:760px){.facts .wrap{grid-template-columns:repeat(4,1fr)}.fact,.fact:nth-child(odd){padding:24px 28px;border-bottom:0;border-right:1px solid var(--line)}.fact:first-child{padding-left:0}.fact:last-child{border-right:0}.fact b{font-size:1.75rem}}
  .jump{position:sticky;top:0;z-index:5;background:rgba(240,238,229,.9);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
  .jump::after{content:"";position:absolute;top:0;right:0;bottom:0;width:48px;pointer-events:none;background:linear-gradient(90deg,rgba(240,238,229,0),rgba(240,238,229,.95))}
  .jump .wrap{display:flex;gap:8px;overflow-x:auto;padding-top:10px;padding-bottom:10px;scrollbar-width:none}
  .jump .wrap::-webkit-scrollbar{display:none}
  .jump a{flex:none;font-size:.84rem;font-weight:500;color:var(--ink);text-decoration:none;border:1.5px solid var(--line);background:var(--paper);border-radius:999px;padding:.45rem 1rem;transition:background .25s,color .25s,border-color .25s}
  .jump a.on{background:var(--btn-accent);border-color:var(--btn-accent);color:#fff}
  .lede-s{padding:clamp(36px,4vw,56px) 0 0}
  .lede{font-family:var(--display);font-weight:400;font-size:clamp(1.5rem,3vw,2.1rem);line-height:1.35;max-width:36rem;margin:0}
  .hand{font-family:var(--hand);color:var(--accent-deep);font-size:1.35rem;line-height:1.2;display:block;margin-top:14px;transform:rotate(-1.5deg);transform-origin:left}
  .section{padding:clamp(48px,6vw,84px) 0}
  #here{padding-top:clamp(36px,4vw,56px)}
  .sh{margin-bottom:28px;max-width:44rem}
  .sh h2{margin:0}
  .sh p{color:var(--ink-soft);margin:.4rem 0 0;font-size:1.02rem}
  .h2-small{font-size:clamp(1.5rem,2.6vw,2rem)}
  html.js .reveal{opacity:0;transform:translateY(22px);transition:opacity .7s ease,transform .7s cubic-bezier(.2,.7,.2,1)}
  html.js .reveal.in{opacity:1;transform:none}
  .routes{display:grid;gap:18px}
  @media(min-width:760px){.routes{grid-template-columns:1fr 1fr;gap:24px}}
  @media(min-width:1000px){.routes{grid-template-columns:repeat(3,1fr)}}
  .route{background:var(--paper);border-radius:var(--r-lg);box-shadow:var(--shadow);padding:24px 22px 22px;display:flex;flex-direction:column;gap:6px}
  .route .ic{width:42px;height:42px;border-radius:14px;display:grid;place-items:center;background:var(--pc-saffron);color:#8a5000;margin-bottom:6px}
  .route .ic svg{width:22px;height:22px}
  .route h3{margin:0 0 .2rem}
  .route .from{font-size:.9rem;color:var(--ink-soft);margin:0 0 4px}
  .route .sell{margin:0 0 14px;font-size:.95rem;line-height:1.6;flex:1}
  .route .btn{align-self:flex-start;padding:.8rem 1.4rem;font-size:.92rem}
  .alt{margin-top:22px}
  .alt summary{cursor:pointer;list-style:none;font-weight:500;font-size:.92rem;color:var(--ink-soft);padding:8px 28px 8px 0;display:inline-block;position:relative}
  .alt summary::-webkit-details-marker{display:none}
  .alt summary::after{content:"";position:absolute;right:4px;top:13px;width:10px;height:10px;border-right:2px solid var(--accent-deep);border-bottom:2px solid var(--accent-deep);transform:rotate(45deg);transition:transform .3s}
  .alt[open] summary::after{transform:rotate(225deg);top:17px}
  .alt .dc p{max-width:44rem;font-size:.95rem;color:var(--ink-soft)}
  .alt .dc p b{color:var(--ink);font-weight:600}
  .poi-list{display:grid;gap:24px}
  .poi{background:var(--paper);border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--shadow);position:relative;transition:transform .25s,box-shadow .25s}
  .poi:hover{transform:translateY(-4px);box-shadow:0 22px 44px -18px rgba(30,40,36,.4)}
  .poi img{display:block;width:100%;height:auto;aspect-ratio:4/3;object-fit:cover}
  .poi .n{position:absolute;top:16px;left:16px;width:44px;height:44px;border-radius:50%;background:var(--paper);display:grid;place-items:center;font-family:var(--display);font-weight:700;font-size:1.25rem;box-shadow:0 8px 18px -6px rgba(0,0,0,.4)}
  .poi .bd{padding:22px 22px 24px}
  .poi h3{margin:0 0 .5rem}
  .poi p{margin:0;font-size:1rem;line-height:1.65}
  .spec{display:grid;grid-template-columns:1fr 1fr;gap:12px 18px;margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}
  .spec small{display:block;font-size:.66rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft);font-weight:600;line-height:1.4}
  .spec b{display:block;font-weight:600;font-size:.92rem;line-height:1.45;color:var(--ink)}
  .tip{margin-top:16px;background:var(--pc-saffron);border-radius:14px;padding:14px 16px 14px 18px;font-size:.95rem;line-height:1.6;position:relative}
  .tip::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:4px;border-radius:4px;background:var(--saffron)}
  .tip b{display:block;color:#8a5000;font-weight:600;font-size:.7rem;letter-spacing:.16em;text-transform:uppercase;margin-bottom:.25rem}
  .tip.warn{background:#fdeeec}.tip.warn::before{background:var(--tomato)}.tip.warn b{color:#a3210f}
  .ch-row{display:grid;grid-template-columns:auto 1fr;gap:12px;align-items:center;margin-top:14px;padding:12px 14px;border:1.5px solid var(--line);border-radius:14px;text-decoration:none;color:inherit;transition:border-color .2s}
  .ch-row:hover{border-color:var(--accent)}
  .ch-row .ic{width:36px;height:36px;border-radius:12px;background:var(--pc-saffron);color:#8a5000;display:grid;place-items:center}
  .ch-row .ic svg{width:19px;height:19px}
  .ch-row b{display:block;font-weight:600;font-size:.94rem;line-height:1.3}
  .ch-row small{display:block;font-size:.8rem;color:var(--ink-soft);line-height:1.4}
  .ch-row .arr{grid-column:2;font-weight:600;font-size:.86rem;color:var(--accent-deep);white-space:nowrap}
  @media(min-width:760px){.ch-row{grid-template-columns:auto 1fr auto}.ch-row .arr{grid-column:auto}
    .poi-list{grid-template-columns:repeat(2,1fr);gap:30px}
    .poi.feature{grid-column:1/-1;display:grid;grid-template-columns:1.2fr 1fr}
    .poi.feature img{height:100%;aspect-ratio:auto;min-height:480px}
    .poi.feature .bd{padding:44px;display:flex;flex-direction:column;justify-content:center}
    .poi.feature h3{font-size:clamp(2rem,3.4vw,2.8rem);font-variation-settings:"opsz" 72}
    .poi.feature p{font-size:1.08rem}}
  .far-head{margin-top:44px}
  .far{display:grid;gap:12px}
  @media(min-width:760px){.far{grid-template-columns:repeat(3,1fr);gap:18px}}
  .fx{background:var(--paper);border-radius:var(--r-lg);box-shadow:var(--shadow-s);padding:20px 22px 22px;display:flex;flex-direction:column;gap:6px}
  .fx .km{display:inline-flex;align-items:baseline;gap:.4rem;align-self:flex-start;background:var(--pc-sky);color:var(--accent-deep);border-radius:999px;padding:.3rem .8rem;font-family:var(--display);font-weight:700;font-size:1rem;margin-bottom:6px}
  .fx .km small{font-family:var(--body);font-weight:600;font-size:.64rem;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-soft)}
  .fx b{display:block;font-family:var(--display);font-weight:700;font-size:1.3rem;line-height:1.15}
  .fx p{margin:0;font-size:.92rem;line-height:1.6}
  .checked{display:inline-flex;align-items:center;gap:.5rem;font-size:.82rem;color:var(--ink-soft);margin-top:26px}
  .checked i{width:8px;height:8px;border-radius:50%;background:var(--teal)}
  #plan{padding-top:0}
  .days{display:grid;gap:22px}
  @media(min-width:760px){.days{grid-template-columns:1fr 1fr;gap:30px}}
  .day{background:var(--paper);border-radius:var(--r-lg);box-shadow:var(--shadow);padding:24px 24px 20px}
  .day h3{margin:0 0 .15rem}
  .day .sub{color:var(--ink-soft);font-size:.9rem;margin:0 0 16px}
  .tl{list-style:none;margin:0;padding:0;position:relative}
  .tl::before{content:"";position:absolute;left:52px;top:8px;bottom:8px;width:2px;background:var(--line)}
  .tl li{display:grid;grid-template-columns:44px 1fr;gap:20px;padding:9px 0;position:relative}
  .tl time{font-family:var(--display);font-weight:700;font-size:1.05rem;line-height:1.5;color:var(--accent-deep);text-align:right}
  .tl li::before{content:"";position:absolute;left:47px;top:18px;width:12px;height:12px;border-radius:50%;background:var(--saffron);box-shadow:0 0 0 3px var(--paper)}
  .tl b{display:block;font-weight:600;line-height:1.4}
  .tl span{display:block;color:var(--ink-soft);font-size:.88rem;line-height:1.5}
  .tl li.us b{color:#8a5000}
  .dayfoot{margin-top:18px;padding-top:18px;border-top:1px solid var(--line);display:grid;gap:10px}
  .dayfoot .preload{font-size:.86rem;color:var(--ink-soft);line-height:1.55}
  .dayfoot .preload b{color:var(--ink);font-weight:600}
  .dayfoot .btn{justify-self:start;font-size:.92rem;padding:.8rem 1.35rem}
  #when{padding-top:0}
  .months{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(min-width:760px){.months{grid-template-columns:repeat(4,1fr);gap:18px}}
  .mo{background:var(--paper);border-radius:var(--r);padding:18px 18px 16px;box-shadow:var(--shadow-s);border-top:4px solid var(--blue)}
  .mo.best{border-top-color:var(--saffron)}.mo.wet{border-top-color:var(--teal)}
  .mo small{display:block;font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft);font-weight:600}
  .mo b{display:block;font-family:var(--display);font-size:1.3rem;margin:.15rem 0 .35rem}
  .mo p{margin:0;font-size:.9rem;line-height:1.55}
  .mo .tag{display:inline-block;margin-top:8px;font-size:.72rem;font-weight:600;border-radius:999px;padding:.25rem .6rem;background:var(--pc-saffron);color:#8a5000}
  .band{background:#23302b;color:#fff;padding:clamp(48px,6vw,80px) 0 clamp(40px,5vw,64px)}
  .band .eyebrow{color:var(--saffron)}.band .eyebrow::before{background:var(--saffron)}
  .band .sh h2{color:#fff}.band .sh p{color:rgba(255,255,255,.78)}
  .stops{display:grid;gap:16px}
  .stop{display:grid;grid-template-columns:1fr;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-radius:var(--r);overflow:hidden}
  .stop img{width:100%;height:auto;aspect-ratio:16/9;object-fit:cover}
  .stop .bd{padding:14px 16px 16px}
  .stop h3{font-size:1.3rem;margin:0 0 .3rem;color:#fff}
  .stop p{margin:0;font-size:.95rem;line-height:1.6;color:rgba(255,255,255,.85)}
  .stop .km{font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--saffron);font-weight:600}
  .stop .add{display:inline-flex;justify-content:center;align-items:center;margin-top:10px;font-size:.86rem;font-weight:600;color:#fff;text-decoration:none;border:1.5px solid rgba(255,255,255,.35);border-radius:999px;padding:.4rem .9rem;transition:background .2s,border-color .2s}
  .stop .add:hover{background:rgba(255,255,255,.12);border-color:var(--saffron)}
  @media(min-width:760px){.stops{grid-template-columns:1fr 1fr;gap:22px}.stop{grid-template-columns:190px 1fr;align-items:stretch}.stop img{height:100%;aspect-ratio:auto;min-height:140px}.stop .bd{padding:22px 24px}}
  .band .cta-line{margin:26px 0 0;font-size:1rem;color:rgba(255,255,255,.88)}
  .es-block+.es-block{margin-top:clamp(36px,5vw,64px)}
  .es{display:grid;gap:16px;align-items:stretch}
  @media(min-width:760px){.es{grid-template-columns:repeat(2,1fr);gap:22px}}
  @media(min-width:1000px){.es{grid-template-columns:repeat(4,1fr)}}
  .pl{position:relative;background:var(--paper);border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--shadow);display:flex;flex-direction:column;transition:transform .25s,box-shadow .25s}
  .pl:hover{transform:translateY(-4px);box-shadow:0 22px 44px -18px rgba(30,40,36,.4)}
  .pl img{display:block;width:100%;height:auto;aspect-ratio:16/10;object-fit:cover}
  .pl .tier{position:absolute;top:12px;left:12px;background:var(--paper);border-radius:999px;font-size:.68rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;padding:.32rem .7rem;box-shadow:0 6px 14px -6px rgba(0,0,0,.35)}
  .pl .pick{position:absolute;top:12px;right:12px;background:var(--saffron);color:#3a2a00;border-radius:999px;font-size:.68rem;font-weight:700;letter-spacing:.06em;padding:.32rem .7rem}
  .pl .bd{padding:16px 18px 18px;display:flex;flex-direction:column;gap:6px;flex:1}
  .pl h3{font-size:1.25rem;margin:0;min-height:calc(2 * 1.25rem * 1.14)}
  .pl .why{position:relative;margin:0;font-size:.93rem;line-height:1.55;color:var(--ink);max-height:calc(3 * .93rem * 1.55);overflow:hidden;transition:max-height .45s cubic-bezier(.2,.7,.2,1)}
  .pl .why::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1.4em;background:linear-gradient(180deg,rgba(255,253,248,0),var(--paper));transition:opacity .3s}
  .pl.open .why{max-height:30em}.pl.open .why::after{opacity:0}
  .pl .why em{font-style:normal;color:var(--ink-soft)}
  .pl .why b{font-weight:600;color:var(--ink)}
  .pl .tg{align-self:flex-start;font:inherit;font-weight:600;font-size:.84rem;color:var(--accent-deep);background:none;border:0;padding:2px 0;cursor:pointer;display:inline-flex;align-items:center;gap:.3rem}
  .pl .tg::after{content:"";width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg) translateY(-2px);transition:transform .3s}
  .pl.open .tg::after{transform:rotate(225deg) translateY(-1px)}
  .pl .m{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;min-height:calc(2 * 1.75rem + 6px);align-content:flex-start}
  .pl .m span{font-size:.74rem;font-weight:600;border-radius:999px;padding:.28rem .65rem;background:var(--cream);color:var(--ink-soft)}
  .pl .m span.pb{background:var(--pc-green);color:#3d6b2a;letter-spacing:.08em}
  .pl .m span.warn{background:#fdeeec;color:#a3210f}
  .pl .go{margin-top:auto;padding-top:12px;font-size:.86rem;font-weight:600;color:var(--accent-deep);text-decoration:none}
  .pl.ask{background:var(--pc-sky);box-shadow:none;border:1.5px dashed rgba(36,117,138,.35);justify-content:center;text-align:center;padding:28px 22px}
  .pl.ask h3{font-size:1.2rem;color:var(--accent-deep);min-height:0}
  .pl.ask p{margin:.4rem 0 0;font-size:.92rem}
  .pl.ask .fine{font-size:.76rem;color:var(--ink-soft);margin-top:8px}
  .wa{display:inline-flex;align-items:center;gap:.6rem;background:#fff;color:var(--ink);font-weight:600;border-radius:999px;padding:.85rem 1.3rem;text-decoration:none;white-space:nowrap;box-shadow:0 14px 30px -14px rgba(0,0,0,.4)}
  .wa i{width:22px;height:22px;border-radius:50%;background:#25D366;display:inline-block}
  .pl.ask .wa{margin:16px auto 0;padding:.75rem 1.2rem;font-size:.9rem}
  .qa{background:var(--paper)}
  .qtabs{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 22px}
  .qtabs button{font:inherit;font-weight:600;font-size:.9rem;border:1.5px solid var(--line);background:var(--cream);color:var(--ink);border-radius:999px;padding:.55rem 1.1rem;cursor:pointer;transition:background .2s,color .2s,border-color .2s}
  .qtabs button.on{background:var(--btn-accent);border-color:var(--btn-accent);color:#fff}
  .groups{max-width:46rem}
  .group{display:none}
  .group.on{display:block;animation:g-qin .35s cubic-bezier(.2,.7,.2,1)}
  @keyframes g-qin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  .qa details{border-top:1px solid var(--line)}
  .qa details:last-of-type{border-bottom:1px solid var(--line)}
  .qa summary{cursor:pointer;list-style:none;font-weight:600;font-size:1rem;line-height:1.45;padding:16px 34px 16px 0;position:relative}
  .qa summary::-webkit-details-marker{display:none}
  .qa summary::after{content:"";position:absolute;right:4px;top:21px;width:12px;height:12px;border-right:2px solid var(--accent-deep);border-bottom:2px solid var(--accent-deep);transform:rotate(45deg);transition:transform .3s}
  .qa details[open] summary::after{transform:rotate(225deg);top:26px}
  .dc{display:grid;grid-template-rows:0fr;transition:grid-template-rows .35s cubic-bezier(.2,.7,.2,1)}
  details[open] .dc{grid-template-rows:1fr}
  .dc>div{overflow:hidden}
  .dc p,.dc ul{margin:0 0 16px;font-size:1rem;line-height:1.65}
  .dc ul{padding-left:20px}
  .pack{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:0 0 16px;padding:0!important;list-style:none}
  .pack li{background:var(--pc-green);border-radius:10px;padding:10px 12px;font-size:.88rem;font-weight:500;line-height:1.4}
  .temps{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:4px 0 14px}
  .temps div{background:var(--pc-sky);border-radius:12px;padding:10px 6px;text-align:center}
  .temps b{display:block;font-family:var(--display);font-size:1.35rem;line-height:1.1}
  .temps small{font-size:.64rem;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-soft);font-weight:600}
  .tips{margin:0;padding:0;list-style:none;display:grid;gap:14px}
  @media(min-width:760px){.tips{grid-template-columns:1fr 1fr;gap:14px 40px}}
  .tips li{padding-left:26px;position:relative;font-size:.98rem;line-height:1.6}
  .tips li::before{content:"";position:absolute;left:0;top:.55em;width:12px;height:12px;border-radius:50%;background:var(--saffron)}
  .next{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  @media(min-width:760px){.next{grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}}
  .rt-card{position:relative;display:flex;flex-direction:column;background:var(--paper);border:1px solid var(--line);border-radius:18px;overflow:hidden;text-decoration:none;color:inherit;transition:transform .2s,box-shadow .2s}
  .rt-card:hover{transform:translateY(-3px);box-shadow:0 18px 34px -18px rgba(30,40,36,.45)}
  .rt-card img{display:block;width:100%;height:auto;aspect-ratio:16/10;object-fit:cover}
  .rt-bd{padding:14px 16px 16px;display:flex;flex-direction:column;gap:3px}
  .rt-name{font-family:var(--display);font-weight:700;font-size:1.12rem;line-height:1.2;overflow-wrap:anywhere}
  .rt-meta{font-size:.78rem;color:var(--ink-soft)}
  .rt-fare{margin-top:8px;font-size:.84rem}
  .rt-fare b{font-size:1.08rem}
  .list-fares-pending [data-list-fare]{color:transparent}
  .rt-go{margin-top:12px;background:var(--btn-cta);color:#fff;font-weight:600;font-size:.84rem;border-radius:999px;padding:.6rem .9rem;text-align:center;white-space:nowrap}
  .rt-card:hover .rt-go{background:var(--btn-cta-hover)}
  .swipe-hint{display:none;font-size:.76rem;color:var(--ink-soft);margin-top:10px}
  .live{display:inline-flex;align-items:center;gap:.5rem;font-size:.84rem;color:var(--ink-soft);margin-top:18px}
  .live i{width:9px;height:9px;border-radius:50%;background:var(--teal)}
  .all{margin:20px 0 0;font-size:.95rem}.all a{font-weight:600}
  .ask{background:var(--btn-accent);color:#fff}
  .ask .wrap{display:grid;gap:22px;align-items:center}
  @media(min-width:760px){.ask .wrap{grid-template-columns:1fr auto}}
  .ask .eyebrow{color:#fff;opacity:.85}.ask .eyebrow::before{background:#fff}
  .ask h2{color:#fff;margin:0 0 .5rem;line-height:1.08}
  .ask p{margin:0;color:rgba(255,255,255,.88);max-width:36rem;font-size:1.02rem}
  .credits{padding:20px 0 30px;font-size:.74rem;color:var(--ink-soft)}
  .credits .wrap{display:flex;flex-wrap:wrap;gap:6px 14px}
  @media(max-width:759px){
    .section{padding:48px 0}
    .sh{margin-bottom:20px}
    #next .next{display:flex;grid-template-columns:none;overflow-x:auto;scroll-snap-type:x mandatory;scroll-padding:0 24px;gap:12px;margin:0 -24px;padding:4px 24px 12px;scrollbar-width:none;-webkit-overflow-scrolling:touch}
    #next .next::-webkit-scrollbar{display:none}
    #next .next .rt-card{flex:0 0 76%;scroll-snap-align:start}
    #next .swipe-hint{display:block}
  }
  @media(prefers-reduced-motion:reduce){
    html.js .reveal{opacity:1;transform:none;transition:none}
    .g-hero img{animation:none;transform:none}
    .poi,.pl,.rt-card,.pl .why,.dc,.group.on{transition:none;animation:none}
  }`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  let n = 0;
  for (const [rel, html] of generateGuides()) {
    const abs = join(ROOT, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, html);
    n++;
  }
  console.log(`generated ${n} guide pages`);
}
```

- [ ] **Step 5: Write `guide-page.js`**

```js
/* ============================================================
   CEYLON HOP — destination guide page
   ============================================================
   Four small behaviours, no dependencies, classic script:
     1. reveal-on-scroll (the site's initReveal(), same timing)
     2. jump nav: smooth scroll under the sticky bar + scroll-spy on the chips
     3. FAQ tabs
     4. Eat & stay "More" — expands a card's summary in place
   Every animation is CSS; this file only toggles classes. Reduced motion is honoured by
   the stylesheet and by the scroll behaviour below.
   ============================================================ */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 1. Reveal
  var els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) { els.forEach(function (e) { e.classList.add('in'); }); }
  else {
    var io = new IntersectionObserver(function (ents) {
      ents.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: .12, rootMargin: '0px 0px -8% 0px' });
    els.forEach(function (e) { io.observe(e); });
  }

  // 2. Jump nav
  var jump = document.getElementById('jump');
  var links = jump ? Array.prototype.slice.call(jump.querySelectorAll('a')) : [];
  function light(a) {
    links.forEach(function (l) { l.classList.toggle('on', l === a); });
    if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }
  links.forEach(function (a) {
    a.addEventListener('click', function (ev) {
      var t = document.querySelector(a.getAttribute('href'));
      if (!t) return;
      ev.preventDefault();
      var y = t.getBoundingClientRect().top + window.scrollY - jump.getBoundingClientRect().height - 12;
      window.scrollTo({ top: y, behavior: reduce ? 'auto' : 'smooth' });
      light(a);
    });
  });
  if (links.length && 'IntersectionObserver' in window) {
    var spy = new IntersectionObserver(function (ents) {
      ents.forEach(function (e) {
        if (!e.isIntersecting) return;
        var id = '#' + e.target.id;
        links.forEach(function (l) { if (l.getAttribute('href') === id) light(l); });
      });
    }, { rootMargin: '-40% 0px -55% 0px', threshold: 0 });
    links.map(function (a) { return document.querySelector(a.getAttribute('href')); })
      .filter(Boolean).forEach(function (s) { spy.observe(s); });
  }

  // 3. FAQ tabs
  var tabs = Array.prototype.slice.call(document.querySelectorAll('#qtabs button'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('.groups .group'));
  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      var i = +t.getAttribute('data-g');
      tabs.forEach(function (x) { x.classList.toggle('on', x === t); });
      groups.forEach(function (g, j) { g.classList.toggle('on', j === i); });
    });
  });

  // 4. Eat & stay "More"
  Array.prototype.forEach.call(document.querySelectorAll('.pl .tg'), function (b) {
    b.addEventListener('click', function () {
      var c = b.closest('.pl'), open = c.classList.toggle('open');
      b.textContent = open ? 'Less' : 'More';
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });
})();
```

- [ ] **Step 6: Wire `generateGuides()` into the static pages**

In `tools/generate-static-pages.mjs`:
- add `import { generateGuides } from './generate-guides.mjs';` after the existing imports;
- in `generateStaticPages()`, after `for (const post of BLOG_POSTS) out.set(…)`, add:
  ```js
  // Destination guides (tools/guides/*.json → guides/<slug>/index.html).
  for (const [rel, html] of generateGuides()) out.set(rel, html);
  ```

- [ ] **Step 7: Generate and run the test**

```bash
cd <worktree> || exit 1
npm run generate
git status --short | head -20
cd web-tests && npx vitest run unit/guide-pages.test.js unit/guide-content.test.js unit/seo-codegen.test.js
```
Expected: `guides/nuwara-eliya/index.html` created; `sitemap.xml` gains one `<loc>`; the three suites PASS. If the drift test lists other files, `npm run generate` also re-stamped them — inspect with `git diff --stat`; only `sitemap.xml`, `guides/`, and files that legitimately reference the new script should change.

- [ ] **Step 8: Preview in the browser**

Use the `ceylon-hop-booking` launch config (serves the repo root on 4173) **from the worktree** (`CH_STATIC_PORT` not needed): open `http://localhost:4173/guides/nuwara-eliya/`. Check: header links (`../../trip/`, `board.html`, `plan.html`, `tours.html`, `about.html`) go to the right pages; every "See price & book" opens `search.html` with the route pre-filled; jump nav, FAQ tabs and "More" work; Where next shows 4 cards (catalogue prices locally — the engine is unreachable from localhost by design); 375px width looks like the mockup.

- [ ] **Step 9: Commit**

```bash
cd <worktree> || exit 1
git add tools/generate-guides.mjs guide-page.js tools/generate-static-pages.mjs tools/generate-route-pages.mjs guides/nuwara-eliya/index.html sitemap.xml web-tests/unit/guide-pages.test.js
git add -u  # any root pages re-stamped by npm run generate
git commit -m "feat(guides): destination guide generator + Nuwara Eliya page

One JSON per destination (tools/guides/), rendered through renderStandalone() so the chrome,
head assets and analytics match every generated page. Where-next cards reuse the trip-page
markup and route-list-fares.js. Getting here sells the car only; the train is one collapsed line.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Blog hub card

**Files:**
- Modify: `blog.html` (insert before `<div class="grid cols-3" id="posts" style="margin-top:40px"></div>`)
- Test: extend `web-tests/unit/guide-pages.test.js`

**Interfaces:**
- Consumes: `guides/nuwara-eliya/` and `img/guides/nuwara-eliya/hero-900.jpg` from Tasks 1–2.

- [ ] **Step 1: Write the failing test** — append to `web-tests/unit/guide-pages.test.js` inside the `describe`:

```js
  it('blog.html links the guide in static HTML (crawlable without JS)', () => {
    const blog = readFileSync(path.join(ROOT, 'blog.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
    expect(blog).toContain('href="guides/nuwara-eliya/"');
    expect(blog).toContain('src="img/guides/nuwara-eliya/hero-900.jpg"');
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd <worktree>/web-tests && npx vitest run unit/guide-pages.test.js -t "blog.html"`
Expected: FAIL — `expected … to contain 'href="guides/nuwara-eliya/"'`.

- [ ] **Step 3: Add the block to `blog.html`**

Immediately before `    <div class="grid cols-3" id="posts" style="margin-top:40px"></div>`:

```html
    <!-- Destination guides: generated from tools/guides/<slug>.json by tools/generate-guides.mjs.
         Static HTML on purpose — crawlable without JS, unlike the #posts list below. -->
    <div id="guides" style="margin-top:48px">
      <span class="eyebrow">Destination guides</span>
      <h2 style="margin:.3rem 0 .8rem">Where you’re going, from the people who drive there every week</h2>
      <div class="grid cols-3">
        <a class="bcard" href="guides/nuwara-eliya/">
          <img src="img/guides/nuwara-eliya/hero-900.jpg" alt="Tea-covered hills of Nuwara Eliya under a blue sky" width="1800" height="1013" style="display:block;width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:16px" loading="lazy" decoding="async">
          <div class="meta" style="margin-top:14px">Guide · Hill country</div>
          <h3>Nuwara Eliya</h3>
          <p>Horton Plains before the mist, the tea estates, what to wear when it&rsquo;s 8&deg; at dawn &mdash; and how we get you up the hill.</p>
          <span class="more">Read the guide &rarr;</span>
        </a>
      </div>
    </div>
```

- [ ] **Step 4: Regenerate (chrome injector + stamps are idempotent) and test**

```bash
cd <worktree> || exit 1
npm run generate && git status --short
cd web-tests && npx vitest run unit/guide-pages.test.js unit/static-chrome-crawlable.test.js unit/seo-existing-pages.test.js
```
Expected: PASS; `git status` shows only `blog.html` changed.

- [ ] **Step 5: Commit**

```bash
cd <worktree> || exit 1
git add blog.html web-tests/unit/guide-pages.test.js
git commit -m "feat(blog): link the Nuwara Eliya guide from the travel-guide hub

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: End-to-end spec, full gate, PR

**Files:**
- Create: `web-tests/e2e/guide-page.spec.js`

**Interfaces:**
- Consumes: the generated page served by `serve-booking.js` (Playwright `webServer`); `blockLiveApi` from `web-tests/e2e/_stubs.js`.

- [ ] **Step 1: Write the spec**

```js
// The destination guide in a real browser, fully offline (the engine 404s, so Where next shows
// the catalogue fares — exactly what a customer sees when the API is slow).
import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

const URL = '/guides/nuwara-eliya/';

test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

test('renders with the site chrome and the right links', async ({ page }) => {
  await page.goto(URL);
  await expect(page).toHaveTitle(/Nuwara Eliya guide/);
  await expect(page.locator('header.nav a', { hasText: 'Routes & prices' })).toHaveAttribute('href', '../../trip/');
  await expect(page.locator('footer a', { hasText: 'Travel guide' })).toHaveAttribute('href', '../../blog.html');
  const book = page.locator('#here a.btn-cta');
  await expect(book).toHaveCount(3);
  await expect(book.first()).toHaveAttribute('href', '../../search.html?from=kandy&to=nuwara-eliya');
});

test('jump nav scrolls to the section and lights its chip', async ({ page }) => {
  await page.goto(URL);
  await page.locator('#jump a[href="#qa"]').click();
  await expect(page.locator('#jump a[href="#qa"]')).toHaveClass(/on/);
  const top = await page.locator('#qa').evaluate(el => el.getBoundingClientRect().top);
  expect(top).toBeLessThan(200);
});

test('FAQ tabs switch groups and "More" expands an Eat card', async ({ page }) => {
  await page.goto(URL);
  await page.locator('#qtabs button', { hasText: 'Good to know' }).click();
  await expect(page.locator('.groups .group.on .tips li').first()).toBeVisible();
  const card = page.locator('#eat .pl').first();
  await card.locator('.tg').click();
  await expect(card).toHaveClass(/open/);
  await expect(card.locator('.tg')).toHaveText('Less');
});

test('Where next shows four priced cards linking to trip pages', async ({ page }) => {
  await page.goto(URL);
  const cards = page.locator('#next a.rt-card');
  await expect(cards).toHaveCount(4);
  await expect(cards.first()).toHaveAttribute('href', /\.\.\/\.\.\/trip\/nuwara-eliya-to-(kandy|ella)\//);
  // The catalogue figure is baked in and, offline, is what stays (list-fares-pending is released by the timer).
  await expect(cards.first().locator('[data-list-fare]')).toHaveText(/^\$\d/);
});

test('on a phone the Where-next row scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(URL);
  const row = page.locator('#next .next');
  const scrollable = await row.evaluate(el => el.scrollWidth > el.clientWidth + 50);
  expect(scrollable).toBe(true);
  await expect(page.locator('#next .swipe-hint')).toBeVisible();
});
```

- [ ] **Step 2: Run the spec**

Run: `cd <worktree>/web-tests && npx playwright test guide-page`
Expected: 5 passed.

- [ ] **Step 3: Full gate**

```bash
cd <worktree>/web-tests || exit 1
npm run test:all 2>&1 | tail -15; echo "exit=${PIPESTATUS[0]}"
```
Expected: vitest summary all passed, Playwright summary `N passed`, exit=0 (read the real exit code, not tail's). Then `cd <worktree> && npm run generate && git diff --quiet && echo clean`.

- [ ] **Step 4: Commit and open the PR**

```bash
cd <worktree> || exit 1
git add web-tests/e2e/guide-page.spec.js docs/superpowers/plans/2026-09-28-destination-guides.md
git commit -m "test(guides): e2e for the Nuwara Eliya guide

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin feat/destination-guides
```
Open the PR `feat/destination-guides → main` with: what it adds, the red→green evidence from Tasks 1–4, the two follow-ups (trip-page back-links; day-hire booking), and the note that content numbers need the team's check before the link goes to customers. End the description with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
