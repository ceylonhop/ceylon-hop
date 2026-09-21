import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { loadTransfers } from './load-transfers.mjs';
import { loadPlacePhotos, photoFor, imgTag } from './place-photos.mjs';
import { renderChrome, assetV } from './site-chrome.mjs';

const require = createRequire(import.meta.url);
const { formatRouteEstimate } = require('../route-estimate.js');

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://ceylonhop.com';
const OG_IMAGE = `${ORIGIN}/og-cover.jpg`;

// The 22 curated corridors (spec §1). Each generates BOTH directions → 44 pages.
// Content is keyed by this canonical order; the reverse page uses `back` for its intro.
const BASE_PAIRS = [
  ['cmb-airport', 'kandy'], ['cmb-airport', 'sigiriya'], ['cmb-airport', 'galle'], ['cmb-airport', 'mirissa'],
  ['cmb-airport', 'ella'], ['cmb-airport', 'negombo'], ['cmb-airport', 'colombo'], ['negombo', 'sigiriya'],
  ['negombo', 'kandy'], ['colombo', 'kandy'], ['colombo', 'galle'], ['colombo', 'ella'], ['sigiriya', 'kandy'],
  ['kandy', 'ella'], ['kandy', 'nuwara-eliya'], ['nuwara-eliya', 'ella'], ['ella', 'yala'], ['ella', 'arugam-bay'],
  ['ella', 'mirissa'], ['yala', 'mirissa'], ['mirissa', 'galle'], ['galle', 'ella'],
];

// Hubs for the /trip/ index grouping.
const HUBS = [
  { title: 'From Colombo Airport (CMB)', match: k => k.from === 'cmb-airport' },
  { title: 'From Colombo & Negombo', match: k => ['colombo', 'negombo'].includes(k.from) },
  { title: 'Hill country', match: k => ['kandy', 'nuwara-eliya', 'sigiriya'].includes(k.from) },
  { title: 'South coast & east', match: k => ['ella', 'yala', 'mirissa', 'galle', 'arugam-bay'].includes(k.from) },
];

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (a, b) => `${a}-to-${b}`;
const price = n => Number.isInteger(n) ? String(n) : n.toFixed(2);
const lowerFirst = value => value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
const routeEstimate = q => formatRouteEstimate({
  distanceKm: q.km,
  durationMin: q.durationMin,
  state: q.estimated ? 'estimated' : 'browse',
});

/* ── Design A, photo-led: one card, above the fold ────────────────────────────
   docs/superpowers/plans/2026-08-16-unified-route-page.md
   docs/superpowers/specs/2026-09-21-trip-pages-redesign-design.md

   Two options, never three. A shared seat is a DATE WITH NAMES ON IT, so there is
   no "scheduled" product beside a "pooled" one, and no unavailable state — any
   date can run once enough travellers commit.

   What changed in the redesign is WEIGHT, not the offer. The private fares are a
   card inside the photo hero, so the price and the Book button are on the first
   screen; the shared ride is a full section further down where we sell one, and a
   single sentence where we don't (it used to be a grey half-page card giving equal
   billing to the thing we don't sell).

   Emitted as complete static HTML on purpose. These pages exist to be indexed, so
   a crawler must see the prices, the boarding points and the CTAs with no JS at
   all; the runtime layer only refreshes live list rows and handles the date field.
   web-tests/unit/route-page-unified.test.js asserts this against script-stripped
   markup. */
const MIN_SEATS = 3; // domain/rideList.ts policyForCorridor — three names run the van

// The two vehicle marks from the approved prototype. Their canvas is 46×30 rather than the
// line family's 24×24 square: these are wide silhouettes seen side-on, and squeezing them
// into a square would shrink them to a quarter of the tile they have to fill.
const ICON_CAR = '<svg viewBox="0 0 46 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20v-4.5l5-1.5 4.5-6.5h14l6 6.5 6.5 1.5c1.5.4 2 1.3 2 2.5V20h-4"/><path d="M13 20h16"/><circle cx="10" cy="21" r="3.5"/><circle cx="33" cy="21" r="3.5"/><path d="M14.5 13.5h17"/></svg>';
const ICON_VAN = '<svg viewBox="0 0 46 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20V8.5C3 7.1 4.1 6 5.5 6H29l8 8 4 1.5c1 .4 2 1.3 2 2.5v2h-3"/><path d="M13.5 20H30"/><circle cx="10" cy="21" r="3.5"/><circle cx="34" cy="21" r="3.5"/><path d="M8 10.5h7v4H8zM19 10.5h8l4 4H19z"/></svg>';

/** booking.js only reads from/to when `mode` is set; without it the page falls through to
 *  getRoute(id), finds nothing, and location.replace('plan.html')s -- so a CTA missing these
 *  params silently dumps the traveller in the planner. Same contract as search.js's bookUrl:
 *  the display price plus the unfinished fare, so extras are added before the finishing pass. */
function bookHrefFor(from, to, q, p) {
  return `${p}booking.html?${new URLSearchParams({
    from, to, mode: 'private', vehicle: 'car',
    price: String(q.car), rawPrice: String(q.rawCar),
  })}`;
}

/* The fares card. It lives INSIDE the hero and overhangs its bottom edge.
   data-live-fares + data-fare: route-page-fares.js asks the engine for these two figures and
   writes them in (hot zones live in the prod DB, so nothing generated here can know them).
   The catalogue fare stays in the markup — it is what a crawler, a no-JS browser and an
   unreachable API all show. The data-cat- and data-raw- attributes carry the catalogue pair
   so the selection script can rewrite the CTA for whichever vehicle is picked without
   re-deriving prices. */
