# Sri Lanka travel FAQ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/sri-lanka-travel-faq/` — one growing reference page generated from `tools/faq/sri-lanka.json`, per the spec `docs/superpowers/specs/2026-10-14-sri-lanka-travel-faq-design.md`.

**Architecture:** A JSON content file → `tools/generate-faq.mjs` (markup + `FAQ_STYLE`) → `sri-lanka-travel-faq/index.html`, rendered through `renderStandalone()` so the chrome is identical to every generated page and hooked into `generateStaticPages()` so the codegen drift test covers it. A classic script `faq-page.js` adds deep links, copy-link, scroll-spy and the phone "Topics" pill. Ceylon Hop fares appear only as `{fare:from:to:service}` tokens resolved from `transfers-data.js` at build time.

**Tech Stack:** Node 20 ESM generators (`tools/*.mjs`), vitest unit tests + Playwright e2e in `web-tests/`, `sips` for image resizing (macOS), no new dependencies.

## Global Constraints

- Work in the worktree `$SCRATCHPAD/wt-faq` on branch `feat/travel-faq-spec` (already exists; `web-tests/node_modules` is symlinked). Never touch the shared checkout. Stage files by path; never `git add -A`.
- **No tuk-tuks and no motorcycles in any photo on this page** (spec §4, owner rule 2026-10-14). Photo `alt`s must not contain "tuk" or "motorcycle"/"motorbike".
- **No literal Ceylon Hop fare in the JSON** — `/\bUSD\s?\d+\.(?:49|99)\b/` must not match; fares are `{fare:<fromId>:<toId>:shared|private}` tokens (spec §6).
- Callouts are exactly two kinds: `tip` → "Our tip" (saffron), `know` → "Good to know" (red). No third.
- Anchor ids are `<topic.id>` and `<topic.id>-<item.id>`; once published they are never renamed.
- Copy: `<h1>` is **Sri Lanka travel FAQ**; breadcrumb is Home › Travel Guide › Travel FAQ; the band is "Still wondering?".
- Only the first item of the first topic is `open` on load.
- Phone rules at `< 900px` (single column, pill); desktop `≥ 900px` (sticky index column, cards two-up).
- Gate before every commit of generated output: `npm run generate` then `npm run stamp` leave no diff; before the PR: `cd web-tests && npm run test:all` green.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| File | Responsibility |
| --- | --- |
| `tools/faq/sri-lanka.json` | **Create.** The content: page meta, 10 topics, photos. The team edits this. |
| `img/faq/hero-{900,1800}.jpg`, `safaris-*.jpg`, `beaches-*.jpg`, `og.jpg` | **Create.** Three Unsplash photos at two sizes + the 1200×630 share image. |
| `credits.html` | **Modify.** Three attribution rows. |
| `tools/generate-faq.mjs` | **Create.** `loadFaq()`, `resolveFares()`, `renderFaq()`, `generateFaq()`, `FAQ_STYLE`. |
| `faq-page.js` | **Create.** Reveal, deep link, copy link, scroll-spy, Topics pill. |
| `tools/generate-static-pages.mjs` | **Modify.** Import and spread `generateFaq()` into `generateStaticPages()`. |
| `tools/generate-route-pages.mjs` | **Modify.** Add `'sri-lanka-travel-faq/'` to `SITEMAP_EXTRA`. |
| `sri-lanka-travel-faq/index.html` | **Generated, committed.** |
| `blog.html` | **Modify.** Static "Know before you go" card block above `#guides`. |
| `web-tests/unit/faq-content.test.js` | **Create.** JSON + photo + credits + fare-token contract. |
| `web-tests/unit/faq-page.test.js` | **Create.** Generated-page contract (spec §12). |
| `web-tests/e2e/faq-page.spec.js` | **Create.** Browser behaviour (spec §12). |

---

### Task 1: Content file, photos, credits

**Files:**
- Create: `tools/faq/sri-lanka.json`
- Create: `img/faq/hero-1800.jpg`, `img/faq/hero-900.jpg`, `img/faq/safaris-1800.jpg`, `img/faq/safaris-900.jpg`, `img/faq/beaches-1800.jpg`, `img/faq/beaches-900.jpg`, `img/faq/og.jpg`
- Modify: `credits.html` (three rows before `</ul>`, after the last `<li><span class="where">Trip pages</span>…` row)
- Test: `web-tests/unit/faq-content.test.js`

**Interfaces:**
- Produces: the JSON shape every later task reads. Top level: `slug, title, description, updated, hero{photo,alt}, lede, ask{wa}, topics[], photos{}`. Topic: `id, name, sub, shape:'qa'|'compare'`; qa has `items[{id,q,a,tip?,offer?,checked?}]`; compare has `count?, photo, pick{q,items[{label,text}]}, cards[{name,bestFor,spec{},link?{text,href}}], notes[]?, checked?`. `photos[stem] = {alt, credit, creditUrl, photoUrl, focal, w, h}`.
- Produces: `FARE_LITERAL` regex semantics (a fare literal is `USD <n>.49` or `USD <n>.99`).

- [ ] **Step 1: Write the failing content test**

Create `web-tests/unit/faq-content.test.js`:

```js
// The travel FAQ's JSON must be internally consistent, name photos that exist at both sizes with
// the dimensions it declares, credit every photographer, and never type a Ceylon Hop fare by hand
// (spec docs/superpowers/specs/2026-10-14-sri-lanka-travel-faq-design.md §4, §5, §6).
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Real pixel size from a JPEG's SOF marker — same reader as guide-content.test.js (no sips: CI is Linux). */
function jpegSize(file) {
  const buf = readFileSync(file);
  let offset = 2;
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) throw new Error(`bad JPEG marker at ${offset} in ${file}`);
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const len = buf.readUInt16BE(offset + 2);
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    offset += 2 + len;
  }
  throw new Error(`no SOF marker found in ${file}`);
}

const FILE = path.join(ROOT, 'tools/faq/sri-lanka.json');
const f = JSON.parse(readFileSync(FILE, 'utf8'));
const raw = readFileSync(FILE, 'utf8');
const FARE_LITERAL = /\bUSD\s?\d+\.(?:49|99)\b/;
const ORDER = ['visa', 'before', 'money', 'around', 'start', 'safaris', 'beaches', 'culture', 'food', 'health'];

describe('tools/faq/sri-lanka.json', () => {
  it('has the page basics', () => {
    expect(f.slug).toBe('sri-lanka-travel-faq');
    expect(f.title.length).toBeLessThanOrEqual(60);
    expect(f.description.length).toBeLessThanOrEqual(158);
    expect(f.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(f.hero.photo).toBe('hero');
    expect(f.lede).toBeTruthy();
    expect(f.ask.wa).toMatch(/^Hi Ceylon Hop/);
  });
  it('lists the ten topics in trip-timeline order, each with a name, sub and shape', () => {
    expect(f.topics.map(t => t.id)).toEqual(ORDER);
    for (const t of f.topics) {
      expect(t.name, t.id).toBeTruthy();
      expect(t.sub, t.id).toBeTruthy();
      expect(['qa', 'compare'], t.id).toContain(t.shape);
      if (t.shape === 'qa') expect(t.items.length, t.id).toBeGreaterThan(0);
      else { expect(t.photo, t.id).toBeTruthy(); expect(t.pick.items.length, t.id).toBeGreaterThan(0); expect(t.cards.length, t.id).toBeGreaterThan(1); }
    }
  });
  it('every anchor id is unique and url-safe', () => {
    const ids = [];
    for (const t of f.topics) {
      ids.push(t.id);
      for (const q of t.items || []) ids.push(`${t.id}-${q.id}`);
    }
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('callouts are only "tip" or "know"; checked dates are ISO; offers carry a target', () => {
    for (const t of f.topics) {
      for (const q of t.items || []) {
        if (q.tip) { expect(['tip', 'know'], `${t.id}-${q.id}`).toContain(q.tip.kind); expect(q.tip.text).toBeTruthy(); }
        if (q.checked) { expect(q.checked.what).toBeTruthy(); expect(q.checked.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); }
        if (q.offer) { expect(q.offer.title && q.offer.sub && q.offer.label).toBeTruthy(); expect(!!q.offer.href !== !!q.offer.wa, 'href xor wa').toBe(true); }
      }
      if (t.checked) expect(t.checked.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it('never types a Ceylon Hop fare by hand — fares are {fare:…} tokens', () => {
    expect(raw).not.toMatch(FARE_LITERAL);
    const tokens = raw.match(/\{fare:[^}]*\}/g) || [];
    expect(tokens.length).toBeGreaterThan(0);
    for (const tk of tokens) expect(tk).toMatch(/^\{fare:[a-z0-9-]+:[a-z0-9-]+:(?:shared|private)\}$/);
  });
  it('names only photos it declares, at both sizes, with the real pixel size — and no tuk-tuks or motorcycles', () => {
    const used = new Set([f.hero.photo, ...f.topics.filter(t => t.photo).map(t => t.photo)]);
    for (const k of used) expect(f.photos[k], `photos.${k}`).toBeTruthy();
    for (const [k, meta] of Object.entries(f.photos)) {
      for (const size of [900, 1800]) expect(existsSync(path.join(ROOT, 'img/faq', `${k}-${size}.jpg`)), `${k}-${size}`).toBe(true);
      const { width, height } = jpegSize(path.join(ROOT, 'img/faq', `${k}-1800.jpg`));
      expect([width, height], k).toEqual([meta.w, meta.h]);
      expect(meta.alt, `${k}.alt`).toBeTruthy();
      expect(meta.alt.toLowerCase()).not.toMatch(/tuk|motorcycle|motorbike/);
      expect(meta.credit, `${k}.credit`).toBeTruthy();
      expect(meta.creditUrl).toMatch(/^https:\/\/unsplash\.com\//);
      expect(meta.photoUrl).toMatch(/^https:\/\/unsplash\.com\/photos\//);
    }
    expect(existsSync(path.join(ROOT, 'img/faq/og.jpg'))).toBe(true);
    expect(jpegSize(path.join(ROOT, 'img/faq/og.jpg'))).toEqual({ width: 1200, height: 630 });
  });
  it('credits every photographer in credits.html', () => {
    const credits = readFileSync(path.join(ROOT, 'credits.html'), 'utf8');
    for (const [k, meta] of Object.entries(f.photos)) {
      expect(credits, `${k} → ${meta.credit}`).toContain(meta.creditUrl);
      expect(credits, `${k} → photo`).toContain(meta.photoUrl);
    }
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd $SCRATCHPAD/wt-faq/web-tests && npx vitest run unit/faq-content.test.js`
Expected: FAIL — `ENOENT … tools/faq/sri-lanka.json`.

- [ ] **Step 3: Download and resize the photos**

Hero = misty tea hills near Nuwara Eliya (16:9). Section photos (16:8). Unsplash file ids from the 2026-10-14 search; downloads were tracked via the Unsplash API as its guidelines require.

```bash
cd $SCRATCHPAD/wt-faq || exit 1
mkdir -p img/faq && cd img/faq || exit 1
dl() { # stem, unsplash file id, height
  curl -sL -o "$1-1800.jpg" "https://images.unsplash.com/$2?auto=format&fit=crop&w=1800&h=$3&q=80&fm=jpg"
  sips -Z 900 "$1-1800.jpg" --out "$1-900.jpg" >/dev/null
}
dl hero     photo-1760532511219-c8b7566f90af 1013
dl safaris  photo-1743014118271-415197f9b0ef 900
dl beaches  photo-1713038580310-21b9d51db417 900
# 1200×630 share image from the hero: scale to 1200 wide, then centre-crop to 630 tall.
sips --resampleWidth 1200 hero-1800.jpg --out og.jpg >/dev/null && sips -c 630 1200 og.jpg >/dev/null
sips -g pixelWidth -g pixelHeight hero-1800.jpg safaris-1800.jpg beaches-1800.jpg og.jpg
```

Expected: `hero-1800.jpg` 1800×1013, `safaris-1800.jpg` 1800×900, `beaches-1800.jpg` 1800×900, `og.jpg` 1200×630. If a dimension differs by a pixel, put the real value in the JSON's `photos` block (the test checks the file, not the request).

- [ ] **Step 4: Write the content file**

Create `tools/faq/sri-lanka.json`. This is the Google Doc migrated with the spec §11 edits (numbering fixed, SIM → Before you fly, Poya → Culture, fares tokenised, "MediHelp" dropped, `checked` only on dated facts). HTML in `a`/`text` fields only; `<p>`, `<ul>/<ol>`, `<b>` and `<a>`.

```json
{
  "slug": "sri-lanka-travel-faq",
  "title": "Sri Lanka travel FAQ — visas, money, trains, safaris",
  "description": "The questions people ask us most about Sri Lanka — visas, money and ATMs, trains and buses, which safari and which beach, health and etiquette — answered and kept current by the Ceylon Hop team.",
  "updated": "2026-10-14",
  "hero": { "photo": "hero", "alt": "Tea fields on a misty hillside near Nuwara Eliya" },
  "lede": "The things people ask us most, answered by the people who drive here every week.",
  "ask": { "wa": "Hi Ceylon Hop, a question about Sri Lanka: " },
  "topics": [
    {
      "id": "visa", "name": "Visa & entry", "sub": "What you need before you fly, and how to stay longer.", "shape": "qa",
      "items": [
        { "id": "how-to-get", "q": "How do I get a visa for Sri Lanka?",
          "a": "<p>Most travellers don't need a traditional visa. You apply online for an <b>Electronic Travel Authorization (ETA)</b> through the official government portal, <a href=\"https://www.eta.gov.lk/\" rel=\"noopener\">eta.gov.lk</a>. It takes a few minutes, and approval usually arrives by email within minutes to a few hours. It is the easiest and fastest route, and what we recommend for almost everyone.</p>",
          "tip": { "kind": "know", "text": "Since October 2025 you must hold a valid ETA <b>before departure</b>, not on arrival. Arriving without one is a real risk to your trip, not just an inconvenience — apply well before you fly." },
          "checked": { "what": "Rules", "date": "2026-10-09" } },
        { "id": "five-ways", "q": "What are the official ways to apply?",
          "a": "<p>Applying online yourself is the simplest, but there are five official channels:</p><ol><li><b>Yourself, online</b> — the standard route, straight through the official ETA portal.</li><li><b>Through a third party</b> — someone applies and pays on your behalf, usually for a slightly higher fee.</li><li><b>At a Sri Lankan overseas mission</b> — your nearest embassy or consulate.</li><li><b>At the Department of Immigration &amp; Emigration</b> head office in Colombo.</li><li><b>On arrival</b> — a limited facility at Bandaranaike International Airport (BIA), with an extra fee and no guarantee. A backup, not a plan.</li></ol>",
          "checked": { "what": "Channels", "date": "2026-10-09" } },
        { "id": "cost", "q": "How much does the ETA cost, and how long does it take?",
          "a": "<ul><li><b>Processing:</b> a few minutes to a few hours for a standard online application.</li><li><b>Cost:</b> roughly USD 20 for most nationalities. Free for travellers from around 40 eligible countries under a recent policy update.</li><li><b>Where:</b> only the official <a href=\"https://www.eta.gov.lk/\" rel=\"noopener\">www.eta.gov.lk</a>. Third-party websites often charge more for the same service.</li></ul>",
          "checked": { "what": "Fees", "date": "2026-10-09" } },
        { "id": "extend", "q": "How do I extend a tourist visa?",
          "a": "<p>Apply online through the Department of Immigration's eServices portal, or in person at the head office in Battaramulla, Colombo.</p>",
          "tip": { "kind": "tip", "text": "Apply at least a week before your current ETA expires. Extension fees vary by nationality — check the current rate on the official site, or ask us and we'll point you in the right direction." },
          "checked": { "what": "Process", "date": "2026-10-09" } }
      ]
    },
    {
      "id": "before", "name": "Before you fly", "sub": "The small things that make the first day easy.", "shape": "qa",
      "items": [
        { "id": "sim", "q": "Should I get a local SIM, and where?",
          "a": "<p>Yes — Sri Lanka has a few mobile networks with good coverage across most of the island, including the tourist belts like Mirissa and Weligama and the hill-country roads toward Ella.</p><p><b>Physical SIM:</b> easiest at the airport counters near baggage claim. Bring your passport; activation takes a few minutes. If you miss them, retail outlets island-wide sell SIMs for a small cost, and a tourist bundle usually activates instantly.</p><p><b>eSIM:</b> most networks offer a tourist eSIM if your phone supports it, bought and activated digitally before or after you land — no SIM tray needed.</p>",
          "tip": { "kind": "tip", "text": "Pick a network with a working top-up app (Dialog's MyDialog, for example) so you can top up with a card any time, without hunting for a shop." } },
        { "id": "travel-card", "q": "Will my travel card (Wise, Revolut) work here?",
          "a": "<p>Yes, for card payments and ATMs. Check your fee-free monthly withdrawal limit before you go — once you pass it, a percentage fee usually applies. And ask your home bank about international withdrawal fees and daily limits; some cap foreign withdrawals lower than Sri Lanka's ATMs allow.</p>" },
        { "id": "pack-temples", "q": "What do I need to pack for temples?",
          "a": "<p>Something that covers your shoulders and knees — a light scarf or sarong does the job and packs flat. Shoes come off at the entrance, so slip-ons help. The Temple of the Tooth in Kandy enforces this strictly; most other temples are relaxed but the rule is the same.</p>" },
        { "id": "pack-leeches", "q": "Do I need anything for leeches?",
          "a": "<p>Only if you're hiking in the wetter, forested areas — Ella, Sinharaja, Horton Plains, the Knuckles, parts of the hills around Kandy — especially during and after the rains. Long socks or leech socks help, and a small sachet of salt is the classic fix (see <a href=\"#health-leeches\">Health &amp; safety</a>).</p>" }
      ]
    },
    {
      "id": "money", "name": "Money", "sub": "Rupees, cards, ATMs, tipping — and what a day actually costs.", "shape": "qa",
      "items": [
        { "id": "exchange-rate", "q": "What's the exchange rate?",
          "a": "<p>The local currency is the Sri Lankan Rupee (LKR). As of October 2026, USD 1 is roughly LKR 331 to 335, though the rate moves daily — check a live rate before you travel rather than relying on a fixed number.</p>",
          "checked": { "what": "Rate", "date": "2026-10-09" } },
        { "id": "where-to-exchange", "q": "Where's the best place to change money?",
          "a": "<p>You'll generally get a better rate changing cash once you're in Sri Lanka than before you leave home. Don't change your whole trip budget at the airport — the rate there is usually weaker than in the city.</p>" },
        { "id": "cash-or-card", "q": "Cash or card?",
          "a": "<p>Both. Cards are widely accepted in hotels, malls and bigger restaurants, but smaller cafés, tuk tuks, local shops and rural areas are often cash only. Carry a mix, and keep small notes for day-to-day spending.</p><ul><li>Contactless (tap-to-pay) isn't widespread outside the bigger cities and malls, so don't assume you can tap everywhere.</li><li>Small businesses often can't break large notes — breaking a 5,000-rupee note for a 200-rupee fare is a common friction point.</li></ul>" },
        { "id": "atms", "q": "Should I use ATMs?",
          "a": "<p>Yes — they're everywhere in cities and most towns. If the ATM offers to \"convert\" the amount for you (Dynamic Currency Conversion), <b>always say no</b> and let your own bank do the conversion: the ATM's rate is usually 3 to 5% worse. Use a debit card, not a credit card — credit cards usually trigger a cash-advance fee.</p>" },
        { "id": "best-atms", "q": "Which ATMs are best for foreign cards?",
          "a": "<p>Bank of Ceylon (BOC) and Commercial Bank are generally the most fee-free or low-fee for foreign cards, though it varies with your own bank, so try both if you can. HNB, Seylan and Sampath tend to charge a flat fee per withdrawal, usually LKR 500 to 1,000, on top of whatever your home bank charges. Most ATMs cap a single withdrawal at LKR 100,000 to 200,000, so you may need two goes for more than that.</p>",
          "checked": { "what": "Fees and caps", "date": "2026-10-09" } },
        { "id": "tipping", "q": "Is tipping expected?",
          "a": "<p>Not mandatory, but appreciated. Most restaurants and hotels already add a service charge, so a tip on top is optional — a little extra for good service is always welcome. For drivers and guides, a tip at the end of the trip is customary.</p>" },
        { "id": "bargaining", "q": "Is bargaining normal?",
          "a": "<p>Prices are fixed in shops, malls and restaurants. Bargaining is expected at markets and for unmetered tuk tuks — agree the price before you get in, or before you buy.</p>" },
        { "id": "daily-budget", "q": "What does a day cost?",
          "a": "<p>It depends on your style — where you sleep, what you eat, and how often you move between places. Per person, per day, as a rough guide:</p><ul><li><b>Budget — around USD 25 to 50.</b> Budget rooms, local food, buses and trains. Public transport is cheap but crowded; on selected routes our shared taxi gives you a seat at a fixed price — Colombo Airport to Sigiriya is {fare:cmb-airport:sigiriya:shared} a seat, Ella to Yala {fare:ella:yala:shared}.</li><li><b>Mid-range — around USD 60 to 100.</b> Comfortable guesthouses or boutique hotels, a mix of local and tourist restaurants, activities, and convenient transport. Our private transfers start around {fare:galle:mirissa:private} for a short hop like Galle to Mirissa; the price is per car, so it goes a long way split between friends or family.</li><li><b>Luxury — USD 150 to 300 and up.</b> Higher-end hotels, a wider choice of restaurants, private transport or a chauffeur for the whole trip.</li></ul><p>These are approximate. Entrance fees, safaris and travel days push a day up; a day spent in one place pulls it down. <a href=\"../trip/\">All our routes and prices →</a></p>",
          "offer": { "title": "Fixed prices for every route", "sub": "Private car or a shared seat — see what each leg costs before you commit", "href": "../trip/", "label": "See routes & prices" } }
      ]
    },
    {
      "id": "around", "name": "Getting around", "sub": "Trains, buses, Colombo's new metro buses — and when to just let us drive.", "shape": "qa",
      "items": [
        { "id": "kandy-ella-train", "q": "How do we book the Kandy to Ella train?",
          "a": "<p>Right now the <b>Kandy to Nanu Oya line isn't running</b>, so that leg has to be done by road. From Nanu Oya to Ella the train is still running and is still one of the most scenic rides in the country. Reserved seats are sold on the official Sri Lanka Railways site, <a href=\"https://seatreservation.railway.gov.lk/\" rel=\"noopener\">seatreservation.railway.gov.lk</a>. It's popular and can sell out weeks ahead in peak season, so book as early as you can.</p>",
          "tip": { "kind": "tip", "text": "Avoid 3rd class — it gets very crowded. Go for 2nd class, or the 1st-class observation car if you can get it. Message us on WhatsApp with your dates and we'll check availability, or sort the road alternative if the train doesn't work out." },
          "offer": { "title": "We drive the Kandy → Nuwara Eliya leg while the line is closed", "sub": "Fixed price, door to door, and we'll drop you at Nanu Oya for the train on to Ella", "href": "../search.html?from=kandy&to=nuwara-eliya", "label": "See price & book" },
          "checked": { "what": "Line status", "date": "2026-10-09" } },
        { "id": "buses", "q": "Are the public buses worth it?",
          "a": "<p>Buses cover almost every route in the country and are the cheapest way to get around, but they get crowded — on popular routes and in peak season, standing room only isn't unusual. A solid budget option if you don't mind the squeeze; worth knowing before you commit to one for a long journey. <a href=\"../how-to-use-buses-in-sri-lanka-the-ultimate-guide-for-the-adventurous-travelers/\">Our bus guide →</a></p>" },
        { "id": "metro-buses", "q": "What are the new Metro Buses in Colombo?",
          "a": "<p>Sri Lanka launched a government-run Metro Bus service in April 2026, and on 29 September 2026 it grew from two routes to seven, with around 122 air-conditioned, low-floor buses. They run on fixed, numbered routes (CM01 to CM08, with no CM07 yet) and stop only at designated stops.</p><p><b>Useful for travellers:</b></p><ul><li><b>CM06 (Kollupitiya Circular)</b> — a loop around central Colombo, the most useful if you're staying in the city.</li><li><b>CM04 (Dematagoda to Panadura)</b> — south along the coast through Dehiwala and Moratuwa; handy near Mount Lavinia.</li><li><b>CM01 and CM03</b> — connect to Makumbura, where the expressway buses to the south leave from.</li></ul><p><b>Good to know:</b> no route goes to the airport; they're city buses, not luggage buses; they still sit in traffic (more comfortable than regular buses, not faster); they're wheelchair accessible — low floors, ramps, priority seating; Colombo only for now, Kandy and Galle mentioned for later. Use only the official app and site, <a href=\"https://lankametro.lk/\" rel=\"noopener\">lankametro.lk</a> — some unofficial sites still show pilot timetables.</p>",
          "tip": { "kind": "tip", "text": "For short city hops without luggage, CM06 is a comfortable, cheap option. For anything involving bags, the airport or a tight schedule, message us and we'll arrange a transfer." },
          "checked": { "what": "Routes", "date": "2026-10-09" } },
        { "id": "metro-pay", "q": "How do I pay on a metro bus?",
          "a": "<p>Tap an LMT Touch card or scan a QR ticket in the official LMT GO app. We couldn't find an official fare table yet, so check the app or ask on board before you ride. Cash was reported during the pilot, but confirm on your route.</p>",
          "checked": { "what": "Payment", "date": "2026-10-09" } },
        { "id": "scenic-road", "q": "Should I ask the driver for the scenic road?",
          "a": "<p>When you can, yes. On some legs there's a non-highway route that takes a little longer but passes through small towns, tea estates or coastline you'd never see from the expressway. Worth asking for on Kandy to Nuwara Eliya, or along the south coast. With us, just say so when you book.</p>" }
      ]
    },
    {
      "id": "start", "name": "Where to start", "sub": "Where you spend the first night depends on who's coming.", "shape": "qa",
      "items": [
        { "id": "first-night", "q": "I've just landed and need a first night near the airport — where?",
          "a": "<p>Negombo or Katunayake, both 10 to 15 minutes from the airport. Katunayake has budget-friendly hotels if you just want to sleep after a late flight. Negombo is a beach town with more restaurants and things to do — better if you'd like to relax a little before heading on.</p>" },
        { "id": "solo", "q": "I'm travelling solo — where should I start?",
          "a": "<p>Ella and Colombo city are both good choices: plenty of hostels, cafés and other travellers around. If you'd rather start somewhere quieter, Negombo's beach is an easier place to settle in alone.</p>" },
        { "id": "family", "q": "We're a family — where should we start?",
          "a": "<p>A beach town is usually easier than the hill country for the first couple of nights: less travel, more facilities nearby, which helps after a long flight. Bentota and Negombo both have family-friendly hotels with pools — useful if the kids need to rest and play before you move on.</p>" },
        { "id": "mobility", "q": "One of us has limited mobility — where's easiest?",
          "a": "<p>Flatter beach towns like Negombo or Bentota are easier to get around than the hill country or Sigiriya. We'd also book a private driver from the start rather than trains or tuk tuks, so you have transport right to the door, without stairs or long walks.</p>",
          "offer": { "title": "A private driver for the whole trip", "sub": "Door to door, no stairs, no changes — tell us what you need and we'll plan around it", "wa": "Hi Ceylon Hop, we're planning a trip and one of us has limited mobility. Can you help us plan the route? ", "label": "Ask us on WhatsApp" } },
        { "id": "see-most", "q": "We want to see most of Sri Lanka — which way round?",
          "a": "<p>A common route: start on the west coast in Negombo, head to Sigiriya and Dambulla, then up into the hills (Kandy, Nuwara Eliya, Ella), and finish on the south coast before heading back to Colombo for your flight. It keeps the trip moving in one direction instead of doubling back.</p>",
          "tip": { "kind": "tip", "text": "Tell us how long you have, who's coming, and what matters most — relaxing or sightseeing — and we'll help you plan the order that works best." },
          "offer": { "title": "Plan a multi-stop trip", "sub": "Pick your stops and nights; we price every leg", "href": "../plan.html", "label": "Open the planner" } }
      ]
    },
    {
      "id": "safaris", "name": "Wildlife & safaris", "sub": "Each park is best at one thing. The short answer first, then the parks.", "shape": "compare", "count": "4 parks",
      "photo": "safaris",
      "pick": { "q": "Which safari park should you pick?", "items": [
        { "label": "Leopards", "text": "Yala for the best odds; Wilpattu for a quieter drive with slightly lower odds." },
        { "label": "Elephants, any time of year", "text": "Udawalawe." },
        { "label": "The spectacle", "text": "Minneriya or Kaudulla, July to October, for \"The Gathering\"." },
        { "label": "Avoid crowds", "text": "Wilpattu, then Udawalawe." },
        { "label": "Based on the south coast, little time", "text": "Yala or Udawalawe — about two hours apart." } ] },
      "cards": [
        { "name": "Yala", "bestFor": "leopards, and the widest variety — elephants, sloth bears, crocodiles, birds.",
          "spec": { "crowds": "Busiest by far — roughly twice the visits of the next park in 2025. Block 1, where most of the leopards are, gets the heaviest traffic: dozens of jeeps at one sighting.", "season": "Roughly February to July. The main blocks close for about six weeks from mid September to mid October.", "go": "Morning — cooler, animals more active. Pick-ups around 4:30 AM for a 6 AM gate; expect a queue either slot." },
          "link": { "text": "Transfers to Yala →", "href": "trip/ella-to-yala/" } },
        { "name": "Udawalawe", "bestFor": "elephants, reliably, all year. Open grassland makes animals easy to spot, even at midday.",
          "spec": { "crowds": "Moderate — about half of Yala's numbers. Calmer, not empty.", "season": "Open year round; the dry season, roughly May to September, is best, when animals gather at the waterholes.", "go": "Morning or late afternoon." } },
        { "name": "Wilpattu", "bestFor": "a quiet safari — leopards, sloth bears, natural lakes and birdlife.",
          "spec": { "crowds": "Light — roughly a fifth of Yala's visits in 2025.", "season": "Open year round; conditions generally best from around March to September." } },
        { "name": "Minneriya / Kaudulla", "bestFor": "\"The Gathering\" — 300-plus elephants around the reservoir.",
          "spec": { "crowds": "Quieter than Yala most of the year, busy at peak with clusters of jeeps around the herds.", "season": "Roughly July to October, peaking August and September. The herds move between the two parks with the water levels." },
          "link": { "text": "Sigiriya &amp; Dambulla guide →", "href": "guides/sigiriya/" } }
      ],
      "notes": [
        "Mornings (roughly 6 to 10 AM) tend to give the best sightings; afternoons from about 3 PM give softer light for photos.",
        "Sightings are never guaranteed, in any park.",
        "Closure dates and park fees change — confirm both before booking.",
        "Yala's Block 1 has one of the highest leopard densities recorded anywhere: the Yala Leopard Diary identified 189 individuals there between 2013 and 2026, about 0.5 per square kilometre. That's why the odds are best here."
      ],
      "tip": { "kind": "tip", "text": "Tell us how many days you have and what you most want to see, and we'll match the park to the month you're travelling." },
      "checked": { "what": "Seasons and closures", "date": "2026-10-09" }
    },
    {
      "id": "beaches", "name": "Beaches", "sub": "Surf, swimming, nightlife or quiet — the south coast has one for each.", "shape": "compare", "count": "5 beaches",
      "photo": "beaches",
      "pick": { "q": "Which beach should you pick?", "items": [
        { "label": "Only time for one", "text": "Mirissa or Hiriketiya — they cover the widest range (whales plus a beach scene, or surf plus a slow pace)." },
        { "label": "Learning to surf", "text": "Weligama, then move on to Hiriketiya or Mirissa to progress or just relax." },
        { "label": "Calm swimming, families", "text": "Unawatuna." },
        { "label": "Away from the crowds", "text": "Tangalle." } ] },
      "cards": [
        { "name": "Mirissa", "bestFor": "whale watching and a social atmosphere.",
          "spec": { "vibe": "A relaxed beach town that's become one of the top whale-watching spots in the world (November to April). A solid mix of restaurants, cafés and a few lively evening spots, without feeling as built-up as Unawatuna.", "swimming": "Good; busier in season.", "surf": "Some — Weligama next door is the surf beach." },
          "link": { "text": "Mirissa guide →", "href": "guides/mirissa/" } },
        { "name": "Hiriketiya", "bestFor": "mid and experienced surfers, a slower pace, café hopping.",
          "spec": { "vibe": "A small horseshoe bay with consistently good surf. Younger and more laid-back than Mirissa, with a strong café and yoga culture. Suits settling in for a few days rather than passing through.", "swimming": "Fine on the inside of the bay; watch the surf side.", "surf": "Consistent; intermediate and up." },
          "link": { "text": "Hiriketiya guide →", "href": "guides/hiriketiya/" } },
        { "name": "Unawatuna", "bestFor": "calm swimming and a classic beach holiday.",
          "spec": { "vibe": "A sheltered crescent bay, more developed than Hiriketiya or Mirissa, with a bigger stretch of hotels and restaurants right on the sand.", "swimming": "Some of the calmest on the south coast — genuinely safer for families and less confident swimmers than the open beaches nearby.", "surf": "No." } },
        { "name": "Weligama", "bestFor": "learning to surf, specifically.",
          "spec": { "vibe": "Less about the beach, more about the activity — surf schools line the whole bay and most people come to learn, then move on.", "swimming": "Gentle.", "surf": "The clear first choice for beginners: soft, sandy-bottomed waves, a gentle swell, no reef or strong current." } },
        { "name": "Tangalle", "bestFor": "getting away from the crowds.",
          "spec": { "vibe": "A longer, wilder stretch of coast and fewer people. Good once you've done the busier towns and want to switch off — which also means fewer restaurants and less nightlife within walking distance.", "swimming": "Open beaches; take care with currents.", "surf": "Little." } }
      ],
      "checked": { "what": "Whale season", "date": "2026-10-09" }
    },
    {
      "id": "culture", "name": "Culture & etiquette", "sub": "A few things that are easy to get wrong, and easy to get right.", "shape": "qa",
      "items": [
        { "id": "buddha-photos", "q": "Can I take photos with Buddha statues?",
          "a": "<p>Be careful here — it's a common mistake. Never pose with your back to a Buddha statue, never climb on one, and avoid selfies that could be seen as disrespectful. Treat statues and images with the same respect you'd show inside the temple itself.</p>" },
        { "id": "photographing-people", "q": "Should I ask before photographing people?",
          "a": "<p>Yes, always — especially in rural areas, at markets and at religious sites. Most people are happy to say yes, and it's a basic courtesy that's genuinely appreciated.</p>" },
        { "id": "temple-of-the-tooth", "q": "What should I know about the Temple of the Tooth?",
          "a": "<p>Sri Lanka's most sacred Buddhist site enforces the dress code more strictly than most temples — security staff check that shoulders and knees are fully covered, so arrive dressed properly. Shoes off before you enter the complex. The relic itself is never on display; you're viewing the golden casket it's kept in, during one of three daily puja (worship) sessions: roughly 5:30 to 6:45 AM, 9:30 to 11:45 AM, and 6:30 to 8 PM.</p>",
          "tip": { "kind": "tip", "text": "The early-morning session is the quietest and least crowded." },
          "checked": { "what": "Puja times", "date": "2026-10-09" } },
        { "id": "poya", "q": "What are Poya days?",
          "a": "<p>Full-moon days — one a month, and a public holiday. Alcohol isn't sold on Poya days: some bars and restaurants may still serve what's already open, but new sales are restricted. Check the Sri Lankan calendar if it matters to your plans, and pick something up the day before.</p>" }
      ]
    },
    {
      "id": "food", "name": "Food & drink", "sub": "What to order, and what to ask for.", "shape": "qa",
      "items": [
        { "id": "vegetarian", "q": "I'm vegetarian or vegan — will I eat well?",
          "a": "<p>Genuinely well. Sri Lankan cooking is naturally vegetable and legume heavy — dhal, coconut sambols, jackfruit curry and a wide range of vegetable curries are everyday staples, not special requests. Most restaurants have vegan or vegetarian options even if the menu doesn't label them.</p>",
          "tip": { "kind": "tip", "text": "Be clear when ordering: ask for \"no meat, no fish, no eggs\". \"Vegetarian\" alone sometimes still includes fish or ghee in translation." } },
        { "id": "arrack", "q": "What's the local spirit?",
          "a": "<p>Arrack — distilled from coconut-flower sap, Sri Lanka's answer to rum. Usually drunk with ice, soda or ginger ale. Worth trying at least once.</p>" },
        { "id": "beer", "q": "What's the local beer?",
          "a": "<p>Lion. It's the country's oldest and largest brewery, and Lion Lager is the standard order at most bars, restaurants and beach shacks — light and easy-drinking at around 4.8%. Lion Strong is a heavier lager; Lion Stout is a rich, dark beer with chocolate and coffee notes. Strong beers and stouts are popular here, even in the heat.</p>",
          "tip": { "kind": "tip", "text": "Not sure what to order? Ask for \"a Lion\" and you'll get the lager. And remember no alcohol is sold on Poya days — see <a href=\"#culture-poya\">Culture &amp; etiquette</a>." } }
      ]
    },
    {
      "id": "health", "name": "Health & safety", "sub": "The pharmacy, the dispensary, the hospital — and the leeches.", "shape": "qa",
      "items": [
        { "id": "mosquitoes", "q": "Do I need mosquito repellent?",
          "a": "<p>Yes — carry it with you at all times, even in the city. <b>Soffell</b> is the local go-to brand, available at any pharmacy or supermarket.</p>" },
        { "id": "leeches", "q": "What do I do about leeches?",
          "a": "<p>Leeches are common in the wetter, forested areas — Ella, Sinharaja Forest, Horton Plains, some of the hills around Kandy and the Knuckles Range — especially during and after the rains. Long socks or leech socks help if you're hiking there.</p><p>If one attaches, <b>don't pull it off</b> — that can leave part of its mouth in the wound. Sprinkle a pinch of salt directly on it; it curls up and drops off within seconds. Worth carrying a small sachet of salt in leech country.</p>" },
        { "id": "samahan", "q": "What's Samahan?",
          "a": "<p>Your best friend if you're feeling under the weather: a traditional Ayurvedic herbal blend of 14 ingredients — mainly ginger, pepper, cinnamon, coriander and liquorice — dissolved in hot water. Widely used for colds, sore throats and general aches, and sold at any pharmacy or supermarket.</p>" },
        { "id": "dispensary", "q": "What's a dispensary, and should I use one?",
          "a": "<p>A small neighbourhood clinic found in most towns, where you see a doctor and get your medicine in the same place. The most convenient option for minor problems — an upset stomach, a cold, a mild fever, a rash, a small cut.</p><ul><li><b>Are they free?</b> Government and municipal dispensaries offer free consultations and medicines, mainly for residents, and can be busy. Private dispensaries charge a small consultation fee and are quicker — usually the better choice for travellers.</li><li><b>Do I need an appointment?</b> Usually not. Walk in, wait your turn, see the doctor. Evenings are busiest; earlier in the day is quicker.</li></ul>" },
        { "id": "pharmacies", "q": "Can I buy medicine without a prescription?",
          "a": "<p>Pharmacies are everywhere, and many common medicines are sold without a prescription. If you take regular medication, bring enough for the whole trip, plus a copy of the prescription.</p>" },
        { "id": "hospital", "q": "When should I go to a hospital instead?",
          "a": "<p>For anything serious — chest pain, a bad injury, a high fever with vomiting, breathing problems — skip the dispensary and go straight to a hospital. The national ambulance line is <b>199</b>.</p>" },
        { "id": "colombo-hospitals", "q": "Which private hospitals in Colombo should I know?",
          "a": "<p>All of these run 24-hour emergency departments and have international patient support:</p><ul><li><b>Lanka Hospitals</b> — 578 Elvitigala Mawatha, Colombo 5. A flagship private hospital, with a helipad for transfers from outside the city.</li><li><b>Asiri Central Hospital</b> — 114 Norris Canal Road, Colombo 10. Part of the country's largest private hospital group; often recommended for efficient emergency care.</li><li><b>Durdans Hospital</b> — 3 Alfred Place, Colombo 3. JCI-accredited, with an international patient care service.</li><li><b>Nawaloka Hospital</b> — 23 Deshamanya H K Dharmadasa Mawatha, Colombo 2. Long-established, with a dedicated international patient team.</li><li><b>Asiri Surgical Hospital</b> — 21 Kirimandala Mawatha, Colombo 5. A good option for surgical and specialist care.</li></ul>",
          "tip": { "kind": "tip", "text": "If you're unsure where to go, message us on WhatsApp and we'll point you to the nearest option for wherever you're staying." },
          "checked": { "what": "List", "date": "2026-10-09" } }
      ]
    }
  ],
  "photos": {
    "hero": { "alt": "Tea fields on a misty hillside near Nuwara Eliya", "credit": "Erik Esly", "creditUrl": "https://unsplash.com/@lensofbbb?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/lush-green-tea-plantation-on-a-misty-hillside-ZWdrM9IBBIE?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 55%", "w": 1800, "h": 1013 },
    "safaris": { "alt": "A leopard yawning in Yala National Park", "credit": "Tommaso Delton", "creditUrl": "https://unsplash.com/@tommasodelton?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/a-leopard-yawns-widely-while-sitting-_sFOJHDmO6A?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 50%", "w": 1800, "h": 900 },
    "beaches": { "alt": "Palms and fishing boats at Coconut Tree Hill, Mirissa", "credit": "Austin Curtis", "creditUrl": "https://unsplash.com/@afcurtis?utm_source=ceylon_hop&utm_medium=referral", "photoUrl": "https://unsplash.com/photos/a-beach-with-palm-trees-and-boats-in-the-water-nkgwvrUhdUA?utm_source=ceylon_hop&utm_medium=referral", "focal": "50% 60%", "w": 1800, "h": 900 }
  }
}
```