function faresCard(T, from, to, q, shared, p) {
  const bookHref = bookHrefFor(from, to, q, p);
  // A real radio, not a button: the choice works with JS off, arrow-keys as one group, and
  // reads to a screen reader as what it is. The selection behaviour is a later step.
  const tile = (v, name, cap, fare, checked) => `
          <label class="veh"><input type="radio" name="vehicle" value="${v}"${checked ? ' checked' : ''}>
            <span class="veh-ic" aria-hidden="true">${v === 'car' ? ICON_CAR : ICON_VAN}</span>
            <span class="veh-n">${name}<small>${cap}</small></span>
            <span class="veh-p"><span data-fare="${v}">$${price(fare)}</span><small>total, fixed</small></span></label>`;
  return `<article class="opt opt-private fares" data-live-fares data-from-name="${esc(T.byId[from].name)}" data-to-name="${esc(T.byId[to].name)}"
        data-cat-car="${q.car}" data-cat-van="${q.van}" data-raw-car="${q.rawCar}" data-raw-van="${q.rawVan}">
        <div><p class="fares-kick">Private transfer · door to door</p>
        <h2>Your own car, fixed price</h2></div>
        <fieldset class="veh-set"><legend class="vh">Choose a vehicle</legend>${tile('car', 'AC car', 'up to 3 travellers + bags', q.car, true)}${tile('van', 'AC van', 'up to 6 travellers + bags', q.van, false)}
        </fieldset>
        <a class="btn btn-cta opt-cta" href="${esc(bookHref)}">Choose date &amp; book</a>
        <p class="fares-fine">Free cancellation up to 24h before · no change fees</p>${shared ? `
        <a class="share-strip" href="#share"><span>Or share the van<br><b>$${price(shared.seat)}</b> a seat</span><span>See who's going ↓</span></a>` : ''}
      </article>`;
}

/* The shared ride, where we sell one. The article keeps the class, the copy and the hooks
   today's card has — route-page.js inserts its live date rows immediately before
   [data-shared-cta], so that block must stay inside the card it belongs to. */
function sharedSection(T, from, to, shared, p) {
  if (!shared) return '';
  const stops = shared.pickups
    .map(s => `<li><b>${esc(fmtTime(s.time))}</b> ${esc(s.point || T.byId[from].name)}</li>`)
    .join('');
  return `
  <section class="section trip-share" id="share">
    <div class="wrap share-grid">
      <div class="share-copy">
        <span class="share-tag">Best value · share &amp; save</span>
        <h2>One van, split between you</h2>
        <p class="share-lede">Same driver, same air-conditioned van, same door-to-door care as a private transfer — for a fraction of the fare. Your card is saved when you add your name, and is only charged once the van is confirmed.</p>
      </div>
      <article class="opt opt-shared">
        <div class="seat-price"><b>$${price(shared.seat)}</b> <span>/ seat</span></div>
        <p class="runs-line">Runs once <b>${MIN_SEATS} travellers</b> are going · nothing charged until it's confirmed</p>
        <ul class="pickups">${stops}</ul>
        <div data-shared-cta data-from="${esc(T.byId[from].name)}" data-to="${esc(T.byId[to].name)}" data-min="${MIN_SEATS}">
          <a class="btn btn-cta opt-cta" href="${esc(boardHref(T, from, to, p))}">See who's going &amp; add your name</a>
        </div>
      </article>
    </div>
  </section>`;
}

const boardHref = (T, from, to, p) =>
  `${p}board.html?from=${encodeURIComponent(T.byId[from].name)}&to=${encodeURIComponent(T.byId[to].name)}`;

/** Private-only routes decline in ONE line, under the trust strip — not in a card that
 *  competes with the offer. It still has to be said, and said statically: a page that
 *  cannot sell a seat must not leave a reader to infer that from silence. */
function noShareNote(T, from, to, shared, p) {
  if (shared) return '';
  return `
  <div class="wrap"><p class="no-share"><span>No shared van runs ${esc(T.byId[from].name)} → ${esc(T.byId[to].name)}. For three or more, a private car often works out close to a seat price.</span> <a href="${esc(boardHref(T, from, to, p))}">Or start a ride on the board →</a></p></div>`;
}

/** 07:30 → 7:30am, matching how the product pages state boarding times. */
function fmtTime(t) {
  const [h, m] = String(t).split(':');
  const H = Number(h);
  return `${((H + 11) % 12) + 1}:${m}${H < 12 ? 'am' : 'pm'}`;
}

/** Prose → sentences. ONE helper, shared by the hero line and the body lede below: they have
 *  to agree about where the first sentence ends, or the page says the same thing twice. */
function sentences(text) {
  return (String(text).match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || []).map(s => s.trim()).filter(Boolean);
}

/* The hero's one-line pitch.

   The first version of this was "the intro's first sentence if it is under 120 chars, else
   <From> to <To> in your own AC car or van…". Both halves read badly on the built page: the
   template repeated the two place names that are already in the h1 directly above it (26 of
   44 pages), and where the first sentence WAS used it turned up again word for word as the
   opening of the body copy one screen below (the other 18).

   So: the fallback names no place — the h1 has just said them — and the intro's first
   sentence is borrowed ONLY when it reads as a standalone line (40–120 chars) and there is
   more intro left to carry the body. When it is borrowed, driveLede() starts at sentence two,
   so nothing on the page is said twice. Guarded by web-tests/unit/trip-redesign.test.js. */
const PITCH_FALLBACK = 'Your own air-conditioned car or van, door to door, at a fixed price.';
function heroLine(intro) {
  const parts = sentences(intro);
  const first = parts[0] || '';
  return (parts.length >= 2 && first.length >= 40 && first.length <= 120) ? first : PITCH_FALLBACK;
}
/** The body copy under "The drive" — the intro, minus whatever the hero already said. */
function driveLede(intro) {
  if (heroLine(intro) === PITCH_FALLBACK) return String(intro).trim();
  return sentences(intro).slice(1).join(' ');
}

/* The Tripadvisor review count has ONE source: ta-data.js (web-tests/unit/ta-review-count.test.js
   is what keeps every copy of it in step). A route page ships no script that could read it at
   paint time — these pages exist to be crawled, so the number has to be in the served HTML —
   so the generator reads it HERE and bakes it in, and `npm run generate` becomes the step that
   keeps the 44 pages current. ta-data.js is a browser IIFE that assigns window.TA and then
   paints; the sandbox reports the document as still loading, so paint() waits for a
   DOMContentLoaded that never arrives and never touches a DOM that isn't there. */
function loadTaReviews() {
  const sandbox = { window: {}, document: { readyState: 'loading', addEventListener() {} } };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(ROOT, 'ta-data.js'), 'utf8'), sandbox, { filename: 'ta-data.js' });
  const n = sandbox.window.TA && sandbox.window.TA.reviews;
  if (!Number.isInteger(n) || n <= 0) throw new Error('ta-data.js did not publish a review count');
  return n;
}
let TA_REVIEWS = 0;
const taReviews = () => (TA_REVIEWS ||= loadTaReviews());

/* The homepage's trust strip, minus its fifth item. "Shared seats every Wed & Sat" is a
   homepage claim about the scheduled service; on a route page it would contradict the page
   itself, which under design A refuses no date at all (route-page-unified.test.js asserts
   no page ever says it). Same four marks as the homepage row, verbatim: they are generic
   stroke icons rather than img/icons/line family marks — none of the four has a family
   equivalent that carries the waypoint dot, and mixing the two sets in one row shows. */
const TRUST_CLAIMS = [
  ['<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M12 2 4 5v6c0 5 3.5 8 8 11 4.5-3 8-6 8-11V5l-8-3z"/></svg>', 'Fully insured &amp; safe drivers'],
  ['<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M3 13h18M5 13V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6M6 17v2M18 17v2"/></svg>', 'AC cars &amp; vans'],
  ['<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="m5 12 5 5L20 7"/></svg>', 'Free cancellation 24h before'],
  ['<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>', 'WhatsApp support 7 days'],
];
const trustStrip = () =>
  `<div class="trip-trust"><div class="wrap"><ul>${TRUST_CLAIMS.map(([ic, t]) => `<li>${ic} ${t}</li>`).join('')}</ul></div></div>`;

/* ── "What's included" ────────────────────────────────────────────────────────────────────
   Four claims, and only four. Every one of them is something we actually do on every private
   transfer; the row is not a place to add a fifth nice-sounding line. In particular there is
   NO meet-and-greet here — we hold no name board at arrivals (docs: #679), and the pickup
   copy stays generic on purpose.

   The marks are the house line family (img/icons/line/{rate-lock,door-to-door,your-line,
   free-cancel}.svg), the same four ideas search.html's own "included" chips carry — its
   `.incl .chip` row is the precedent, down to filling the waypoint dot in saffron. An inlined
   `class="wp"` dot and a `.wp{fill:…}` rule are a matched pair: without the rule the dot is an
   invisible hairline ring, so `.included svg .wp` in the page CSS is not optional. */
const ic = body => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const INCLUDED = [
  [ic('<rect x="5.5" y="10.5" width="13" height="9.5" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/><circle class="wp" cx="12" cy="15.2" r="1.5"/>'),
    'A fixed price', 'The price you see is the price you pay &mdash; no haggling at the kerb.'],
  [ic('<circle cx="5" cy="18.5" r="2"/><path d="M6.8 16.7C11 12.7 13 9.7 17.2 7.7" stroke-dasharray="2.7 2.7"/><circle class="wp" cx="19" cy="6.5" r="2"/>'),
    'Door to door', 'Picked up exactly where you are, dropped exactly where you&rsquo;re staying.'],
  [ic('<path d="M5.5 13.5c2-5 4-5 4.7-2 .6 2.7 2.2 2.9 4-1.1"/><path d="M4 18.5h13.5" stroke-dasharray="2.7 2.9"/><circle class="wp" cx="20.5" cy="18.5" r="1.5"/>'),
    'Stops when you want', 'Photos, lunch, a quick sight &mdash; tell your driver and they&rsquo;ll build it in.'],
  [ic('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 2.8V6M16 2.8V6"/><path d="M15.3 14.6a3.3 3.3 0 1 0 .6 2.4"/><path d="M15.9 12.4v2.4h-2.4"/><circle class="wp" cx="8" cy="2.8" r="1.2"/>'),
    'Free cancellation', 'Up to 24 hours before, and no fees to change your date.'],
];

/* The proof row. The quote is the homepage founder note, VERBATIM (index.html, .founder-note)
   — a softer paraphrase would be a different claim wearing the founder's name. The prototype
   showed only its second sentence; both sentences are used here, because one sentence left
   two thirds of a 1180px row empty and the first sentence is the half that says WHY. The
   review count comes from ta-data.js at generate time, never a literal. */
const FOUNDER_QUOTE = 'We started Ceylon Hop because we were tired of watching travellers overpay and stress over getting around. Every guest rides with a driver we&rsquo;d trust with our own family.';
const FOUNDER_CITE = 'Roshen &mdash; Co-founder, Ceylon&nbsp;Hop';

function includedSection(p) {
  const items = INCLUDED.map(([icon, h, body]) => `<div>${icon}<h3>${h}</h3><p>${body}</p></div>`).join('');
  return `
  <section class="section trip-included">
    <div class="wrap">
      <div class="trip-head"><span class="eyebrow">Every private transfer</span><h2>What&rsquo;s included</h2></div>
      <div class="included">${items}</div>
      <figure class="proof">
        <img src="${p}img/team-roshen.jpg" alt="Roshen, co-founder of Ceylon Hop" width="848" height="933" loading="lazy" decoding="async">
        <blockquote>&ldquo;${FOUNDER_QUOTE}&rdquo;<cite>${FOUNDER_CITE}</cite></blockquote>
        <div class="proof-ta"><b>5.0</b><span class="proof-stars" aria-hidden="true">&#9733;&#9733;&#9733;&#9733;&#9733;</span><br><span data-ta-reviews>${taReviews()}</span> reviews on Tripadvisor</div>
      </figure>
    </div>
  </section>`;
}

/* ── The drive ────────────────────────────────────────────────────────────────────────────
   The highlights were a bullet list under a paragraph. They are the same strings, drawn as
   the route line they describe: origin, every highlight in order, destination. A real <ol>,
   because the order is the point; the markers are suppressed and redrawn as the dotted spine.

   The title is written per PAIR and only for the two the prototype mocked — 44 hand-written
   headings is 44 things to keep current. A reverse page falls back too: "Tea, waterfalls and
   hairpins" describes the climb, not the descent. */
function driveSection(c, forward, fromName, toName, highlights, intro, photos, from, p) {
  const title = (forward && c.driveTitle) ? c.driveTitle : `The road from ${fromName} to ${toName}`;
  const photo = photoFor(photos, c.photo || from);
  const mid = highlights.map(h => `<li>${esc(h)}</li>`).join('');
  return `
  <section class="section trip-drive">
    <div class="wrap drive">
      <div class="drive-copy">
        <span class="eyebrow">The drive</span>
        <h2>${esc(title)}</h2>
        <p class="drive-lede">${esc(driveLede(intro))}</p>
        <ol class="stops">
          <li class="end">${esc(fromName)}</li>${mid}<li class="end end-to">${esc(toName)}</li>
        </ol>
      </div>
      <figure class="drive-photo">${imgTag(photo, { p, sizes: '(max-width:900px) 100vw, 45vw' })}<figcaption>${esc(photo.caption)}</figcaption></figure>
    </div>
  </section>`;
}

function faqItems(from, to, q, shared) {
  const estimate = lowerFirst(routeEstimate(q));
  // Three of these five are generic questions that happened to carry the route name; in an
  // accordion, where the question IS the row, "How long does the Colombo Airport (CMB) to
  // Sigiriya / Dambulla transfer take?" is a paragraph pretending to be a label. They are
  // shortened. The two that are NOT are the ones the old WordPress pages ranked for — "how
  // much is a taxi from X to Y" and the shared-taxi question — and those keep every word
  // (web-tests/unit/seo-legacy-keywords.test.js). This array is also the JSON-LD FAQPage, so
  // the crawler's copy and the reader's copy change together, which is the point of it.
  const items = [
    [`How long does the drive take?`,
      `Plan for ${estimate} by road. Your driver takes the fastest safe route and can add stops along the way.`],
    [`How much is a taxi from ${from} to ${to}?`,
      `A private car is from $${price(q.car)} and an air-conditioned van (up to 6 people) from $${price(q.van)}, fixed and door to door — the price you see is the price you pay.${shared ? ` A shared seat is from $${shared.seat} per person.` : ''}`],
    // Design A: a shared seat is a date with names on it. No fixed timetable is quoted,
    // because there is no date we refuse — the van runs when enough travellers commit.
    shared
      ? [`How does the ${from} to ${to} shared taxi work?`, `Pick the date you want to travel. When ${MIN_SEATS} travellers are going on that date the van runs, and everyone pays $${price(shared.seat)} a seat. Your card is saved when you add your name and is only charged once the van is confirmed — if it never fills, you pay nothing.`]
      // Asked in the searcher's own words. The old site's best-known page was a Kandy → Ella
      // "shared taxi" we no longer run; the honest way to stay relevant to that search is to
      // answer it, not to imply a seat in the title.
      : [`Is there a shared taxi from ${from} to ${to}?`, `Not at the moment — this route is private-only, so you get the whole vehicle to yourself. If you'd like to share, message us and we'll suggest the nearest route travellers are pooling.`],
    [`Can we stop along the way?`,
      `Of course. A private transfer is door to door and yours for the trip — tell your driver where you'd like to stop for photos, lunch or a quick sight and they'll build it in.`],
    [`How do I book?`,
      `Get an instant fixed price and book online, or message us on WhatsApp and we'll arrange it. You pay securely online to confirm your booking.`],
  ];
  return items;
}