Note the compare topics carry an optional `tip` at topic level (same `{kind,text}` shape) — the generator renders it after the notes.

- [ ] **Step 5: Add the credits rows**

In `credits.html`, after the last `<li><span class="where">Trip pages</span>…</li>` row ("A road through tea country") and before `</ul>`, add:

```html
    <li><span class="where">Travel FAQ</span><span>Tea fields near Nuwara Eliya — photo by <a href="https://unsplash.com/@lensofbbb?utm_source=ceylon_hop&utm_medium=referral">Erik Esly</a> on <a href="https://unsplash.com/photos/lush-green-tea-plantation-on-a-misty-hillside-ZWdrM9IBBIE?utm_source=ceylon_hop&utm_medium=referral">Unsplash</a></span></li>
    <li><span class="where">Travel FAQ</span><span>A leopard in Yala — photo by <a href="https://unsplash.com/@tommasodelton?utm_source=ceylon_hop&utm_medium=referral">Tommaso Delton</a> on <a href="https://unsplash.com/photos/a-leopard-yawns-widely-while-sitting-_sFOJHDmO6A?utm_source=ceylon_hop&utm_medium=referral">Unsplash</a></span></li>
    <li><span class="where">Travel FAQ</span><span>Coconut Tree Hill, Mirissa — photo by <a href="https://unsplash.com/@afcurtis?utm_source=ceylon_hop&utm_medium=referral">Austin Curtis</a> on <a href="https://unsplash.com/photos/a-beach-with-palm-trees-and-boats-in-the-water-nkgwvrUhdUA?utm_source=ceylon_hop&utm_medium=referral">Unsplash</a></span></li>
```

- [ ] **Step 6: Run the content test to see it pass**

Run: `cd $SCRATCHPAD/wt-faq/web-tests && npx vitest run unit/faq-content.test.js`
Expected: PASS (7 tests). If the dimension test fails, copy the printed real size into `photos.<stem>.w/h`.

- [ ] **Step 7: Stamp and commit**

`credits.html` is a root asset, so stamp before committing (memory: forgetting it turned #974 red).

```bash
cd $SCRATCHPAD/wt-faq && npm run stamp && git status --short
git add tools/faq/sri-lanka.json img/faq credits.html web-tests/unit/faq-content.test.js
git commit -m "feat(faq): Sri Lanka travel FAQ content, photos and credits

The team's FAQ doc migrated to tools/faq/sri-lanka.json: ten topics in
trip-timeline order, Ceylon Hop fares as {fare:…} tokens, 'checked'
dates only on dated facts. Three Unsplash photos (no tuk-tuks or
motorcycles — owner rule 2026-10-14) at 900/1800 plus og.jpg.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

If `npm run stamp` changed other root pages because `credits.html` is referenced nowhere as an asset, nothing else changes; if it did change pages, `git add` those too (they belong to this change).

---

### Task 2: Generator, page script, wiring

**Files:**
- Create: `tools/generate-faq.mjs`
- Create: `faq-page.js`
- Modify: `tools/generate-static-pages.mjs` (import + one line in `generateStaticPages()`)
- Modify: `tools/generate-route-pages.mjs` (`SITEMAP_EXTRA`)
- Generate: `sri-lanka-travel-faq/index.html`
- Test: `web-tests/unit/faq-page.test.js`

**Interfaces:**
- Consumes: the JSON from Task 1; `loadTransfers()` → `T.sharedOption(from,to).seat`, `T.privateQuote(from,to).car`, `T.byId`; `renderStandalone({title, description, canonicalPath, depth, active, ogImage, style, bodyHtml})`; `assetV(file)`, `WA`, `ORIGIN`, `ROOT`.
- Produces: `export function loadFaq()`, `export function resolveFares(html, T)` (throws on an unknown place or a missing shared product), `export function renderFaq(f, T)` → html string, `export function generateFaq()` → `Map<'sri-lanka-travel-faq/index.html', html>`, `export const FAQ_PATH = 'sri-lanka-travel-faq/'`. Markup contract used by tests and `faq-page.js`: `aside#topics ol.idx a[href="#<id>"]`, `section.topic#<id>`, `details#<topic>-<item>`, `button.cl[data-link]`, `a.pill#pill[href="#topics"]`, `.foot .chk`, `.tip` / `.tip.warn`, `a.ch-row`, `.pick`, `.cmp .cc`.

- [ ] **Step 1: Write the failing page test**

Create `web-tests/unit/faq-page.test.js`:

```js
// Contract for the generated travel FAQ (spec 2026-10-14-sri-lanka-travel-faq-design.md §4–§8, §12).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { generateFaq, renderFaq, resolveFares, loadFaq, FAQ_PATH } from '../../tools/generate-faq.mjs';
import { loadTransfers } from '../../tools/load-transfers.mjs';
import { generateStaticPages } from '../../tools/generate-static-pages.mjs';
import { generateAll, ROOT } from '../../tools/generate-route-pages.mjs';

const REL = `${FAQ_PATH}index.html`;
const html = generateFaq().get(REL);
const f = loadFaq();
const T = loadTransfers();
const noJs = h => h.replace(/<script[\s\S]*?<\/script>/g, '');
const section = (h, id) => {
  const i = h.indexOf(`<section class="topic" id="${id}"`); expect(i, `topic #${id}`).toBeGreaterThan(-1);
  const j = h.indexOf('</section>', i); return h.slice(i, j);
};
const ld = type => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  .map(m => JSON.parse(m[1])).find(o => o['@type'] === type);