function jsonLd(from, to, url, q, faq) {
  const breadcrumb = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
      { '@type': 'ListItem', position: 2, name: 'Routes', item: `${ORIGIN}/trip/` },
      { '@type': 'ListItem', position: 3, name: `${from} to ${to}`, item: url },
    ],
  };
  const faqPage = {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: faq.map(([q2, a]) => ({ '@type': 'Question', name: q2, acceptedAnswer: { '@type': 'Answer', text: a } })),
  };
  const service = {
    '@context': 'https://schema.org', '@type': 'Service',
    serviceType: 'Taxi & private intercity transfer',
    name: `${from} to ${to} taxi — private transfer`,
    areaServed: 'Sri Lanka',
    provider: { '@type': 'TravelAgency', name: 'Ceylon Hop', url: `${ORIGIN}/`, telephone: '+94779669662' },
    offers: { '@type': 'Offer', priceCurrency: 'USD', price: price(q.car), url },
  };
  return [breadcrumb, faqPage, service]
    .map(o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n');
}

// Every generated direction, as {from,to}. Used to derive related links.
function allDirections() {
  const out = [];
  for (const [a, b] of BASE_PAIRS) { out.push({ from: a, to: b }); out.push({ from: b, to: a }); }
  return out;
}

// The reverse of this route first (the single most likely next click), then routes that share an
// endpoint — onward legs from the destination, then other ways into it. Capped so the block stays
// a helpful shortlist rather than a link dump.
function relatedRoutes(from, to, limit = 4) {
  const all = allDirections();
  const seen = new Set([`${from}|${to}`]);
  const picked = [];
  const take = (d) => {
    const k = `${d.from}|${d.to}`;
    if (seen.has(k) || picked.length >= limit) return;
    seen.add(k); picked.push(d);
  };
  take({ from: to, to: from });                       // the way back
  all.filter(d => d.from === to).forEach(take);       // continuing from the destination
  all.filter(d => d.to === to).forEach(take);         // other ways to reach it
  all.filter(d => d.from === from).forEach(take);     // other trips from the same start
  return picked.slice(0, limit);
}