describe('generateFaq', () => {
  it('emits the page and generateStaticPages includes it', () => {
    expect(html).toBeTruthy();
    expect(generateStaticPages().has(REL)).toBe(true);
  });
  it('carries title, canonical, OG image, Article + FAQPage + BreadcrumbList', () => {
    expect(html).toContain('<title>Sri Lanka travel FAQ — visas, money, trains, safaris</title>');
    expect(html).toContain('<link rel="canonical" href="https://ceylonhop.com/sri-lanka-travel-faq/">');
    expect(html).toContain('<meta property="og:image" content="https://ceylonhop.com/img/faq/og.jpg">');
    expect(ld('Article').dateModified).toBe(f.updated);
    expect(ld('BreadcrumbList').itemListElement.map(x => x.name)).toEqual(['Home', 'Travel Guide', 'Sri Lanka travel FAQ']);
    const qa = f.topics.filter(t => t.shape === 'qa').reduce((n, t) => n + t.items.length, 0);
    const cmp = f.topics.filter(t => t.shape === 'compare').length;
    expect(ld('FAQPage').mainEntity).toHaveLength(qa + cmp);
    expect(ld('FAQPage').mainEntity.map(q => q.name)).toContain('Which safari park should you pick?');
    expect(ld('FAQPage').mainEntity.every(q => q.acceptedAnswer.text.length > 20)).toBe(true);
  });
  it('ships the site chrome without JavaScript (header, footer, route index link)', () => {
    const h = noJs(html);
    expect(h).toMatch(/<header class="nav/);
    expect(h).toMatch(/<footer/);
    expect(h).toMatch(/href="\.\.\/trip\/"/);
    expect(h).toContain('href="../blog.html"');
  });
  it('banner: h1, breadcrumb, computed answer count and long updated date', () => {
    expect(html).toContain('<h1>Sri Lanka travel FAQ</h1>');
    expect(html).toContain('<span class="bc-cur" aria-current="page">Travel FAQ</span>');
    const qa = f.topics.filter(t => t.shape === 'qa').reduce((n, t) => n + t.items.length, 0);
    const cmp = f.topics.filter(t => t.shape === 'compare').length;
    expect(html).toContain(`${qa + cmp} answers · Updated 14 October 2026`);
  });
  it('index lists every topic in order with a count, and every entry targets a section', () => {
    const idx = html.slice(html.indexOf('<aside class="f-index" id="topics"'), html.indexOf('</aside>'));
    const ids = [...idx.matchAll(/href="#([a-z-]+)"/g)].map(m => m[1]);
    expect(ids).toEqual(f.topics.map(t => t.id));
    for (const id of ids) expect(html).toContain(`<section class="topic" id="${id}"`);
    expect(idx).toContain('<span class="c">4 parks</span>');
    expect(idx).toContain(`<span class="c">${f.topics[0].items.length}</span>`);
  });
  it('only the first question is open; every question has a stable anchor and a copy-link button', () => {
    expect(html.match(/<details[^>]*\sopen/g)).toHaveLength(1);
    expect(html).toMatch(/<details id="visa-how-to-get" open>/);
    for (const t of f.topics) for (const q of t.items || []) {
      expect(html).toContain(`<details id="${t.id}-${q.id}"`);
      expect(html).toContain(`data-link="https://ceylonhop.com/sri-lanka-travel-faq/#${t.id}-${q.id}"`);
    }
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('callouts use only the two kinds, with the guides\' labels', () => {
    expect(html).toContain('<div class="tip warn"><b>Good to know</b>');
    expect(html).toContain('<div class="tip"><b>Our tip</b>');
    expect(html).not.toMatch(/<b>(Careful|From our drivers)<\/b>/);
  });
  it('"checked" renders only where the JSON has it, with the long date', () => {
    const dated = f.topics.flatMap(t => (t.items || []).filter(q => q.checked)).length + f.topics.filter(t => t.checked).length;
    expect(html.match(/<span class="chk">/g)).toHaveLength(dated);
    expect(html).toContain('<span class="chk">Rules checked 9 October 2026</span>');
    expect(section(html, 'money')).toContain('Rate checked 9 October 2026');
    expect(section(html, 'culture')).not.toContain('Poya checked');
  });
  it('resolves every {fare:…} token from the catalogue and leaves none behind', () => {
    expect(html).not.toContain('{fare:');
    const shared = T.sharedOption('cmb-airport', 'sigiriya').seat;
    expect(section(html, 'money')).toContain(`Colombo Airport to Sigiriya is $${shared.toFixed(2)} a seat`);
    expect(section(html, 'money')).toContain(`start around $${T.privateQuote('galle', 'mirissa').car}`);
    expect(() => resolveFares('{fare:kandy:nowhere:private}', T)).toThrow(/nowhere/);
    expect(() => resolveFares('{fare:kandy:galle:shared}', T)).toThrow(/no shared/);
  });
  it('offer rows reuse the guides\' .ch-row and point where the JSON says', () => {
    const around = section(html, 'around');
    expect(around).toContain('<a class="ch-row" href="../search.html?from=kandy&amp;to=nuwara-eliya">');
    expect(around).toContain('<span class="arr">See price &amp; book →</span>');
    const start = section(html, 'start');
    expect(start).toMatch(/<a class="ch-row" href="https:\/\/wa\.me\/94779669662\?text=[^"]*limited%20mobility/);
    expect(html.match(/<a class="ch-row"/g).length).toBe(f.topics.flatMap(t => (t.items || []).filter(q => q.offer)).length);
  });
  it('comparison topics are answer-first: photo, pick box, then text-only cards', () => {
    const s = section(html, 'safaris');
    const photo = s.indexOf('img/faq/safaris-900.jpg'), pick = s.indexOf('<div class="pick">'), cards = s.indexOf('<div class="cmp">');
    expect(photo).toBeGreaterThan(-1);
    expect(pick).toBeGreaterThan(photo);
    expect(cards).toBeGreaterThan(pick);
    expect(s.match(/<div class="cc">/g)).toHaveLength(4);
    expect(s.slice(cards)).not.toContain('<img');
    expect(s).toContain('<dt>Crowds</dt>');
    expect(s).toContain('href="../guides/sigiriya/"');
    expect(section(html, 'beaches')).toContain('href="../guides/mirissa/"');
  });
  it('the band and pill are present; the band is the only generic WhatsApp prompt', () => {
    expect(html).toContain('<h2>Still wondering?</h2>');
    expect(html).toContain(`text=${encodeURIComponent(f.ask.wa)}`);
    expect(html).toContain('<a class="pill" id="pill" href="#topics">');
    expect(html).toContain('faq-page.js?v=');
  });
  it('every relative href/src resolves to a file in the repo', () => {
    const refs = [...html.matchAll(/\b(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)].map(m => m[1])
      .filter(u => !/^(https?:|mailto:|tel:|javascript:)/.test(u));
    expect(refs.length).toBeGreaterThan(20);
    for (const u of refs) {
      const abs = path.resolve(path.join(ROOT, FAQ_PATH), u.split('?')[0]);
      expect(existsSync(abs) || existsSync(path.join(abs, 'index.html')), `${u} → ${abs}`).toBe(true);
    }
  });
  it('is in the sitemap', () => {
    expect(generateAll().get('sitemap.xml')).toContain('<loc>https://ceylonhop.com/sri-lanka-travel-faq/</loc>');
  });
  it('the committed page equals the generator output (run npm run generate if this fails)', () => {
    expect(readFileSync(path.join(ROOT, REL), 'utf8')).toBe(html);
  });
  it('a topic with no items is neither rendered nor indexed', () => {
    const g = structuredClone(f);
    g.topics[1].items = [];
    const h = renderFaq(g, T);
    expect(h).not.toContain('<section class="topic" id="before"');
    expect(h).not.toContain('href="#before"');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd $SCRATCHPAD/wt-faq/web-tests && npx vitest run unit/faq-page.test.js`
Expected: FAIL — `Cannot find module '../../tools/generate-faq.mjs'`.

- [ ] **Step 3: Write the generator**

Create `tools/generate-faq.mjs`:

```js
// tools/generate-faq.mjs
// The Sri Lanka travel FAQ: one JSON (tools/faq/sri-lanka.json) → one page at
// sri-lanka-travel-faq/index.html. Design: docs/superpowers/specs/2026-10-14-sri-lanka-travel-faq-design.md
//
// A reference, not an article: topics in trip-timeline order, Q&A accordions and answer-first
// comparison sections, a stable anchor per question (the team pastes them into WhatsApp replies),
// "checked" lines only on dated facts, and Ceylon Hop fares only as {fare:from:to:service} tokens
// resolved from transfers-data.js at build time — never typed by hand.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { renderStandalone, ORIGIN } from './render-page.mjs';
import { ROOT } from './generate-route-pages.mjs';
import { loadTransfers } from './load-transfers.mjs';
import { assetV, WA } from './site-chrome.mjs';

export const FAQ_FILE = join(ROOT, 'tools/faq/sri-lanka.json');
export const FAQ_PATH = 'sri-lanka-travel-faq/';
export function loadFaq() { return JSON.parse(readFileSync(FAQ_FILE, 'utf8')); }

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const stripTags = s => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const price = n => Number.isInteger(n) ? String(n) : n.toFixed(2);
const wa = text => `${WA}?text=${encodeURIComponent(text)}`;
const pad = n => String(n).padStart(2, '0');
const longDate = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const title = k => k.charAt(0).toUpperCase() + k.slice(1);

const CAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 17h14M5 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM23 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM3 17l2-7h14l2 7M7 10V7a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v3"/></svg>';
const LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>';
const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

/** {fare:<from>:<to>:shared} → the seat price; {fare:<from>:<to>:private} → the car price. Throws
    rather than ship a wrong number: an unknown place or a corridor with no shared product is a
    content error, not a rendering choice. */
export function resolveFares(html, T) {
  return String(html).replace(/\{fare:([a-z0-9-]+):([a-z0-9-]+):(shared|private)\}/g, (_, from, to, service) => {
    for (const id of [from, to]) if (!T.byId[id]) throw new Error(`faq: {fare:${from}:${to}:${service}} — unknown place "${id}"`);
    if (service === 'shared') {
      const s = T.sharedOption(from, to);
      if (!s) throw new Error(`faq: {fare:${from}:${to}:shared} — no shared product on that leg`);
      return `$${price(s.seat)}`;
    }
    return `$${price(T.privateQuote(from, to).car)}`;
  });
}

/** A page photo at both sizes. `key` is a stem in img/faq/; meta comes from f.photos. */
function fimg(f, key, { p, sizes, eager = false }) {
  const ph = f.photos[key];
  if (!ph) throw new Error(`faq: photos missing "${key}"`);
  const base = `${p}img/faq/${key}`;
  return `<img src="${base}-900.jpg" srcset="${base}-900.jpg 900w, ${base}-1800.jpg 1800w" sizes="${sizes}" `
    + `width="${ph.w}" height="${ph.h}" alt="${esc(ph.alt)}" style="object-position:${esc(ph.focal || '50% 50%')}" `
    + (eager ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"') + '>';
}

const live = f => f.topics.filter(t => t.shape === 'compare' ? t.cards && t.cards.length : t.items && t.items.length);
const answerCount = f => live(f).reduce((n, t) => n + (t.shape === 'qa' ? t.items.length : 1), 0);
const topicCount = t => t.count || (t.shape === 'qa' ? String(t.items.length) : String(t.cards.length));

function banner(f, p) {
  return `<section class="f-hero">
    ${fimg(f, f.hero.photo, { p, sizes: '100vw', eager: true })}
    <div class="wrap">
      <nav class="breadcrumbs on-dark" aria-label="Breadcrumb"><a href="${p}index.html">Home</a><svg class="bc-sep" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg><a href="${p}blog.html">Travel Guide</a><svg class="bc-sep" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg><span class="bc-cur" aria-current="page">Travel FAQ</span></nav>
      <div class="eyebrow">Ceylon Hop · Travel FAQ</div>
      <h1>Sri Lanka travel FAQ</h1>
      <p class="f-meta">${answerCount(f)} answers · Updated ${longDate(f.updated)}</p>
    </div>
  </section>`;
}

const lede = f => `<section class="f-lede"><div class="wrap reveal"><p class="lede">${esc(f.lede)}</p><span class="hand">— the Ceylon Hop team</span></div></section>`;

function index(f) {
  return `<aside class="f-index" id="topics">
        <div class="k">Topics</div>
        <ol class="idx">${live(f).map((t, i) => `
          <li><a href="#${t.id}"><span class="n">${pad(i + 1)}</span>${esc(t.name)}<span class="c">${esc(topicCount(t))}</span></a></li>`).join('')}
        </ol>
      </aside>`;
}

const tip = t => t ? `<div class="tip${t.kind === 'know' ? ' warn' : ''}"><b>${t.kind === 'know' ? 'Good to know' : 'Our tip'}</b>${t.text}</div>` : '';
const offer = (o, p) => o ? `<a class="ch-row" href="${o.wa ? wa(o.wa) : esc(o.href.replace(/^\.\.\//, p))}"><span class="ic">${CAR}</span><span><b>${esc(o.title)}</b><small>${esc(o.sub)}</small></span><span class="arr">${esc(o.label)} →</span></a>` : '';
const checked = c => c ? `<span class="chk">${esc(c.what)} checked ${longDate(c.date)}</span>` : '';
const foot = (anchor, c) => `<div class="foot">${checked(c)}<button type="button" class="cl" data-link="${ORIGIN}/${FAQ_PATH}#${anchor}">${LINK}<span>Copy link</span></button></div>`;

const head = (i, t) => `<div class="th"><span class="n">${pad(i + 1)}</span><div><h2>${esc(t.name)}</h2><p>${esc(t.sub)}</p></div></div>`;

function qaTopic(t, i, p, first) {
  const items = t.items.map((q, j) => {
    const anchor = `${t.id}-${q.id}`;
    return `<details id="${anchor}"${first && j === 0 ? ' open' : ''}><summary>${esc(q.q)}</summary><div class="dc"><div class="ans">${q.a}${tip(q.tip)}${offer(q.offer, p)}${foot(anchor, q.checked)}</div></div></details>`;
  }).join('\n        ');
  return `<section class="topic" id="${t.id}">
        ${head(i, t)}
        ${items}
      </section>`;
}

function compareTopic(t, i, p, f) {
  const pick = `<div class="pick"><h3>${esc(t.pick.q)}</h3><ul>${t.pick.items.map(x => `<li><b>${esc(x.label)}:</b> ${x.text}</li>`).join('')}</ul></div>`;
  const cards = `<div class="cmp">${t.cards.map(c => `<div class="cc"><h3>${esc(c.name)}</h3><p class="bf"><b>Best for</b> ${c.bestFor}</p><dl class="spec">${Object.entries(c.spec || {}).map(([k, v]) => `<dt>${esc(title(k))}</dt><dd>${v}</dd>`).join('')}</dl>${c.link ? `<a class="lnk" href="${p}${esc(c.link.href)}">${c.link.text}</a>` : ''}</div>`).join('')}</div>`;
  const notes = t.notes && t.notes.length ? `<ul class="notes">${t.notes.map(n => `<li>${n}</li>`).join('')}</ul>` : '';
  return `<section class="topic" id="${t.id}">
        ${head(i, t)}
        <figure class="secimg">${fimg(f, t.photo, { p, sizes: '(max-width:900px) 100vw, 46rem' })}<figcaption>Photo: ${esc(f.photos[t.photo].credit)} / Unsplash</figcaption></figure>
        ${pick}
        ${cards}
        ${notes}${tip(t.tip)}
        ${foot(t.id, t.checked)}
      </section>`;
}

function askBand(f) {
  return `<section class="section-tight ask"><div class="wrap">
    <div class="reveal"><div class="eyebrow">Ask us</div><h2>Still wondering?</h2><p>This page grows from what you ask. Message us and we'll answer — and probably add it here.</p></div>
    <a class="wa reveal" href="${wa(f.ask.wa)}"><i></i>Ask on WhatsApp</a>
  </div></section>`;
}

function credits(f, p) {
  const names = [...new Set(Object.values(f.photos).map(x => x.credit))];
  return `<div class="credits"><div class="wrap"><span>Photos:</span>${names.map(n => `<span>${esc(n)}</span>`).join('')}<span>— on Unsplash · <a href="${p}credits.html">all credits</a></span></div></div>`;
}

function jsonLd(f, url) {
  const items = live(f).flatMap(t => t.shape === 'qa'
    ? t.items.map(q => ({ '@type': 'Question', name: q.q, acceptedAnswer: { '@type': 'Answer', text: stripTags(q.a) } }))
    : [{ '@type': 'Question', name: t.pick.q, acceptedAnswer: { '@type': 'Answer', text: t.pick.items.map(x => `${x.label}: ${stripTags(x.text)}`).join(' ') } }]);
  return [
    { '@context': 'https://schema.org', '@type': 'Article', headline: 'Sri Lanka travel FAQ', description: f.description,
      author: { '@type': 'Organization', name: 'Ceylon Hop', url: `${ORIGIN}/` },
      publisher: { '@type': 'Organization', name: 'Ceylon Hop', url: `${ORIGIN}/` },
      dateModified: f.updated, mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      image: `${ORIGIN}/img/faq/${f.hero.photo}-1800.jpg`, inLanguage: 'en' },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
      { '@type': 'ListItem', position: 2, name: 'Travel Guide', item: `${ORIGIN}/blog.html` },
      { '@type': 'ListItem', position: 3, name: 'Sri Lanka travel FAQ', item: url } ] },
  ].map(o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n');
}

export function renderFaq(f, T) {
  const p = '../';
  const url = `${ORIGIN}/${FAQ_PATH}`;
  const topics = live(f).map((t, i) => t.shape === 'qa' ? qaTopic(t, i, p, i === 0) : compareTopic(t, i, p, f)).join('\n\n      ');
  const body = `<script>document.documentElement.classList.add('js');</script>
${jsonLd(f, url)}
  ${banner(f, p)}
  ${lede(f)}
  <div class="f-cols"><div class="wrap">
      ${index(f)}
      <div class="f-main">
      ${topics}
      </div>
  </div></div>
  ${askBand(f)}
  ${credits(f, p)}
  <a class="pill" id="pill" href="#topics">${CHEV}Topics</a>
<script src="${p}${assetV('faq-page.js')}"></script>`;
  return renderStandalone({
    title: f.title, description: f.description, canonicalPath: `/${FAQ_PATH}`, depth: 1, active: 'blog.html',
    ogImage: 'img/faq/og.jpg', style: FAQ_STYLE, bodyHtml: resolveFares(body, T),
  });
}

export function generateFaq() {
  return new Map([[`${FAQ_PATH}index.html`, renderFaq(loadFaq(), loadTransfers())]]);
}

// Tokens (--blue, --paper, --display, …) come from site.css. The 900px breakpoint is the page's
// own (spec §10); the two-column reference layout needs more room than the site's 759px phone cut.
const FAQ_STYLE = `
  .f-hero{position:relative;color:#fff;padding:104px 0 28px;margin-top:-74px;min-height:230px;display:flex;align-items:flex-end;overflow:hidden;isolation:isolate}
  .f-hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-2}
  .f-hero::before{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(13,51,64,.25) 0%,rgba(13,51,64,.78) 100%)}
  .f-hero .wrap{width:100%}
  .f-hero .breadcrumbs{padding-top:0;margin-bottom:12px}
  .f-hero .eyebrow{color:var(--saffron)}.f-hero .eyebrow::before{background:var(--saffron)}
  .f-hero h1{color:#fff;margin:.45rem 0 .3rem;font-size:clamp(2rem,4.4vw,2.9rem);line-height:1.1}
  .f-meta{margin:0;font-size:.82rem;color:rgba(255,255,255,.88)}
  .f-lede{padding:clamp(22px,3vw,34px) 0 0}
  .lede{font-family:var(--hand);font-weight:600;font-size:clamp(1.3rem,2.4vw,1.6rem);line-height:1.3;max-width:34rem;margin:0}
  .hand{font-family:var(--body);color:var(--ink-soft);font-size:.82rem;display:block;margin-top:6px}
  html.js .reveal{opacity:0;transform:translateY(22px);transition:opacity .7s ease,transform .7s cubic-bezier(.2,.7,.2,1)}
  html.js .reveal.in{opacity:1;transform:none}
  .f-cols{padding:8px 0 10px}
  .f-index .k{font-weight:600;font-size:.66rem;letter-spacing:.2em;text-transform:uppercase;color:var(--ink-soft);margin:18px 0 4px}
  .idx{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
  .idx li{border-bottom:1px solid var(--line)}
  .idx a{display:flex;align-items:center;gap:12px;padding:11px 0;font-weight:500;font-size:.92rem;color:inherit;text-decoration:none}
  .idx .n{font-family:var(--display);font-weight:700;font-size:.85rem;color:var(--accent-deep);width:22px}
  .idx .c{margin-left:auto;font-size:.72rem;color:var(--ink-soft);font-weight:400}
  .idx li.on a{color:var(--accent-deep);font-weight:600}
  .topic{padding:34px 0 10px;scroll-margin-top:84px}
  .th{display:flex;gap:12px;align-items:baseline;margin-bottom:8px}
  .th .n{font-family:var(--display);font-weight:700;font-size:1rem;color:var(--accent-deep)}
  .th h2{margin:0 0 4px;line-height:1.15}
  .th p{margin:0;color:var(--ink-soft);font-size:.92rem}
  .topic details{border-top:1px solid var(--line)}
  .topic details:last-of-type{border-bottom:1px solid var(--line)}
  .topic summary{cursor:pointer;list-style:none;font-weight:600;font-size:1rem;line-height:1.45;padding:15px 34px 15px 0;position:relative}
  .topic summary::-webkit-details-marker{display:none}
  .topic summary::after{content:"";position:absolute;right:4px;top:21px;width:12px;height:12px;border-right:2px solid var(--accent-deep);border-bottom:2px solid var(--accent-deep);transform:rotate(45deg);transition:transform .3s}
  .topic details[open] summary::after{transform:rotate(225deg);top:26px}
  .dc{display:grid;grid-template-rows:0fr;transition:grid-template-rows .35s cubic-bezier(.2,.7,.2,1)}
  details[open] .dc{grid-template-rows:1fr}
  .dc>div{overflow:hidden}
  .ans{padding:0 0 16px}
  .ans p,.ans ul,.ans ol{margin:0 0 12px;font-size:.97rem;line-height:1.65;color:var(--ink-soft)}
  .ans ul,.ans ol{padding-left:20px}.ans li{margin-bottom:4px}
  .ans b{color:var(--ink);font-weight:600}
  .ans a{color:var(--accent-deep)}
  .tip{margin:4px 0 12px;background:var(--pc-saffron);border-radius:14px;padding:12px 14px 12px 18px;font-size:.95rem;line-height:1.6;position:relative;color:var(--ink)}
  .tip::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:4px;border-radius:4px;background:var(--saffron)}
  .tip b{display:block;font-family:var(--hand);font-weight:600;font-size:1.05rem;color:#8a5000;margin-bottom:.1rem}
  .tip.warn{background:#fdeeec}.tip.warn::before{background:var(--tomato)}.tip.warn b{color:#a3210f}
  .ch-row{display:grid;grid-template-columns:auto 1fr;gap:12px;align-items:center;margin:4px 0 12px;padding:12px 14px;border:1.5px solid var(--line);border-radius:14px;text-decoration:none;color:inherit;transition:border-color .2s}
  .ch-row:hover{border-color:var(--accent)}
  .ch-row .ic{width:36px;height:36px;border-radius:12px;background:var(--pc-saffron);color:#8a5000;display:grid;place-items:center}
  .ch-row .ic svg{width:19px;height:19px}
  .ch-row b{display:block;font-weight:600;font-size:.94rem;line-height:1.3}
  .ch-row small{display:block;font-size:.8rem;color:var(--ink-soft);line-height:1.4}
  .ch-row .arr{grid-column:2;font-weight:600;font-size:.86rem;color:var(--accent-deep);white-space:nowrap}
  .foot{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:.74rem;color:#9a968d;margin-top:2px}
  .chk{color:#8a5000}
  .cl{margin-left:auto;display:inline-flex;align-items:center;gap:5px;font:inherit;font-weight:600;color:var(--accent-deep);background:none;border:0;padding:4px 0;cursor:pointer}
  .cl svg{width:13px;height:13px}
  .cl.done{color:var(--teal-deep)}
  .secimg{margin:12px 0 14px;border-radius:18px;overflow:hidden;position:relative}
  .secimg img{display:block;width:100%;height:auto;aspect-ratio:2/1;object-fit:cover}
  .secimg figcaption{position:absolute;right:10px;bottom:8px;color:#fff;font-size:.64rem;opacity:.85}
  .pick{background:var(--cream);border-radius:16px;padding:14px 16px;margin:0 0 14px}
  .pick h3{margin:0 0 8px;font-family:var(--body);font-weight:600;font-size:.98rem}
  .pick ul{margin:0;padding-left:18px;font-size:.92rem;line-height:1.55;color:var(--ink-soft)}
  .pick li{margin-bottom:3px}.pick b{color:var(--ink);font-weight:600}
  .cmp{display:grid;gap:10px;margin:0 0 12px}
  .cc{background:#fff;border:1px solid var(--line);border-radius:16px;padding:12px 14px 13px}
  .cc h3{margin:0 0 2px;font-size:1.15rem}
  .cc .bf{font-size:.88rem;margin:0 0 8px;line-height:1.5}.cc .bf b{color:var(--accent-deep);font-weight:600}
  .spec{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:.82rem;line-height:1.5;margin:0}
  .spec dt{color:var(--ink-soft);font-weight:500}.spec dd{margin:0}
  .cc .lnk{display:inline-block;margin-top:8px;font-size:.82rem;font-weight:600;color:var(--accent-deep);text-decoration:none}
  .notes{margin:0 0 12px;padding-left:20px;font-size:.92rem;line-height:1.6;color:var(--ink-soft)}
  .ask{background:var(--btn-accent);color:#fff;text-align:center;margin-top:30px}
  .ask .wrap{display:grid;gap:18px;justify-items:center}
  .ask .eyebrow{color:#fff;opacity:.85}.ask .eyebrow::before{background:#fff}
  .ask h2{color:#fff;margin:0 0 .4rem;line-height:1.08}
  .ask p{margin:0;color:rgba(255,255,255,.88);max-width:34rem;font-size:1rem}
  .wa{display:inline-flex;align-items:center;gap:.6rem;background:#fff;color:var(--ink);font-weight:600;border-radius:999px;padding:.85rem 1.3rem;text-decoration:none;white-space:nowrap;box-shadow:0 14px 30px -14px rgba(0,0,0,.35)}
  .wa i{width:22px;height:22px;border-radius:50%;background:#0B7A44;display:inline-block}
  .credits{padding:20px 0 30px;font-size:.74rem;color:var(--ink-soft)}
  .credits .wrap{display:flex;flex-wrap:wrap;gap:6px 14px}
  .pill{position:fixed;left:50%;bottom:18px;transform:translate(-50%,24px);opacity:0;pointer-events:none;z-index:40;display:inline-flex;align-items:center;gap:6px;background:var(--ink);color:#fff;border-radius:999px;padding:9px 16px;font-size:.82rem;font-weight:600;text-decoration:none;box-shadow:0 8px 24px rgba(0,0,0,.25);transition:opacity .25s,transform .25s}
  .pill svg{width:12px;height:12px;transform:rotate(-90deg)}
  .pill.on{opacity:1;transform:translate(-50%,0);pointer-events:auto}
  @media(min-width:900px){
    .f-cols .wrap{display:grid;grid-template-columns:250px minmax(0,1fr);gap:56px;align-items:start}
    .f-index{position:sticky;top:90px}
    .f-index .k{margin-top:34px}
    .idx a{padding:9px 0;font-size:.88rem}
    .idx .n{display:none}
    .idx li.on a::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--saffron);margin-right:-4px}
    .f-main{max-width:46rem}
    .cmp{grid-template-columns:1fr 1fr}
    .pill{display:none}
  }
  @media(prefers-reduced-motion:reduce){
    html.js .reveal{opacity:1;transform:none;transition:none}
    .dc,.pill{transition:none}
  }`;

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [rel, html] of generateFaq()) {
    const abs = join(ROOT, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, html);
  }
  console.log('generated the travel FAQ');
}
```

- [ ] **Step 4: Write the page script**

Create `faq-page.js`:

```js
/* ============================================================
   CEYLON HOP — travel FAQ page
   ============================================================
   Five small behaviours, no dependencies, classic script:
     1. reveal-on-scroll (the site's initReveal(), same timing)
     2. deep link: #<topic>-<item> opens that question on load
     3. copy link: writes the absolute URL, sets the hash without scrolling
     4. scroll-spy: marks the current topic in the index (desktop column)
     5. Topics pill: shows once the index has scrolled off, jumps back to it
   Every animation is CSS; this file only toggles classes. Reduced motion is honoured by
   the stylesheet and by the scroll behaviour below.
   ============================================================ */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var behavior = reduce ? 'auto' : 'smooth';

  // 1. Reveal
  var els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) { els.forEach(function (e) { e.classList.add('in'); }); }
  else {
    var io = new IntersectionObserver(function (ents) {
      ents.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: .12, rootMargin: '0px 0px -8% 0px' });
    els.forEach(function (e) { io.observe(e); });
  }

  // 2. Deep link
  function openHash() {
    var id = location.hash.slice(1);
    if (!id) return;
    var t = document.getElementById(id);
    if (!t) return;
    if (t.tagName === 'DETAILS') t.open = true;
    t.scrollIntoView({ block: 'start', behavior: behavior });
  }
  openHash();
  window.addEventListener('hashchange', openHash);

  // 3. Copy link
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); } catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('button.cl'), function (b) {
    b.setAttribute('aria-live', 'polite');
    b.addEventListener('click', function () {
      var url = b.getAttribute('data-link');
      var label = b.querySelector('span');
      copy(url).then(function () {
        history.replaceState(null, '', '#' + url.split('#')[1]);
        b.classList.add('done'); label.textContent = 'Copied';
        setTimeout(function () { b.classList.remove('done'); label.textContent = 'Copy link'; }, 1500);
      }, function () { label.textContent = 'Press ⌘C'; });
    });
  });

  // 4. Scroll-spy
  var index = document.getElementById('topics');
  var links = index ? Array.prototype.slice.call(index.querySelectorAll('a[href^="#"]')) : [];
  function light(id) {
    links.forEach(function (a) { a.parentNode.classList.toggle('on', a.getAttribute('href') === '#' + id); });
  }
  if (links.length && 'IntersectionObserver' in window) {
    var spy = new IntersectionObserver(function (ents) {
      ents.forEach(function (e) { if (e.isIntersecting) light(e.target.id); });
    }, { rootMargin: '-30% 0px -60% 0px', threshold: 0 });
    links.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); })
      .filter(Boolean).forEach(function (s) { spy.observe(s); });
  }

  // 5. Topics pill
  var pill = document.getElementById('pill');
  if (pill && index && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (ents) {
      var e = ents[0];
      pill.classList.toggle('on', !e.isIntersecting && e.boundingClientRect.top < 0);
    }, { threshold: 0 }).observe(index);
    pill.addEventListener('click', function (ev) {
      ev.preventDefault();
      index.scrollIntoView({ block: 'start', behavior: behavior });
    });
  }
})();
```

- [ ] **Step 5: Wire the generator and the sitemap**

In `tools/generate-static-pages.mjs`, after `import { generateGuides } from './generate-guides.mjs';` add:

```js
import { generateFaq } from './generate-faq.mjs';
```

and in `generateStaticPages()`, after the `for (const [rel, html] of generateGuides()) out.set(rel, html);` line add:

```js
  // The Sri Lanka travel FAQ (tools/faq/sri-lanka.json → sri-lanka-travel-faq/index.html).
  for (const [rel, html] of generateFaq()) out.set(rel, html);