function routePage(T, content, from, to, forward, photos) {
  const key = forward ? `${from}|${to}` : `${to}|${from}`;
  const c = content.pairs[key];
  if (!c) throw new Error(`route-content.json missing pair "${key}"`);
  const fromName = T.byId[from].name, toName = T.byId[to].name;
  const q = T.privateQuote(from, to);
  const shared = T.sharedOption(from, to);
  const intro = forward ? c.intro : c.back;
  const highlights = (!forward && c.highlightsBack) ? c.highlightsBack : c.highlights;
  const estimate = routeEstimate(q);
  const url = `${ORIGIN}/trip/${slug(from, to)}/`;
  const { header, footer, headAssets, bootScript } = renderChrome({ depth: 2 });
  const p = '../../';

  // Private-only routes must never promise a seat in the SERP, so the shared half is added ONLY
  // where a shared seat genuinely exists on this corridor — matching the H1 and the price chips.
  //
  // "taxi" / "shared taxi" are the words the old WordPress pages ranked for ("Kandy to Ella -
  // Shared Taxi"), and these pages inherited those rankings at the 2026-09-20 apex cutover. They
  // go FIRST, straight after the place names, because a search result truncates near 60 chars
  // and long names ("Sigiriya / Dambulla", "Colombo Airport (CMB)") eat most of that.
  // "door to door" stays attached to the private option: a shared seat boards at a stop.
  // Guarded by web-tests/unit/seo-legacy-keywords.test.js.
  const title = shared
    ? `${fromName} to ${toName} shared taxi from $${shared.seat} & private transfer | Ceylon Hop`
    : `${fromName} to ${toName} taxi — private transfer, fixed price | Ceylon Hop`;
  const desc = shared
    ? `Private taxi from ${fromName} to ${toName} at a fixed price — ${estimate}, door to door. Or take the shared taxi from $${shared.seat} a seat.`
    : `Private taxi from ${fromName} to ${toName} — car or AC van at a fixed price, door to door. ${estimate}. Rated 5.0 on Tripadvisor.`;
  const faq = faqItems(fromName, toName, q, shared);

  /* Where next. The reverse leg is always first (relatedRoutes picks it), and it says so —
     "Return trip" is the single most likely next click and it should not look like just
     another route. `data-list-fare` marks a fare that belongs to a DIFFERENT route from this
     page's: nothing reads it yet, but route-page-fares.js only ever asks the engine about
     [data-live-fares]'s own leg, so these must not be mistaken for it. The container class
     and the card class are deliberately different — on the sibling /trip/ index they were the
     same and the grid's `gap` applied inside every card. */
  const relatedHtml = relatedRoutes(from, to).map(d => {
    const rq = T.privateQuote(d.from, d.to);
    const dFrom = T.byId[d.from].name, dTo = T.byId[d.to].name;
    const ret = (d.from === to && d.to === from) ? '<span class="rt-ret">Return trip</span>' : '';
    return `<a class="rt-card" href="${p}trip/${slug(d.from, d.to)}/">${ret}${imgTag(photoFor(photos, d.to), { p, sizes: '(max-width:900px) 50vw, 25vw' })}<span class="rt-bd"><span class="rt-name">${esc(dFrom)} → ${esc(dTo)}</span><span class="rt-meta">${routeEstimate(rq)}</span><span class="rt-fare">from <b data-list-fare data-from-name="${esc(dFrom)}" data-to-name="${esc(dTo)}">$${price(rq.car)}</b> fixed</span></span></a>`;
  }).join('');
  // The "how much is a taxi" answer states the same two fares as the card, so it gets the same
  // live figures — otherwise a boosted route would say $66 on the card and $59.99 a scroll below.
  // The JSON-LD copy of this answer stays the catalogue's: it is for crawlers, which run no engine.
  const liveFares = (html) => {
    const car = `from $${price(q.car)} and`, van = `from $${price(q.van)},`;
    if (!html.includes(car) || !html.includes(van)) return html;
    return html.replace(car, `from <span data-fare="car">$${price(q.car)}</span> and`)
               .replace(van, `from <span data-fare="van">$${price(q.van)}</span>,`);
  };
  // A native <details> accordion: it opens with no JavaScript, is keyboard-operable for free,
  // and a crawler still reads every closed answer. The first item ships open so the column is
  // never four unexplained bars.
  const faqHtml = faq.map(([qq, a], i) => `<details${i === 0 ? ' open' : ''}><summary>${esc(qq)}</summary><p>${liveFares(esc(a))}</p></details>`).join('\n          ');
  if ((faqHtml.match(/data-fare=/g) || []).length !== 2) throw new Error(`${from}-to-${to}: the FAQ price sentence changed shape — liveFares() no longer finds both fares`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(fromName + ' to ' + toName + ' — Ceylon Hop')}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="Ceylon Hop">
<meta property="og:image" content="${OG_IMAGE}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${OG_IMAGE}">
${headAssets}
<!-- Live ride dates come from here (route-page.js). "?api=off" disables it and
     "?api=ORIGIN" points it elsewhere — the same contract as search.html and
     booking.html, so one local API can be driven from any of them. -->
<script>(function(){var q=new URLSearchParams(location.search).get('api');window.CEYLON_HOP_API=(q==='off')?'':(q||window.CEYLON_HOP_API||'https://ceylon-hop-api.onrender.com');
  /* Fares: held back (transparent, in place) until route-page-fares.js has the engine's answer,
     so the page never shows one price and then another. Set HERE, before first paint, and
     released HERE on a timer too — if that script never loads, the catalogue fares still appear. */
  if(window.CEYLON_HOP_API){var d=document.documentElement;d.classList.add('fares-pending');setTimeout(function(){d.classList.remove('fares-pending');},4500);}
})();</script>
<style>
  /* ── hero ──────────────────────────────────────────────────────────────────────
     The route page LEADS with a photo of where you are going, and the fares card sits
     on top of it. The card overhangs the hero's bottom edge by 64px, which is why
     .route-hero must NOT be overflow:hidden — that clips the card and slices the Book
     button in half. The photo and its gradient are contained in .hero-media instead.
     Guarded by web-tests/e2e/route-page-layout.spec.js. */
  .route-hero{position:relative;color:#fff;background:#23302b;isolation:isolate}
  .route-hero .wrap{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:48px;align-items:end;padding-top:30px}
  .hero-media{position:absolute;inset:0;overflow:hidden;z-index:-1}
  /* imgTag emits the image's INTRINSIC width/height, so a box with no explicit height lets
     the HTML height attribute win and the photo renders several times too tall. */
  .hero-media img{position:absolute;inset:0;z-index:0;width:100%;height:100%;object-fit:cover}
  /* Both children carry an explicit z-index on purpose: .hero-media is its own stacking
     context, and without it the gradient can paint UNDER the photo — which quietly removes
     the contrast the white hero text depends on. */
  .hero-media::after{content:"";position:absolute;inset:0;z-index:1;
    background:linear-gradient(90deg,rgba(20,28,26,.86) 0%,rgba(20,28,26,.66) 46%,rgba(20,28,26,.24) 100%),
               linear-gradient(0deg,rgba(20,28,26,.62),rgba(20,28,26,0) 45%)}
  .route-hero-copy{display:flex;flex-direction:column;gap:16px;min-height:430px;padding-bottom:74px}
  .route-crumbs{font-size:.84rem;color:rgba(255,255,255,.85);margin-bottom:auto;text-shadow:0 1px 10px rgba(12,18,16,.6)}
  .route-crumbs a{color:inherit}
  .route-hero h1{font-weight:700;margin:0;color:#fff;font-size:clamp(2.1rem,5vw,4rem);display:flex;align-items:center;gap:.05em .3em;flex-wrap:wrap;text-shadow:0 2px 22px rgba(12,18,16,.5)}
  .route-hero h1 .arr{color:var(--accent,#63BFD6);display:inline-flex}
  /* The squiggle replaces the word "to" visually, but "<from> to <to>" IS the phrase these
     pages rank for — so the word stays in the h1 for crawlers and screen readers. */
  .vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
  .route-hero h1 .arr svg{width:.8em;height:.8em}
  .hero-sub{max-width:34rem;margin:0;font-size:1.02rem;color:rgba(255,255,255,.93);text-shadow:0 1px 14px rgba(12,18,16,.6)}
  .route-meta{display:flex;gap:8px;flex-wrap:wrap;list-style:none;margin:0;padding:0;font-size:.8rem;font-weight:500}
  .route-meta li{display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:999px;background:rgba(20,28,26,.55);border:1px solid rgba(255,255,255,.24);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
  .route-meta svg{width:15px;height:15px;flex:none}
  .route-meta svg .wp{fill:var(--saffron,#F9A429);stroke:none}
  /* fares card — the page's whole job, above the fold. Static: a crawler sees all of it. */
  .opt{position:relative;background:var(--paper,#fffdf8);border:1.5px solid var(--line,#e7e3d6);border-radius:20px;padding:26px}
  .opt.fares{color:var(--ink,#3A3739);border:0;border-radius:22px;padding:22px;margin-bottom:-64px;z-index:2;
    display:flex;flex-direction:column;gap:12px;
    box-shadow:0 24px 60px -18px rgba(30,40,36,.45),0 2px 0 rgba(255,255,255,.6) inset}
  .fares h2{margin:0;font-size:1.35rem}
  .fares-kick{margin:0 0 .15rem;font-size:.68rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-soft,#6c6a6b)}
  .veh-set{border:0;margin:0;padding:0;min-width:0;display:flex;flex-direction:column;gap:10px}
  .veh{position:relative;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:14px;
    background:#fff;border:1.5px solid var(--line,#e7e3d6);border-radius:14px;padding:12px 14px;cursor:pointer}
  .veh input{position:absolute;opacity:0;width:1px;height:1px;margin:0}
  .veh:has(input:checked){border-color:var(--blue-deep,#24758A);box-shadow:0 0 0 3px rgba(var(--accent-rgb,99,191,214),.28)}
  .veh:has(input:focus-visible){outline:3px solid var(--blue-deep,#24758A);outline-offset:2px}
  .veh-ic{display:inline-flex;color:var(--blue-deep,#24758A)}
  .veh-ic svg{width:46px;height:30px}
  .veh-n{font-weight:600;font-size:.95rem;line-height:1.3} .veh-n small{display:block;font-weight:400;color:var(--ink-soft,#6c6a6b);font-size:.78rem}
  .veh-p{font-weight:700;font-size:1.3rem;line-height:1.1;text-align:right;font-variant-numeric:tabular-nums} .veh-p small{display:block;font-weight:400;color:var(--ink-soft,#6c6a6b);font-size:.68rem}
  .fares-fine{margin:0;font-size:.76rem;color:var(--ink-soft,#6c6a6b);text-align:center}
  .share-strip{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#FDF0D6;border:1px solid #F3D9A4;
    border-radius:14px;padding:11px 14px;font-size:.84rem;text-decoration:none;color:inherit}
  .share-strip b{font-size:1.05rem}
  .share-strip span:last-child{font-weight:600;color:var(--blue-deep,#24758A);white-space:nowrap}
  /* ── trust strip ──────────────────────────────────────────────────────────────
     Sits directly under the hero, so the overhanging card lands on its right-hand end.
     The list RESERVES that space (400px card + 40px clearance) and wraps to a second
     line rather than running underneath it. */
  .trip-trust{background:#22302F;color:#fff}
  .trip-trust ul{list-style:none;margin:0;padding:18px 0;display:flex;flex-wrap:wrap;gap:10px 30px;font-size:.82rem;font-weight:500;max-width:calc(100% - 440px)}
  .trip-trust li{display:flex;align-items:center;gap:8px}
  .trip-trust svg{width:16px;height:16px;flex:none;color:var(--accent,#63BFD6)}
  /* private-only note — one line, not half the page. Same reservation as the strip above. */
  .no-share{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin:36px 0 0;padding:14px 18px;
    border:1px dashed #cfcab8;border-radius:14px;font-size:.9rem;color:var(--ink-soft,#6c6a6b);max-width:calc(100% - 448px)}
  .no-share a{font-weight:600;color:var(--blue-deep,#24758A)}
  /* ── shared ride section ── */
  .share-grid{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);gap:48px;align-items:start}
  .share-copy{display:flex;flex-direction:column;gap:14px;align-items:flex-start}
  .share-tag{background:var(--saffron,#F9A429);color:#3a2a08;font-size:.68rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;border-radius:999px;padding:5px 12px}
  .share-copy h2{margin:0;font-size:clamp(1.8rem,3.4vw,2.6rem)}
  .share-lede{margin:0;font-size:1.04rem;line-height:1.6;color:var(--ink-soft,#6c6a6b);max-width:36rem}
  .seat-price{margin:.2rem 0 .1rem} .seat-price b{font-size:2.3rem;line-height:1} .seat-price span{color:var(--ink-soft,#6c6a6b);font-weight:600}
  .runs-line{font-size:.9rem;font-weight:600;margin:.1rem 0 .5rem}
  .pickups{list-style:none;margin:.7rem 0 0;padding:0;display:grid;gap:.25rem}
  .pickups li{font-size:.92rem;color:var(--ink-soft,#6c6a6b)}
  .pickups li b{color:var(--ink,#3A3739);display:inline-block;min-width:4.6em}
  .opt-cta{margin-top:16px;width:100%;text-align:center}
  .fares .opt-cta{margin-top:0}
  /* ── sticky book bar — shipped hidden; a later step turns it on while scrolling ── */
  .trip-bookbar{display:none}
  /* A fare the engine has not confirmed yet: same box, no ink. */
  .fares-pending [data-fare]{color:transparent;background:var(--cream-deep,#ece6da);border-radius:6px}
  /* Live dates — added by route-page.js. Absent for a crawler and whenever the API is
     unreachable, which is why nothing above depends on it. */
  .ld-datebar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:16px}
  .ld-chip{border:1.5px solid var(--line,#e7e3d6);background:#fff;border-radius:999px;padding:.42rem 1rem;font:inherit;font-weight:600;font-size:.86rem;cursor:pointer}
  .ld-chip.is-on{background:var(--blue-deep,#24758A);border-color:var(--blue-deep,#24758A);color:#fff}
  .ld-date{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
  .live-dates{margin-top:14px}
  .ld-head{font-weight:700;font-size:.95rem;margin-bottom:.5rem}
  .ld-first,.ld-alt{font-size:.88rem;color:var(--ink-soft,#6c6a6b);margin:.2rem 0 .6rem}
  .ld-first b{color:var(--ink,#3A3739)}
  .ld-rows{display:grid;gap:8px}
  .ld-row{display:grid;grid-template-columns:auto 1fr auto auto;align-items:center;gap:6px 11px;padding:11px 14px;background:#fff;border:1.5px solid var(--line,#e7e3d6);border-radius:12px;text-decoration:none;color:inherit;transition:border-color .15s,transform .15s}
  .ld-row:hover{border-color:var(--accent,#63BFD6);transform:translateX(2px)}
  .ld-row.is-yours{border-color:var(--saffron,#F9A429);background:#fffaf1}
  .ld-faces{grid-column:1;grid-row:1/3;display:inline-flex}
  .ld-face{width:25px;height:25px;border-radius:50%;border:2px solid #fff;display:inline-grid;place-items:center;font-size:.62rem;font-weight:800;color:#fff}
  .ld-face+.ld-face{margin-left:-8px}
  .ld-face-more{background:var(--ink-soft,#6c6a6b)}
  .ld-when{font-weight:700;font-size:.9rem;grid-column:2}
  .ld-tag{font-size:.6rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#8a5a00;background:#fdeecb;border-radius:999px;padding:.1rem .45rem}
  .ld-count{grid-column:2;grid-row:2;font-size:.82rem;color:var(--ink-soft,#6c6a6b)}
  .ld-count b{color:var(--ink,#3A3739)}
  .ld-meter{grid-column:3;grid-row:1/3;width:52px;height:5px;border-radius:99px;background:var(--cream-deep,#E4E0D2);overflow:hidden}
  .ld-meter i{display:block;height:100%;background:var(--teal,#0AB9B6);border-radius:99px}
  .ld-meter i.full{background:var(--saffron,#F9A429)}
  .ld-go{grid-column:4;grid-row:1/3;color:var(--blue-deep,#24758A);font-weight:800}
  /* ── the drive ────────────────────────────────────────────────────────────────
     A two-column band: the copy and the route line on the left, a photo of where you
     START on the right (the hero already shows where you are going, so no page ever
     prints the same photo twice). site.css does not define .drive, .stops, .end,
     .included, .proof, .next or any of the rt-* names — the only shared names this
     block reuses are .section, .wrap, .eyebrow and .btn, deliberately. */
  .trip-drive{background:var(--paper,#fffdf8)}
  .drive{display:grid;grid-template-columns:minmax(0,6fr) minmax(0,5fr);gap:56px;align-items:center}
  .drive h2{margin:0;font-size:clamp(1.8rem,3.4vw,2.6rem)}
  .drive .eyebrow{margin:0 0 .7rem}
  .drive-lede{margin:14px 0 0;font-size:1.04rem;line-height:1.65;color:var(--ink-soft,#6c6a6b);max-width:36rem}
  /* A real <ol> — the stops happen in that order — with the markers suppressed and
     redrawn as a dotted spine with a dot per stop. */
  .stops{list-style:none;margin:26px 0 0;padding:0;position:relative}
  .stops::before{content:"";position:absolute;left:11px;top:12px;bottom:12px;border-left:2px dotted var(--blue-deep,#24758A);opacity:.55}
  .stops li{position:relative;padding:0 0 16px 40px;font-size:.96rem}
  .stops li::before{content:"";position:absolute;left:6px;top:7px;width:12px;height:12px;border-radius:50%;
    background:var(--paper,#fffdf8);border:2px solid var(--blue-deep,#24758A)}
  .stops li.end{font-family:var(--display);font-weight:700;font-size:1.15rem;padding-bottom:18px}
  .stops li.end::before{left:2px;top:3px;width:20px;height:20px;background:var(--blue-deep,#24758A);
    border-color:var(--paper,#fffdf8);box-shadow:0 0 0 2px var(--blue-deep,#24758A)}
  .stops li.end-to::before{background:var(--cta,#EC3A24);box-shadow:0 0 0 2px var(--cta,#EC3A24)}
  .stops li:last-child{padding-bottom:0}
  /* imgTag emits the photo's INTRINSIC width/height, so every framed image below needs
     height:auto (or an explicit height) — otherwise the HTML height attribute wins over
     the aspect-ratio box and the photo renders several times too tall. */
  .drive-photo{position:relative;margin:0}
  .drive-photo img{display:block;width:100%;height:auto;aspect-ratio:4/5;object-fit:cover;border-radius:26px}
  .drive-photo figcaption{position:absolute;left:18px;bottom:16px;background:var(--paper,#fffdf8);border-radius:12px;
    padding:6px 14px;font-family:var(--hand,'Caveat',cursive);font-weight:600;font-size:1.3rem;line-height:1.2;
    transform:rotate(-2deg);box-shadow:0 8px 20px -8px rgba(0,0,0,.4)}
  /* ── what's included, and the proof row under it ──────────────────────────────
     The four marks are the house line family, so each carries one filled waypoint dot.
     An inlined class="wp" and a .wp{fill:…} rule are a matched pair — without the rule
     the dot is an invisible hairline ring. Same pairing search.html's .incl chips use. */
  .trip-included{background:linear-gradient(180deg,#E3EFE9,#EEF0E4)}
  .trip-head{margin-bottom:34px}
  .trip-head h2{margin:0;font-size:clamp(1.8rem,3.4vw,2.6rem)}
  .trip-head .eyebrow{margin:0 0 .7rem}
  .included{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:26px}
  .included>div{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
  .included svg{width:40px;height:40px;padding:9px;border-radius:50%;background:#D9EEF3;color:var(--blue-deep,#24758A)}
  .included svg .wp{fill:var(--saffron,#F9A429);stroke:none}
  .included h3{margin:0;font-family:var(--body);font-size:.98rem;font-weight:600}
  .included p{margin:0;font-size:.86rem;line-height:1.55;color:var(--ink-soft,#6c6a6b)}
  .proof{margin:48px 0 0;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:22px;align-items:center;
    background:#fff;border:1px solid var(--line,#e7e3d6);border-radius:22px;padding:24px 28px}
  .proof img{display:block;width:64px;height:64px;border-radius:50%;object-fit:cover}
  .proof blockquote{margin:0;font-family:var(--display);font-style:italic;font-size:1.08rem;line-height:1.45}
  .proof cite{display:block;margin-top:6px;font-family:var(--body);font-style:normal;font-size:.8rem;color:var(--ink-soft,#6c6a6b)}
  .proof-ta{text-align:center;font-size:.76rem;color:var(--ink-soft,#6c6a6b);border-left:1px solid var(--line,#e7e3d6);padding-left:22px}
  .proof-ta b{display:block;font-size:1.7rem;color:var(--ink,#3A3739);line-height:1.1}
  .proof-stars{color:var(--saffron,#F9A429);letter-spacing:2px}
  /* ── FAQ accordion ────────────────────────────────────────────────────────────
     Native <details>: it opens with no JavaScript, is keyboard-operable for free, and a
     crawler still reads every closed answer — which matters, because this markup and the
     JSON-LD FAQPage are built from the same array. */
  .faq{background:var(--cream-deep,#E4E0D2)}
  .faq-grid{display:grid;grid-template-columns:minmax(0,4fr) minmax(0,7fr);gap:56px;align-items:start}
  .faq-side{display:flex;flex-direction:column;align-items:flex-start;gap:16px}
  .faq-side h2{margin:0;font-size:clamp(1.8rem,3.4vw,2.6rem)}
  .faq-side .eyebrow{margin:0}
  .faq-lede{margin:0;font-size:1.02rem;line-height:1.6;color:var(--ink-soft,#6c6a6b)}
  .faq-acc{border-top:1px solid #d5d0bf}
  .faq-acc details{border-bottom:1px solid #d5d0bf}
  .faq-acc summary{list-style:none;cursor:pointer;display:flex;justify-content:space-between;align-items:center;
    gap:16px;padding:18px 2px;font-weight:600;font-size:1rem}
  .faq-acc summary::-webkit-details-marker{display:none}
  .faq-acc summary::after{content:"+";font-size:1.5rem;font-weight:400;color:var(--blue-deep,#24758A);line-height:1;flex:none}
  .faq-acc details[open] summary::after{content:"\\2013"}
  .faq-acc p{margin:0;padding:0 40px 20px 2px;color:var(--ink-soft,#6c6a6b);font-size:.94rem;line-height:1.6;max-width:40rem}
  /* ── where next ───────────────────────────────────────────────────────────────
     The grid (.next) and the card (a.rt-card) are different classes on purpose: on the
     sibling /trip/ index they were the same, so the grid's gap applied INSIDE every
     card and opened a stripe between each photo and its text. */
  .next{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}
  .rt-card{position:relative;display:flex;flex-direction:column;background:var(--paper,#fffdf8);
    border:1px solid var(--line,#e7e3d6);border-radius:18px;overflow:hidden;text-decoration:none;color:inherit;
    transition:transform .2s,box-shadow .2s}
  .rt-card:hover{transform:translateY(-3px);box-shadow:0 18px 34px -18px rgba(30,40,36,.45)}
  .rt-card img{display:block;width:100%;height:auto;aspect-ratio:16/10;object-fit:cover}
  .rt-bd{padding:14px 16px 16px;display:flex;flex-direction:column;gap:3px}
  .rt-name{font-family:var(--display);font-weight:700;font-size:1.12rem;line-height:1.2;overflow-wrap:anywhere}
  .rt-meta{font-size:.78rem;color:var(--ink-soft,#6c6a6b)}
  .rt-fare{margin-top:8px;font-size:.84rem}
  .rt-fare b{font-size:1.08rem}
  .rt-ret{position:absolute;top:10px;left:10px;z-index:1;background:var(--paper,#fffdf8);border-radius:999px;
    padding:4px 10px;font-size:.66rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
  .trip-all{margin:24px 0 0}
  .trip-all a{font-weight:600;color:var(--blue-deep,#24758A)}
  @media(prefers-reduced-motion:reduce){.rt-card{transition:none}}
  @media(max-width:900px){
    /* On a phone the fares card must sit on CREAM, not on the photo — a card printed over a
       bright beach is unreadable, and the price is the one thing that has to be legible above
       the fold. So the photo stops where the copy stops: .hero-media re-parents itself to
       .route-hero-copy (it is absolute, and this is the rule that makes the copy its
       containing block), and the card slides down onto the page background. */
    .route-hero{background:var(--cream,#F0EEE5)}
    /* The copy block is full-bleed, so the hero's wrap gives up its gutter and the two
       children carry their own. A negative margin was the obvious way to do it and the wrong
       one: site.css steps .wrap's padding 24 → 20 → 18 down the widths, so any hardcoded
       -24px leaves the photo hanging 6px past the viewport at 320 and the whole page scrolls
       sideways. */
    .route-hero .wrap{grid-template-columns:1fr;gap:0;padding-top:18px;padding-left:0;padding-right:0}
    .route-hero-copy{position:relative;isolation:isolate;background:#23302b;min-height:330px;gap:12px;
      padding:18px 20px 52px}
    /* One column now, so the horizontal wash has nothing to do; the readable band is the whole
       block. The TOP end matters as much as the bottom — the breadcrumb and the first line of
       the h1 sit there, and on the brightest photos (Negombo's sand, Mirissa's water) white on
       an unwashed sky is barely a contrast at all. */
    .hero-media::after{background:linear-gradient(0deg,rgba(20,28,26,.9) 0%,rgba(20,28,26,.44) 55%,rgba(20,28,26,.66) 100%)}
    .opt.fares{margin:-32px 20px 20px;padding:18px;gap:10px}
    .trip-trust ul,.no-share{max-width:none}
    .trip-trust ul{gap:8px 18px;font-size:.78rem}
    .no-share{margin-top:24px}
    .share-grid{grid-template-columns:1fr;gap:26px}
    .veh-ic svg{width:38px;height:25px}
    .drive,.faq-grid{grid-template-columns:1fr;gap:30px}
    .drive-photo img{aspect-ratio:4/3}
    .included{grid-template-columns:repeat(2,minmax(0,1fr));gap:22px}
    /* The quote runs to five lines in a phone column, and a vertically centred avatar then
       floats in the middle of it with white space above and below. Align it to the first line. */
    .proof{grid-template-columns:auto minmax(0,1fr);padding:20px;gap:16px;align-items:start}
    .proof blockquote{font-size:1rem}
    .proof-ta{grid-column:1/-1;border-left:0;border-top:1px solid var(--line,#e7e3d6);padding:14px 0 0}
    .faq-acc p{padding-right:8px}
    .next{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .rt-name{font-size:1.02rem}
    /* "from $59.99 fixed" is 138px of type in a 170px card — a hair over, so the last word
       fell to a line of its own on half the cards. */
    .rt-bd{padding:12px 13px 14px}
    .rt-fare{margin-top:6px;font-size:.8rem}
    .rt-fare b{font-size:1rem}
    /* The bar is shipped hidden and stays hidden until a later step reveals it — hence
       :not([hidden]), which keeps display:flex from beating the UA's [hidden] rule. */
    .trip-bookbar:not([hidden]){display:flex;position:fixed;left:0;right:0;bottom:0;z-index:40;
      align-items:center;justify-content:space-between;gap:14px;background:var(--paper,#fffdf8);
      border-top:1px solid var(--line,#e7e3d6);box-shadow:0 -10px 30px -12px rgba(0,0,0,.25);
      padding:10px 16px calc(10px + env(safe-area-inset-bottom,0px))}
    .trip-bookbar .tb-p{font-size:.74rem;color:var(--ink-soft,#6c6a6b);line-height:1.25}
    .trip-bookbar .tb-p b{display:block;font-size:1.2rem;color:var(--ink,#3A3739)}
    .trip-bookbar .btn{padding:13px 26px}
  }
</style>
${jsonLd(fromName, toName, url, q, faq)}
</head>
<body>
${header}
<main>
  <section class="route-hero" id="top-options">
    <div class="wrap">
      <div class="route-hero-copy">
        <div class="hero-media">${imgTag(photoFor(photos, to), { p, sizes: '100vw', eager: true, cls: 'hero-img' })}</div>
        <nav class="route-crumbs" aria-label="Breadcrumb"><a href="${p}index.html">Home</a> · <a href="${p}trip/">Routes</a> · ${esc(fromName)} to ${esc(toName)}</nav>
        <h1>${esc(fromName)} <span class="arr" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12c4-6 8 6 12 0 2.5-3.7 4-3 6 0"/><path d="M17 8l4 4-4 4"/></svg></span><span class="vh"> to </span>${esc(toName)}</h1>
        <p class="hero-sub">${esc(heroLine(intro))}</p>
        <ul class="route-meta">
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M12 21s-7-5.5-7-11a7 7 0 1 1 14 0c0 5.5-7 11-7 11z"/><circle class="wp" cx="12" cy="10" r="2.6"/></svg> ${esc(estimate)}</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 2.8V6M16 2.8V6"/><circle class="wp" cx="12" cy="15" r="1.9"/></svg> Runs every day</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M12 2.7l2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 8.9l5.9-.8z"/><circle class="wp" cx="12" cy="12" r="1.6"/></svg> 5.0 on Tripadvisor</li>
        </ul>
      </div>
      ${faresCard(T, from, to, q, shared, p)}
    </div>
  </section>
  ${trustStrip()}${noShareNote(T, from, to, shared, p)}${sharedSection(T, from, to, shared, p)}${driveSection(c, forward, fromName, toName, highlights, intro, photos, from, p)}${includedSection(p)}
  <section class="section faq">
    <div class="wrap faq-grid">
      <div class="faq-side">
        <span class="eyebrow">Good to know</span>
        <h2>${esc(fromName)} to ${esc(toName)}, answered</h2>
        <p class="faq-lede">Something we haven&rsquo;t covered? We reply within minutes, 7 days a week.</p>
        <!-- The WhatsApp button used to sit in the hero, where it competed with the price for
             the one action above the fold. It belongs with the questions: it is what you press
             when the page has not answered yours. -->
        <a class="btn btn-wa" href="https://wa.me/94779669662" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22c5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2zm0 18.15a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.24 8.24 0 1 1 6.97 3.86zm4.52-6.16c-.25-.12-1.47-.72-1.69-.8-.23-.08-.39-.12-.56.13-.16.25-.64.8-.79.97-.14.16-.29.18-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.42.08-.16.04-.31-.02-.43-.06-.12-.56-1.35-.76-1.85-.2-.48-.41-.42-.56-.43h-.48c-.16 0-.43.06-.66.31-.22.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.16 1.75 2.67 4.25 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.07.14-1.18-.06-.1-.22-.16-.47-.28z"/></svg> Chat on WhatsApp</a>
      </div>
      <div class="faq-acc">
          ${faqHtml}
      </div>
    </div>
  </section>
  <section class="section trip-next">
    <div class="wrap">
      <div class="trip-head"><span class="eyebrow">Keep hopping</span><h2>Where next from ${esc(toName)}?</h2></div>
      <div class="next">${relatedHtml}</div>
      <p class="trip-all"><a href="${p}trip/">See all Sri Lanka transfer routes →</a></p>
    </div>
  </section>
  <!-- Shipped hidden and priced: a later step reveals it once the hero card scrolls away.
       Its fare carries data-fare like every other, so route-page-fares.js updates it too and
       the fares-pending hold covers it. -->
  <div class="trip-bookbar" hidden>
    <span class="tb-p"><small data-bar-label>AC car · total, fixed</small><b><span data-fare="car">$${price(q.car)}</span></b></span>
    <a class="btn btn-cta bar-cta" href="${esc(bookHrefFor(from, to, q, p))}">Choose date &amp; book</a>
  </div>
</main>
${footer}
${bootScript}
<script src="${p}${assetV('ch-pricing.js')}"></script>
<script src="${p}${assetV('route-page-fares.js')}"></script>
<script src="${p}${assetV('route-page.js')}"></script>
</body>
</html>
`;
}

function tripIndex(T, content) {
  const { header, footer, headAssets, bootScript } = renderChrome({ depth: 1 });
  const p = '../';
  const dirs = [];
  for (const [a, b] of BASE_PAIRS) { dirs.push({ from: a, to: b }); dirs.push({ from: b, to: a }); }
  const card = ({ from, to }) => {
    const q = T.privateQuote(from, to);
    return `<a class="rt-card" href="${p}trip/${slug(from, to)}/"><span class="rt-name">${esc(T.byId[from].name)} → ${esc(T.byId[to].name)}</span><span class="rt-meta">${routeEstimate(q)} · from $${price(q.car)}</span></a>`;
  };
  const groups = HUBS.map(h => {
    const inHub = dirs.filter(d => h.match(d)).sort((x, y) => T.byId[x.to].name.localeCompare(T.byId[y.to].name));
    if (!inHub.length) return '';
    return `<section class="section"><div class="wrap"><h2>${esc(h.title)}</h2><div class="rt-grid">${inHub.map(card).join('')}</div></div></section>`;
  }).join('\n');

  const url = `${ORIGIN}/trip/`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sri Lanka transfer routes — fixed-price private &amp; shared rides | Ceylon Hop</title>
<meta name="description" content="Fixed-price private transfers and scheduled shared rides on Sri Lanka's most popular routes — airport to Kandy, Kandy to Ella, the south coast and more. See distances and prices.">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:title" content="Sri Lanka transfer routes — Ceylon Hop">
<meta property="og:description" content="Fixed-price private transfers and scheduled shared rides on Sri Lanka's most popular routes.">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="Ceylon Hop">
<meta property="og:image" content="${OG_IMAGE}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${OG_IMAGE}">
${headAssets}
<style>
  .trip-hero{background:linear-gradient(160deg,#1E6273,#24758A 60%,#277F97);color:#fff;padding:104px 0 40px;margin-top:-74px}
  .trip-hero h1{color:#fff;font-weight:700;max-width:20ch}
  .trip-hero p{color:rgba(255,255,255,.9);max-width:54ch}
  .rt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin-top:18px}
  .rt-card{display:flex;flex-direction:column;gap:4px;padding:16px 18px;border:1px solid var(--line,#e7e3d6);border-radius:14px;background:#fff;text-decoration:none;color:inherit;transition:.15s}
  .rt-card:hover{transform:translateY(-2px);box-shadow:0 10px 24px rgba(20,40,38,.08)}
  .rt-name{font-weight:700}
  .rt-meta{font-size:.85rem;color:var(--ink-soft,#6c6a6b)}
</style>
</head>
<body>
${header}
<main>
  <section class="trip-hero"><div class="wrap"><h1>Sri Lanka transfer routes</h1><p>Fixed-price private transfers and scheduled shared rides on the island's most popular corridors. Pick a route for prices, distance and what the drive is like.</p></div></section>
  ${groups}
</main>
${footer}
${bootScript}
</body>
</html>
`;
}

function sitemap(extraPaths = []) {
  const urls = [`${ORIGIN}/`, `${ORIGIN}/trip/`];
  for (const [a, b] of BASE_PAIRS) { urls.push(`${ORIGIN}/trip/${slug(a, b)}/`); urls.push(`${ORIGIN}/trip/${slug(b, a)}/`); }
  for (const f of ['about.html', 'why.html', 'plan.html', 'tours.html', 'blog.html', ...extraPaths]) urls.push(`${ORIGIN}/${f}`);
  const body = urls.map(u => `  <url><loc>${u}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export function loadContent() {
  return JSON.parse(readFileSync(join(ROOT, 'tools/route-content.json'), 'utf8'));
}

export function generateAll() {
  const T = loadTransfers();
  const content = loadContent();
  const photos = loadPlacePhotos();
  const out = new Map();
  for (const [a, b] of BASE_PAIRS) {
    out.set(`trip/${slug(a, b)}/index.html`, routePage(T, content, a, b, true, photos));
    out.set(`trip/${slug(b, a)}/index.html`, routePage(T, content, b, a, false, photos));
  }
  out.set('trip/index.html', tripIndex(T, content));
  // terms/privacy are added to the sitemap in Unit 2 (Task 2.4) via SITEMAP_EXTRA.
  out.set('sitemap.xml', sitemap(SITEMAP_EXTRA));
  return out;
}

// Static pages that live outside the route generator but belong in the sitemap.
// The blog posts are the site's only earned rankings, so they must be listed. Trailing
// slashes are intentional — these are directory URLs and match the live WordPress ones.
// Compatibility wrapper for older generator callers. Public rounding belongs to the shared
// formatter; this helper only parses the generator's legacy duration-string input.
export function humanDuration(text) {
  const m = /^(?:(\d+)h)?\s*(?:(\d+)m)?$/.exec(String(text).trim());
  let mins;
  if (m && (m[1] || m[2])) mins = (Number(m[1] || 0) * 60) + Number(m[2] || 0);
  else {
    const only = /^(\d+)\s*min$/.exec(String(text).trim());
    if (!only) return String(text); // unrecognised → leave it alone
    mins = Number(only[1]);
  }
  return formatRouteEstimate({ durationMin: mins, state: 'browse' }).replace(/^Approx\.\s*/, '');
}

export const SITEMAP_EXTRA = [
  'terms.html',
  'privacy.html',
  'how-to-use-buses-in-sri-lanka-the-ultimate-guide-for-the-adventurous-travelers/',
  'ultimate-tuk-tuk-guide-to-getting-around-in-sri-lanka/',
  'best-time-to-visit-sri-lanka-a-month-by-month-guide/',
  '9-must-visit-places-in-sri-lanka/',
  'discover-sri-lanka-with-ceylon-hop-your-ultimate-travel-adventure/',
  'why-we-started-ceylon-hop/',
];

// CLI: write every generated file to disk.
if (import.meta.url === `file://${process.argv[1]}`) {
  let n = 0;
  for (const [rel, contentStr] of generateAll()) {
    const abs = join(ROOT, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contentStr);
    n++;
  }
  console.log(`generated ${n} files`);
}