```

In `tools/generate-route-pages.mjs`, in `SITEMAP_EXTRA`, after the last `'guides/…/'` entry add:

```js
  'sri-lanka-travel-faq/',
```

- [ ] **Step 6: Generate the page and run the test**

```bash
cd $SCRATCHPAD/wt-faq && node tools/generate-faq.mjs && npm run generate && npm run stamp && git status --short
cd web-tests && npx vitest run unit/faq-page.test.js unit/faq-content.test.js unit/seo-codegen.test.js unit/static-chrome-crawlable.test.js
```

Expected: `generated the travel FAQ`; `git status` shows `sri-lanka-travel-faq/index.html` (new) plus the modified generator/wiring files and possibly `sitemap.xml`; all four test files PASS. If `faq-page.test.js` fails on "committed page equals generator output", run `npm run generate && npm run stamp` again — `assetV('faq-page.js')` changes if the script changed after the page was generated.

- [ ] **Step 7: Look at it**

```bash
cd $SCRATCHPAD/wt-faq && npx --yes serve -l 4173 . >/dev/null 2>&1 &
```

Open `http://localhost:4173/sri-lanka-travel-faq/` in the browser pane at 390px and 1180px. Check: banner photo (tea hills, no vehicles), index, first answer open, saffron "Our tip" + red "Good to know", offer row in Getting around, safari section photo → pick box → four text cards (two-up on desktop), band, pill appears after scrolling past the index on the phone width. Fix anything that's wrong in `FAQ_STYLE`, regenerate, re-run the tests. Stop the server afterwards.

- [ ] **Step 8: Commit**

```bash
cd $SCRATCHPAD/wt-faq
git add tools/generate-faq.mjs faq-page.js tools/generate-static-pages.mjs tools/generate-route-pages.mjs sri-lanka-travel-faq/index.html sitemap.xml web-tests/unit/faq-page.test.js
git status --short   # anything else changed by stamp/generate belongs to this commit too — add it by path
git commit -m "feat(faq): generate /sri-lanka-travel-faq/ from the FAQ JSON

tools/generate-faq.mjs renders the reference page through
renderStandalone(): banner, handwritten lede, numbered topic index
(sticky column on desktop), Q&A accordions with stable anchors and a
copy-link button, answer-first comparison sections, 'checked' lines
only on dated facts, and {fare:…} tokens resolved from the catalogue.
faq-page.js adds deep links, copy-link, scroll-spy and the Topics pill.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Blog hub card

**Files:**
- Modify: `blog.html` (insert before `<!-- Destination guides: generated from tools/guides/<slug>.json …`)
- Test: `web-tests/unit/faq-page.test.js` (one more `it`)

**Interfaces:**
- Consumes: `img/faq/hero-900.jpg` (Task 1), `sri-lanka-travel-faq/` (Task 2).

- [ ] **Step 1: Add the failing test**

Append inside the `describe('generateFaq', …)` block in `web-tests/unit/faq-page.test.js`:

```js
  it('blog.html links the FAQ in static HTML (crawlable without JS), above the destination guides', () => {
    const blog = readFileSync(path.join(ROOT, 'blog.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
    expect(blog).toContain('href="sri-lanka-travel-faq/"');
    expect(blog).toContain('src="img/faq/hero-900.jpg"');
    expect(blog).toContain('Know before you go');
    expect(blog.indexOf('id="know"')).toBeLessThan(blog.indexOf('id="guides"'));
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd $SCRATCHPAD/wt-faq/web-tests && npx vitest run unit/faq-page.test.js -t "blog.html"`
Expected: FAIL — `expected … to contain 'href="sri-lanka-travel-faq/"'`.

- [ ] **Step 3: Add the block to `blog.html`**

Immediately before the line `    <!-- Destination guides: generated from tools/guides/<slug>.json by tools/generate-guides.mjs.` insert:

```html
    <!-- Travel FAQ: generated from tools/faq/sri-lanka.json by tools/generate-faq.mjs.
         Static HTML on purpose — crawlable without JS, like the guides block below. -->
    <div id="know" style="margin-top:48px">
      <span class="eyebrow">Know before you go</span>
      <h2 style="margin:.3rem 0 .8rem">The questions everyone asks us, answered</h2>
      <div class="grid cols-3">
        <a class="bcard" href="sri-lanka-travel-faq/">
          <img src="img/faq/hero-900.jpg" alt="Tea fields on a misty hillside near Nuwara Eliya" width="1800" height="1013" style="display:block;width:100%;height:auto;aspect-ratio:16/10;object-fit:cover;border-radius:16px" loading="lazy" decoding="async">
          <div class="meta" style="margin-top:14px">Reference &middot; Whole island</div>
          <h3>Sri Lanka travel FAQ</h3>
          <p>Visas, money and ATMs, trains and buses, which safari and which beach, leeches &mdash; the questions people ask us most, kept current by the team.</p>
          <span class="more">Read the answers &rarr;</span>
        </a>
      </div>
    </div>

```

(Match the `<img … style="…">` attribute string exactly to the guide cards already in the file so the card looks identical — copy the full attribute list from the Nuwara Eliya card, changing only `src`, `alt`, `width`, `height`.)

- [ ] **Step 4: Stamp, run the test, see it pass**

```bash
cd $SCRATCHPAD/wt-faq && npm run stamp && cd web-tests && npx vitest run unit/faq-page.test.js unit/static-chrome-crawlable.test.js
```

Expected: PASS; `git status --short` shows `blog.html` only (stamping a page with unchanged assets rewrites nothing).

- [ ] **Step 5: Commit**

```bash
cd $SCRATCHPAD/wt-faq && git add blog.html web-tests/unit/faq-page.test.js
git commit -m "feat(blog): 'Know before you go' card for the travel FAQ

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: End-to-end spec, full gate, PR

**Files:**
- Create: `web-tests/e2e/faq-page.spec.js`

**Interfaces:**
- Consumes: the generated page's markup contract from Task 2 (`#topics a`, `details#<id>`, `button.cl`, `#pill`, `.idx li.on`).

- [ ] **Step 1: Write the e2e spec**

Create `web-tests/e2e/faq-page.spec.js`:

```js
// The travel FAQ in a real browser, offline (spec 2026-10-14-sri-lanka-travel-faq-design.md §9, §12).
import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

const URL = '/sri-lanka-travel-faq/';

test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

test('renders with the site chrome, the first answer open and nothing else', async ({ page }) => {
  await page.goto(URL);
  await expect(page).toHaveTitle(/Sri Lanka travel FAQ/);
  await expect(page.locator('h1')).toHaveText('Sri Lanka travel FAQ');
  await expect(page.locator('header.nav a', { hasText: 'Routes & prices' })).toHaveAttribute('href', '../trip/');
  await expect(page.locator('details[open]')).toHaveCount(1);
  await expect(page.locator('details#visa-how-to-get')).toHaveAttribute('open', '');
});

test('an index entry scrolls to its topic; a closed question opens on click', async ({ page }) => {
  await page.goto(URL);
  await page.locator('#topics a[href="#money"]').click();
  await expect.poll(() => page.locator('#money').evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(200);
  const q = page.locator('details#money-tipping');
  await q.locator('summary').click();
  await expect(q).toHaveAttribute('open', '');
  await expect(q.locator('.ans')).toContainText('Not mandatory');
});

test('a deep link opens that question', async ({ page }) => {
  await page.goto(`${URL}#visa-extend`);
  await expect(page.locator('details#visa-extend')).toHaveAttribute('open', '');
  await expect.poll(() => page.locator('#visa-extend').evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(300);
});

test('Copy link puts the absolute URL on the clipboard and sets the hash', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are Chromium-only in Playwright');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(URL);
  const btn = page.locator('details#visa-how-to-get button.cl');
  await btn.click();
  await expect(btn).toHaveText(/Copied/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://ceylonhop.com/sri-lanka-travel-faq/#visa-how-to-get');
  expect(new URL(page.url()).hash).toBe('#visa-how-to-get');
});

test('on a phone the Topics pill appears after the index scrolls off, and returns to it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(URL);
  const pill = page.locator('#pill');
  await expect(pill).not.toHaveClass(/on/);
  await page.locator('#health').scrollIntoViewIfNeeded();
  await expect(pill).toHaveClass(/on/);
  await pill.click();
  await expect.poll(() => page.locator('#topics').evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(120);
  await expect(pill).not.toHaveClass(/on/);
});

test('on desktop the index is a sticky column that marks the topic in view', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto(URL);
  expect(await page.locator('#topics').evaluate(el => getComputedStyle(el).position)).toBe('sticky');
  await expect(page.locator('#pill')).toBeHidden();
  await page.locator('#safaris').scrollIntoViewIfNeeded();
  await expect(page.locator('#topics li.on a')).toHaveAttribute('href', '#safaris');
});
```

- [ ] **Step 2: Run it**

Run: `cd $SCRATCHPAD/wt-faq/web-tests && npx playwright test e2e/faq-page.spec.js`
Expected: 6 passed. If the scroll-spy assertion flakes, the `rootMargin` in `faq-page.js` section 4 is the knob (the section heading must sit inside the middle 10% band after `scrollIntoViewIfNeeded`); prefer `page.locator('#safaris .th').scrollIntoViewIfNeeded()` over loosening the observer.

- [ ] **Step 3: Full gate**

```bash
cd $SCRATCHPAD/wt-faq && npm run generate && npm run stamp && git status --short   # must be empty
cd web-tests && npm run test:all
```

Expected: `git status --short` prints nothing; vitest and Playwright both end with their own pass summary and exit 0. Check `uptime` first if the machine is loaded (the local gate flakes under load).

- [ ] **Step 4: Commit and open the PR**

```bash
cd $SCRATCHPAD/wt-faq && git add web-tests/e2e/faq-page.spec.js
git commit -m "test(faq): travel FAQ end-to-end — index, deep link, copy link, pill, sticky column

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin feat/travel-faq-spec
gh pr create --base main --title "feat: Sri Lanka travel FAQ — a growing reference page" --body "$(cat <<'EOF'
## What

A new page type: `/sri-lanka-travel-faq/`, a reference (not an article) of the questions customers ask us about Sri Lanka, generated from `tools/faq/sri-lanka.json`. Spec: `docs/superpowers/specs/2026-10-14-sri-lanka-travel-faq-design.md`; plan: `docs/superpowers/plans/2026-10-14-sri-lanka-travel-faq.md`.

- Ten topics in trip-timeline order; Q&A accordions and answer-first comparison sections (safaris, beaches).
- Stable anchor per question + Copy link (`#visa-extend`) for WhatsApp replies.
- "Checked <date>" only on dated facts; page-level "Updated".
- Ceylon Hop fares only as `{fare:from:to:service}` tokens resolved from `transfers-data.js` at build — a test rejects literal fares in the JSON.
- No tuk-tuks or motorcycles in any photo (owner rule 2026-10-14).
- Linked from `blog.html` ("Know before you go"), in the sitemap, FAQPage/Article/BreadcrumbList JSON-LD.

## Content review for the team (spec §11)

Migrated from the Google Doc with: numbering fixed; SIM → Before you fly; Poya → Culture; budget fares tokenised; "MediHelp" dropped (no address); `checked: 2026-10-09` on visa, FX, ATM fees, Kandy–Ella line, metro buses, park seasons, whale season, puja times, hospital list. **Facts were not re-verified** — the dated lines make that visible.

## Tests

- `web-tests/unit/faq-content.test.js`, `faq-page.test.js` (red → green per task)
- `web-tests/e2e/faq-page.spec.js` (6)
- `npm run test:all` green; `npm run generate && npm run stamp` leave no diff.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then bind the PR in the desktop app (`get_status` → `bind_pr` if needed) and read its CI.

---

## Self-review

**Spec coverage.** §3 files/build → Tasks 1–3; §4 anatomy (banner, lede, index, qa/compare shapes, band, pill, photo rule) → Task 2 generator + Task 1 test; §5 schema → Task 1 JSON + content test; §6 fares → `resolveFares` + both tests; §7 links → "every relative href resolves" test + offer/compare href rules; §8 SEO → `jsonLd`, `renderStandalone` canonical/OG, sitemap, blog card; §9 behaviour → `faq-page.js` + e2e; §10 mobile → `FAQ_STYLE` 900px rules + e2e at 390/1180; §11 content edits → Task 1 Step 4; §12 tests → Tasks 1, 2, 4; `ownPage` deliberately not built (§3).

**Placeholders.** None: the JSON is complete, every code step shows the code, every run step names the command and the expected result.

**Type consistency.** `FAQ_PATH`, `loadFaq`, `resolveFares`, `renderFaq(f, T)`, `generateFaq()` are named identically in the generator and both tests. Markup ids/classes used by `faq-page.js` and the e2e (`#topics`, `.idx li.on`, `details#<id>`, `button.cl` with inner `<span>`, `#pill.on`, `.f-index`) match the generator's output. The test's `section()` helper matches `<section class="topic" id="…"` exactly as `qaTopic`/`compareTopic` emit it. Offer hrefs in the JSON are written as `../search.html…` and the generator rewrites the leading `../` to `p` (also `../`), so the test's expected `href="../search.html?from=kandy&amp;to=nuwara-eliya"` holds.
