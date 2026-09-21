import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadTransfers } from './load-transfers.mjs';
import { renderChrome, assetV } from './site-chrome.mjs';
import { loadPlacePhotos, photoFor, imgTag } from './place-photos.mjs';

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

// The /trip/ index groups routes by ORIGIN, one section per place, in this fixed order —
// verified against place-photos.json (task A1) and every BASE_PAIRS id. tripIndex() throws if a
// generated route's origin is ever missing here, so a new place can't silently vanish from the
// index instead of failing the build.
const ORIGIN_ORDER = [
  'cmb-airport', 'colombo', 'negombo', 'kandy', 'sigiriya',
  'nuwara-eliya', 'ella', 'galle', 'mirissa', 'yala', 'arugam-bay',
];

// The index's "Most booked" shortlist — a fixed editorial pick (brief C1 step 3), not derived.
const POPULAR_ROUTES = [['cmb-airport', 'kandy'], ['cmb-airport', 'sigiriya'], ['kandy', 'ella'], ['ella', 'mirissa']];

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (a, b) => `${a}-to-${b}`;
const price = n => Number.isInteger(n) ? String(n) : n.toFixed(2);
const lowerFirst = value => value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
const routeEstimate = q => formatRouteEstimate({
  distanceKm: q.km,
  durationMin: q.durationMin,
  state: q.estimated ? 'estimated' : 'browse',
});

/* ── Design A: the two option cards ───────────────────────────────────────────
   docs/superpowers/plans/2026-08-16-unified-route-page.md

   Two options, never three. A shared seat is a DATE WITH NAMES ON IT, so there is
   no "scheduled" product beside a "pooled" one, and no unavailable state — any
   date can run once enough travellers commit.

   Emitted as complete static HTML on purpose. These pages exist to be indexed, so
   a crawler must see the prices, the boarding points and the CTAs with no JS at
   all; the runtime layer only refreshes live list rows and handles the date field.
   web-tests/unit/route-page-unified.test.js asserts this against script-stripped
   markup. */
const MIN_SEATS = 3; // domain/rideList.ts policyForCorridor — three names run the van

function optionCards(T, from, to, q, shared, p) {
  // booking.js only reads from/to when `mode` is set; without it the page falls through to
  // getRoute(id), finds nothing, and location.replace('plan.html')s -- so a CTA missing these
  // params silently dumps the traveller in the planner. Same contract as search.js's bookUrl:
  // the display price plus the unfinished fare, so extras are added before the finishing pass.
  const bookHref = `${p}booking.html?${new URLSearchParams({
    from, to, mode: 'private', vehicle: 'car',
    price: String(q.car), rawPrice: String(q.rawCar),
  })}`;
  // data-live-fares + data-fare: route-page-fares.js asks the engine for these two figures and
  // writes them in (hot zones live in the prod DB, so nothing generated here can know them).
  // The catalogue fare stays in the markup — it is what a crawler, a no-JS browser and an
  // unreachable API all show.
  const priv = `
      <article class="opt opt-private" data-live-fares data-from-name="${esc(T.byId[from].name)}" data-to-name="${esc(T.byId[to].name)}">
        <span class="opt-tag">Most flexible</span>
        <h2>Private transfer</h2>
        <p class="opt-sub">Door to door · runs every day · your own vehicle</p>
        <div class="veh"><span class="veh-n">AC car<small>up to 3 travellers + bags</small></span><span class="veh-p"><span data-fare="car">$${price(q.car)}</span><small>total, fixed</small></span></div>
        <div class="veh"><span class="veh-n">AC van<small>up to 6 travellers + bags</small></span><span class="veh-p"><span data-fare="van">$${price(q.van)}</span><small>total, fixed</small></span></div>
        <a class="btn btn-cta opt-cta" href="${esc(bookHref)}">Book private transfer</a>
      </article>`;

  if (!shared) {
    return `<div class="opt-grid">${priv}
      <article class="opt opt-none">
        <span class="opt-tag opt-tag-mute">Not on this route</span>
        <h2>Shared ride</h2>
        <p class="opt-sub">No shared van here</p>
        <p class="opt-desc">We don't run a shared van between ${esc(T.byId[from].name)} and ${esc(T.byId[to].name)}, and it isn't a route travellers pool either. A private transfer covers it door to door at a fixed price — and for three or more it often works out close to a seat price anyway.</p>
      </article></div>`;
  }

  const stops = shared.pickups
    .map(s => `<li><b>${esc(fmtTime(s.time))}</b> ${esc(s.point || T.byId[from].name)}</li>`)
    .join('');
  return `<div class="opt-grid">${priv}
      <article class="opt opt-shared">
        <span class="opt-tag opt-tag-warm">Best value · share &amp; save</span>
        <h2>Shared ride</h2>
        <p class="opt-sub">One van, split between you</p>
        <div class="seat-price"><b>$${price(shared.seat)}</b> <span>/ seat</span></div>
        <p class="runs-line">Runs once <b>${MIN_SEATS} travellers</b> are going · nothing charged until it's confirmed</p>
        <p class="opt-desc">One AC van, split between you. Same driver, same comfort as a private transfer — for a fraction of the fare.</p>
        <ul class="pickups">${stops}</ul>
        <div data-shared-cta data-from="${esc(T.byId[from].name)}" data-to="${esc(T.byId[to].name)}" data-min="${MIN_SEATS}">
          <a class="btn btn-cta opt-cta" href="${esc(`${p}board.html?from=${encodeURIComponent(T.byId[from].name)}&to=${encodeURIComponent(T.byId[to].name)}`)}">See who's going &amp; add your name</a>
        </div>
      </article></div>`;
}

/** 07:30 → 7:30am, matching how the product pages state boarding times. */
function fmtTime(t) {
  const [h, m] = String(t).split(':');
  const H = Number(h);
  return `${((H + 11) % 12) + 1}:${m}${H < 12 ? 'am' : 'pm'}`;
}

function priceChips(q, shared) {
  const chips = [
    `<div class="pc"><span class="pc-k">Private car</span><span class="pc-v">from $${price(q.car)}</span></div>`,
    `<div class="pc"><span class="pc-k">AC van (up to 6)</span><span class="pc-v">from $${price(q.van)}</span></div>`,
  ];
  if (shared) chips.push(`<div class="pc pc-share"><span class="pc-k">Shared seat</span><span class="pc-v">from $${shared.seat}</span></div>`);
  return chips.join('');
}

function faqItems(from, to, q, shared) {
  const estimate = lowerFirst(routeEstimate(q));
  const items = [
    [`How long does the ${from} to ${to} transfer take?`,
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
    [`How do I book the ${from} to ${to} transfer?`,
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

function routePage(T, content, from, to, forward) {
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

  const highlightLis = highlights.map(h => `<li>${esc(h)}</li>`).join('');
  const related = relatedRoutes(from, to);
  const relatedHtml = related.map(d => {
    const rq = T.privateQuote(d.from, d.to);
    return `<a class="rt-card" href="${p}trip/${slug(d.from, d.to)}/"><span class="rt-name">${esc(T.byId[d.from].name)} → ${esc(T.byId[d.to].name)}</span><span class="rt-meta">${routeEstimate(rq)} · from $${price(rq.car)}</span></a>`;
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
  const faqHtml = faq.map(([qq, a]) => `<div class="faq-q"><h3>${esc(qq)}</h3><p>${liveFares(esc(a))}</p></div>`).join('\n        ');
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
  /* The route hero is a POSTCARD, not a banner. It used to be a teal gradient block with
     price chips punched into it — but the chips are now real option cards below, so the
     hero's only job is to name the route and set the tone. Paper, the display face, the
     stamp and the dotted route line, per the approved prototype. */
  .route-hero{position:relative;background:linear-gradient(180deg,var(--paper,#fffdf8) 0%,var(--cream,#F0EEE5) 100%);border-bottom:1px solid var(--line,#e7e3d6);padding:30px 0 38px;overflow:hidden}
  .route-hero .wrap{position:relative}
  .route-hero h1{font-weight:700;margin:0;font-size:clamp(2rem,4.4vw,3.2rem);display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
  .route-hero h1 .arr{color:var(--accent,#63BFD6);display:inline-flex}
  /* The squiggle replaces the word "to" visually, but "<from> to <to>" IS the phrase these
     pages rank for — so the word stays in the h1 for crawlers and screen readers. */
  .vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
  .route-hero h1 .arr svg{width:34px;height:34px}
  .route-meta{display:flex;gap:22px;flex-wrap:wrap;color:var(--ink-soft,#6c6a6b);font-size:.95rem;margin-top:12px;font-weight:500}
  .route-meta span{display:inline-flex;align-items:center;gap:.45rem}
  .route-meta svg{width:16px;height:16px;color:var(--teal-deep,#08938f)}
  .route-meta svg .wp{fill:var(--saffron,#F9A429);stroke:none}
  .hero-stamp{position:absolute;right:0;top:14px;width:220px;pointer-events:none}
  @media(max-width:900px){.hero-stamp{display:none}}
  .hero-stamp .stamp{position:absolute;right:0;top:-6px;width:70px;height:84px;background:var(--paper,#fffdf8);border:1.5px dashed var(--cream-deep,#E4E0D2);border-radius:4px;transform:rotate(6deg);display:grid;place-items:center;box-shadow:0 2px 8px rgba(58,55,57,.08)}
  .hero-stamp .stamp i{width:54px;height:66px;border-radius:2px;display:grid;place-items:center;font-style:normal;font-size:1rem;background:linear-gradient(180deg,#bfe4ee 0 55%,#f6d9a0 55% 70%,#7ccbc9 70% 100%)}
  /* Design A option cards — the page's whole job. Static: a crawler sees all of it. */
  .route-options{padding:34px 0 0}
  .opt-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start}
  @media(max-width:820px){.opt-grid{grid-template-columns:1fr}}
  .opt{position:relative;background:var(--paper,#fffdf8);border:1.5px solid var(--line,#e7e3d6);border-radius:20px;padding:26px}
  .opt-tag{position:absolute;top:-12px;left:20px;background:var(--accent,#63BFD6);color:#fff;font-size:.7rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;border-radius:999px;padding:.28rem .8rem}
  .opt-tag-warm{background:var(--saffron,#F9A429)}
  .opt-tag-mute{background:var(--ink-soft,#6c6a6b)}
  .opt h2{margin:.3rem 0 .1rem;font-size:1.4rem}
  .opt-sub{font-size:.7rem;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-soft,#6c6a6b);margin:0 0 .8rem}
  .opt-desc{font-size:.94rem;color:var(--ink-soft,#6c6a6b);margin:.5rem 0 0}
  .veh{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#fff;border:1.5px solid var(--line,#e7e3d6);border-radius:13px;padding:12px 15px;margin-top:10px}
  .veh-n{font-weight:700;font-size:.97rem} .veh-n small{display:block;font-weight:400;color:var(--ink-soft,#6c6a6b);font-size:.82rem}
  .veh-p{font-weight:800;font-size:1.25rem;text-align:right} .veh-p small{display:block;font-weight:400;color:var(--ink-soft,#6c6a6b);font-size:.72rem}
  .seat-price{margin:.2rem 0 .1rem} .seat-price b{font-size:2.3rem;line-height:1} .seat-price span{color:var(--ink-soft,#6c6a6b);font-weight:600}
  .runs-line{font-size:.9rem;font-weight:600;margin:.1rem 0 .5rem}
  .pickups{list-style:none;margin:.7rem 0 0;padding:0;display:grid;gap:.25rem}
  .pickups li{font-size:.92rem;color:var(--ink-soft,#6c6a6b)}
  .pickups li b{color:var(--ink,#3A3739);display:inline-block;min-width:4.6em}
  .opt-cta{margin-top:16px;width:100%;text-align:center}
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
  .route-body{padding:52px 0}
  .route-body .lede{font-size:1.08rem;line-height:1.7;max-width:64ch}
  .route-hl{margin:22px 0 0;padding-left:1.1rem}
  .route-hl li{margin:.3rem 0}
  .faq{padding:8px 0 52px}
  .faq-q{max-width:70ch;margin:0 0 18px}
  .faq-q h3{margin:0 0 .3rem;font-size:1.05rem}
  .faq-q p{margin:0;color:var(--ink-soft,#6c6a6b)}
  .route-cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px}
  .rt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin-top:18px}
  .rt-card{display:flex;flex-direction:column;gap:4px;padding:16px 18px;border:1px solid var(--line,#e7e3d6);border-radius:14px;background:#fff;text-decoration:none;color:inherit;transition:.15s}
  .rt-card:hover{transform:translateY(-2px);box-shadow:0 10px 24px rgba(20,40,38,.08)}
  .rt-name{font-weight:700}
  .rt-meta{font-size:.85rem;color:var(--ink-soft,#6c6a6b)}
  .route-crumbs{padding:16px 0 0;font-size:.85rem}
  .route-crumbs a{color:inherit}
</style>
${jsonLd(fromName, toName, url, q, faq)}
</head>
<body>
${header}
<main>
  <section class="route-hero">
    <div class="wrap">
      <nav class="route-crumbs" aria-label="Breadcrumb"><a href="${p}index.html">Home</a> · <a href="${p}trip/">Routes</a> · ${esc(fromName)} to ${esc(toName)}</nav>
      <h1>${esc(fromName)} <span class="arr" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12c4-6 8 6 12 0 2.5-3.7 4-3 6 0"/><path d="M17 8l4 4-4 4"/></svg></span><span class="vh"> to </span>${esc(toName)}</h1>
      <div class="route-meta">
        <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M12 21s-7-5.5-7-11a7 7 0 1 1 14 0c0 5.5-7 11-7 11z"/><circle class="wp" cx="12" cy="10" r="2.6"/></svg> ${esc(estimate)}</span>
        <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M12 2.7l2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 8.9l5.9-.8z"/><circle class="wp" cx="12" cy="12" r="1.6"/></svg> 5.0 on Tripadvisor</span>
      </div>
      <div class="hero-stamp" aria-hidden="true">
        <svg viewBox="0 0 220 56" fill="none"><path d="M6 44 C58 10 144 50 208 16" stroke="#24758A" stroke-width="1.5" stroke-dasharray="1 7" stroke-linecap="round"/><circle cx="6" cy="44" r="3.5" fill="#24758A"/></svg>
        <span class="stamp"><i>🌴</i></span>
      </div>
      <div class="route-cta">
        <a class="btn btn-wa" href="https://wa.me/94779669662" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22c5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2zm0 18.15a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.24 8.24 0 1 1 6.97 3.86zm4.52-6.16c-.25-.12-1.47-.72-1.69-.8-.23-.08-.39-.12-.56.13-.16.25-.64.8-.79.97-.14.16-.29.18-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.42.08-.16.04-.31-.02-.43-.06-.12-.56-1.35-.76-1.85-.2-.48-.41-.42-.56-.43h-.48c-.16 0-.43.06-.66.31-.22.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.16 1.75 2.67 4.25 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.07.14-1.18-.06-.1-.22-.16-.47-.28z"/></svg> Chat on WhatsApp</a>
      </div>
    </div>
  </section>
  <section class="section route-options" id="top-options">
    <div class="wrap">
      ${optionCards(T, from, to, q, shared, p)}
    </div>
  </section>
  <section class="section route-body">
    <div class="wrap">
      <p class="lede">${esc(intro)}</p>
      <ul class="route-hl">${highlightLis}</ul>
    </div>
  </section>
  <section class="section faq" style="background:var(--cream-deep,#E4E0D2)">
    <div class="wrap">
      <span class="eyebrow">Good to know</span>
      <h2>${esc(fromName)} to ${esc(toName)} — questions</h2>
      <div style="margin-top:20px">
        ${faqHtml}
      </div>
      <div class="route-cta" style="margin-top:8px">
        <!-- The prices are already ON this page, so the tail CTA returns the reader to
             them rather than forwarding to search.html for a second opinion. -->
        <a class="btn btn-primary" href="#top-options">See your options</a>
      </div>
    </div>
  </section>
  <section class="section">
    <div class="wrap">
      <h2>Related routes</h2>
      <div class="rt-grid">${relatedHtml}</div>
      <p style="margin-top:14px"><a href="${p}trip/">See all Sri Lanka transfer routes →</a></p>
    </div>
  </section>
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

// A handful of small line icons reused across the index's hero chips and trust strip.
// Kept local (not a shared map) because nothing else on the generated pages needs them.
const IX_ICON = {
  pin: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-5.5-7-11a7 7 0 1 1 14 0c0 5.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  tag: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 12.5V4.5h8l9 9-8 8z"/><circle cx="8" cy="9" r="1.4"/></svg>',
  star: '<svg viewBox="0 0 24 24" width="15" height="15" fill="#F9A429" stroke="none" aria-hidden="true"><path d="M12 2.5l2.9 6.1 6.6.9-4.8 4.6 1.2 6.6L12 17.5l-5.9 3.2 1.2-6.6-4.8-4.6 6.6-.9z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5.5c0 4.5-3 8-7 9.5-4-1.5-7-5-7-9.5V6z"/><path d="M9 12l2.2 2.2L15.2 10"/></svg>',
  snow: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/></svg>',
  undo: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h10a5.5 5.5 0 0 1 0 11H9"/><path d="M8 5L4 9l4 4"/></svg>',
  chat: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-11.8 7L4 20l1.5-4.2A8 8 0 1 1 20 11.5z"/></svg>',
};

/** One row inside an origin's destination list: `a.dest` carrying the live-price hook. */
function destRow(T, from, to, p) {
  const q = T.privateQuote(from, to);
  const shared = T.sharedOption(from, to);
  const fromName = T.byId[from].name, toName = T.byId[to].name;
  return `<li><a class="dest" href="${p}trip/${slug(from, to)}/">
        <span class="to"><em aria-hidden="true">→</em>${esc(toName)}${shared ? `<span class="sh">Shared seat $${price(shared.seat)}</span>` : ''}</span>
        <span class="est">${esc(routeEstimate(q))}</span>
        <span class="pr">from <b data-list-fare data-from-name="${esc(fromName)}" data-to-name="${esc(toName)}">$${price(q.car)}</b></span>
      </a></li>`;
}

/** One origin's whole section: its photo, heading and destination list. */
function originSection(T, photos, allDirs, id, p) {
  const rs = allDirs.filter(d => d.from === id).sort((a, b) => T.byId[a.to].name.localeCompare(T.byId[b.to].name));
  const photo = photoFor(photos, id);
  return `<section class="origin" id="from-${id}" data-origin="${id}">
      <div class="origin-head">
        ${imgTag(photo, { p, sizes: '(max-width:900px) 64px, 200px' })}
        <div><h2>From ${esc(T.byId[id].name)}</h2><span>${rs.length} route${rs.length === 1 ? '' : 's'}</span></div>
      </div>
      <ul class="dests">${rs.map(d => destRow(T, d.from, d.to, p)).join('')}</ul>
    </section>`;
}

/** A "Most booked" card — `.rt-card.pop`, deliberately not `.dest`, so a route can appear here
    AND in its origin's list without breaking the "linked exactly once" invariant. */
function popCard(T, photos, from, to, p) {
  const q = T.privateQuote(from, to);
  const shared = T.sharedOption(from, to);
  const fromName = T.byId[from].name, toName = T.byId[to].name;
  const photo = photoFor(photos, to);
  return `<a class="rt-card pop" href="${p}trip/${slug(from, to)}/">
      ${shared ? `<span class="seatbadge">Shared seat $${price(shared.seat)}</span>` : ''}
      ${imgTag(photo, { p, sizes: '(max-width:900px) 50vw, 25vw' })}
      <span class="bd">
        <span class="nm">${esc(fromName)} → ${esc(toName)}</span>
        <span class="est">${esc(routeEstimate(q))}</span>
        <span class="fr">from <b data-list-fare data-from-name="${esc(fromName)}" data-to-name="${esc(toName)}">$${price(q.car)}</b> fixed</span>
      </span>
    </a>`;
}

/** The "Leaving from" jump-chip row — plain anchors to each origin's #from-<id>, so the filter
    works before (and without) the JS that a later task adds. */
function fromChip(T, id) {
  return `<a class="fchip" href="#from-${id}" data-from="${id}">${esc(T.byId[id].name)}</a>`;
}

/* Hero picker: NOT a fourth place picker. The home hero's widget is wired by an inline script
   plus site.js/transfers-data.js/maps and isn't reusable without editing site.js (out of scope
   for this page), so this is a plain GET form straight to search.html — two text inputs sharing
   one datalist of every catalogue place NAME (all 19 — not just the 11 this index groups by),
   with search.html doing exactly what it already does for a Google-picked destination name:
   T.place(id) fails to match a name, so the route asks the live pricing engine for it instead of
   the instant catalogue quote (see search.js's own comment on this at its `engineRoute` line) —
   already a normal, tested state on that page, not a hole this form falls into. */
function faresForm(T, p) {
  // F4 fix: search.js resolves from/to by catalogue ID (T.place(id)); a typed NAME falls to
  // the engine path where shared=null — the search result then never shows the shared-seat
  // card, even on a corridor that sells one. data-id lets trip-index.js recover the id behind
  // an exact-match name at submit time, additively (a free-typed place still submits its text
  // unchanged, and everything here still works with JS off).
  const options = T.PLACES.map(pl => `<option value="${esc(pl.name)}" data-id="${esc(pl.id)}">`).join('');
  return `<form class="ix-form" action="${p}search.html" method="get">
        <div class="pick"><label for="ix-from">Pick-up</label><input id="ix-from" name="from" type="text" list="ix-places" placeholder="Where from?" required autocomplete="off"></div>
        <div class="pick"><label for="ix-to">Drop-off</label><input id="ix-to" name="to" type="text" list="ix-places" placeholder="Where to?" required autocomplete="off"></div>
        <datalist id="ix-places">${options}</datalist>
        <button type="submit" class="btn btn-cta">See prices &amp; book</button>
      </form>`;
}

function tripIndex(T, photos) {
  const { header, footer, headAssets, bootScript } = renderChrome({ depth: 1 });
  const p = '../';
  const dirs = allDirections();
  for (const d of dirs) {
    if (!ORIGIN_ORDER.includes(d.from)) throw new Error(`tripIndex: origin "${d.from}" is missing from ORIGIN_ORDER — add it or this place's routes vanish from the index`);
  }

  const heroPhoto = photoFor(photos, '_index');
  const popHtml = POPULAR_ROUTES.map(([from, to]) => popCard(T, photos, from, to, p)).join('');
  const chipsHtml = ORIGIN_ORDER.map(id => fromChip(T, id)).join('');
  const originsHtml = ORIGIN_ORDER.map(id => originSection(T, photos, dirs, id, p)).join('');

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
  /* Approved prototype: docs/superpowers/specs/2026-09-21-trip-pages-redesign-design.md,
     renderIndex() + its "routes index" CSS block. Ported faithfully; classes renamed only where
     the site already has a name for the thing (.rt → .rt-card, matching routePage()'s related-
     routes cards and the no-.rt-card-on-index guard in static-chrome-crawlable.test.js). Nothing
     here overlaps the header: unlike the hand-written pages, a generated page's <header> is a
     normal in-flow element (no [data-header] sticky wrapper), so the hero sits under it, not
     behind it — true of the LAYOUT, but the section must never carry the bare 'hero' class to
     get there (see the F3 note just below: site.css itself reaches in and undoes it). */
  /* F3 fix: this section used to be class="hero ix-hero", picking up site.css's OWN
     'body .hero{margin-top:-62px;padding-top:62px}' at <=600px — a rule meant for the HOME
     hero, which slides behind a transparent, fixed nav. This page's header is plain in-flow
     (see the note above), so that negative margin just pulled the section up UNDER the header
     instead, clipping/overlapping it. Fix: the section is 'ix-hero'-only now, and every rule
     that used to hang off the shared '.hero' selector below is scoped to '.ix-hero' instead.
     '.hero-copy'/'.hero-sub'/'.hero-media' were left alone — site.css defines none of them. */
  /* Fix 1 (coordinator review): .ix-hero itself must NOT clip. The .fares card is designed to
     overlap the hero's bottom edge (negative margin, like the prototype and the home booking
     widget) — overflow:hidden on .ix-hero clipped that overlap along with everything below it
     (the submit button sliced in half, the fine print invisible). The photo + gradient are the
     only things that ever need clipping (that's what overflow:hidden was for), so they get
     their own absolutely-positioned wrapper with its own clip; .ix-hero itself stays
     overflow:visible. */
  .ix-hero{position:relative;color:#fff;background:#23302b;isolation:isolate}
  /* hero-media itself gets a z-index (to sit behind .wrap in .ix-hero's isolated stacking
     context), which means it establishes its OWN stacking context for its two children — so
     they need their own explicit order too, or ::before (generated first, so painted first/
     furthest back with an auto z-index) loses to the later <img> in DOM order and the photo
     paints OVER the gradient instead of under it. Same -2/-1 relationship as before the fix,
     just scoped one level deeper. */
  .hero-media{position:absolute;inset:0;overflow:hidden;z-index:-2}
  .hero-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-2}
  .hero-media::before{content:"";position:absolute;inset:0;z-index:-1;
    background:linear-gradient(90deg,rgba(20,28,26,.78) 0%,rgba(20,28,26,.5) 48%,rgba(20,28,26,.12) 100%),
               linear-gradient(0deg,rgba(20,28,26,.55),rgba(20,28,26,0) 45%)}
  .ix-hero .wrap{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:48px;align-items:end;padding-block:56px 0}
  .hero-copy{padding-bottom:74px;min-height:340px;display:flex;flex-direction:column;gap:16px}
  .ix-hero .eyebrow{color:#fff}
  .ix-hero .eyebrow::before{background:var(--saffron,#F9A429)}
  .ix-hero h1{color:#fff;font-size:clamp(2.3rem,5.2vw,4.1rem);margin:0}
  .hero-sub{max-width:34rem;font-size:1.02rem;color:rgba(255,255,255,.92);margin:0}
  .chips{display:flex;flex-wrap:wrap;gap:8px;list-style:none;margin:4px 0 0;padding:0}
  .chips li{display:flex;align-items:center;gap:7px;padding:7px 13px;border-radius:999px;font-size:.8rem;font-weight:500;
    background:rgba(20,28,26,.55);border:1px solid rgba(255,255,255,.22)}
  .chips svg{width:15px;height:15px;flex:none}

  .fares{background:var(--paper,#fffdf8);color:var(--ink,#3A3739);border-radius:22px;padding:22px;margin-bottom:-64px;
    box-shadow:0 24px 60px -18px rgba(30,40,36,.45),0 2px 0 rgba(255,255,255,.6) inset;display:flex;flex-direction:column;gap:12px;position:relative;z-index:2}
  .fares h2{font-size:1.35rem;margin:0}
  .fares .kick{font-size:.68rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-soft,#6c6a6b)}
  .ix-form{display:flex;flex-direction:column;gap:12px}
  .pick{display:flex;flex-direction:column;gap:6px}
  .pick label{font-size:.66rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-soft,#6c6a6b)}
  .pick input{width:100%;font:inherit;font-size:.95rem;padding:13px 14px;border:1.5px solid var(--line,#e7e3d6);border-radius:12px;background:#fff;color:var(--ink,#3A3739)}
  .fine{font-size:.76rem;color:var(--ink-soft,#6c6a6b);text-align:center;margin:0}

  .trust{background:#22302F;color:#fff}
  /* Fix 2 (review): the .fares card overlaps DOWN into this strip (its whole point — see the
     Fix 1 comment above), so the row needs the prototype's own width reservation for it or the
     last item runs under the card instead of wrapping to a second line. 440px ~= the card's
     400px column + its 48px gap from .ix-hero .wrap's grid-template-columns above. Restored at
     ≤900px, where the card no longer floats beside the strip in a way that needs clearing. */
  .trust ul{list-style:none;margin:0;padding:18px 0;display:flex;flex-wrap:wrap;gap:10px 30px;font-size:.82rem;font-weight:500;max-width:calc(100% - 440px)}
  .trust li{display:flex;align-items:center;gap:8px}
  .trust svg{width:16px;height:16px;color:var(--blue,#63BFD6)}

  .band{padding-block:56px}
  .sec-head{display:flex;flex-direction:column;gap:12px;margin-bottom:34px}
  .sec-head h2{font-size:clamp(1.8rem,3.4vw,2.6rem);margin:0}

  /* F1 fix: the container needs its OWN class. '.pop' used to be both the grid container
     AND the card modifier ('a.rt-card.pop') — the container's 'gap:18px' matched every card
     too (a flex column), inserting an 18px blank band between each card's photo and its text.
     '.pop-grid' is the container only; '.pop' stays a pure card modifier (still 'a.rt-card.pop',
     not '.dest' — web-tests/unit/trip-index.test.js relies on that). */
  .pop-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}
  .rt-card{position:relative;display:flex;flex-direction:column;background:var(--paper,#fffdf8);border:1px solid var(--line,#e7e3d6);border-radius:18px;overflow:hidden;text-decoration:none;color:inherit;transition:transform .2s,box-shadow .2s}
  .rt-card:hover{transform:translateY(-3px);box-shadow:0 18px 34px -18px rgba(30,40,36,.45)}
  @media(prefers-reduced-motion:reduce){.rt-card{transition:none}.rt-card:hover{transform:none}}
  .rt-card img{display:block;width:100%;height:auto;aspect-ratio:16/10;object-fit:cover;max-width:100%}
  .rt-card .bd{padding:14px 16px 16px;display:flex;flex-direction:column;gap:3px}
  .rt-card .nm{font-family:var(--display,'Bodoni Moda',Georgia,serif);font-weight:700;font-size:1.12rem;line-height:1.2}
  /* F2 fix: was '.mt', which collided with site.css's own '.mt{margin-top:20px}' utility —
     every estimate span (here and in .dests below) picked up an unwanted 20px top margin.
     '.est' is free (grepped site.css first). */
  .rt-card .est{font-size:.78rem;color:var(--ink-soft,#6c6a6b)}
  .rt-card .fr{margin-top:8px;font-size:.84rem}
  .rt-card .fr b{font-size:1.08rem}
  .rt-card .seatbadge{position:absolute;top:10px;right:10px;background:var(--saffron,#F9A429);color:#3a2a08;border-radius:999px;padding:4px 10px;font-size:.66rem;font-weight:700}

  .fromsticky{position:sticky;top:0;z-index:20;background:var(--cream,#F0EEE5);border-block:1px solid var(--line,#e7e3d6)}
  .fromsticky .wrap{display:flex;align-items:center;gap:14px;padding-block:12px}
  /* Fix 1 (coordinator review, bug 2): a flex item shrinks by default even with
     white-space:nowrap, so at a narrow-enough width the label itself lost letters ("LEAVING
     FROI") while the chip row next to it still had room to scroll. flex:none takes it out of
     the shrink calculation entirely — the chips are what scroll, never the label. */
  .fromsticky .lbl{flex:none;font-size:.68rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-soft,#6c6a6b);white-space:nowrap}
  .fchips{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;padding-block:2px}
  .fchips::-webkit-scrollbar{display:none}
  .fchips a{flex:none;border:1px solid #d5d0bf;background:var(--paper,#fffdf8);border-radius:999px;padding:8px 15px;font-size:.84rem;font-weight:500;text-decoration:none;color:inherit}
  /* Pressed state for trip-index.js's filter (progressive enhancement — with JS off,
     [aria-pressed] is never set, so every chip stays unstyled and plain-anchor-shaped). */
  .fchips a[aria-pressed="true"]{background:var(--ink,#3A3739);border-color:var(--ink,#3A3739);color:#fff}

  .origins{display:flex;flex-direction:column;gap:46px;padding-block:48px 84px}
  /* F5 fix: arriving at #from-<id> (hash link, bookmark, or back/forward) used to land with
     the block's top ~35px behind .fromsticky (position:sticky;top:0, measured 71px tall once it's
     pinned to the very top of the viewport — the header itself is NOT sticky on a generated
     page, see the note above). scroll-margin-top makes the browser's own "scroll to fragment"
     step (which the CSSOM View spec ties to scroll-margin, same as scrollIntoView()) leave
     room for the sticky row — no JS required, so it fixes the no-JS path too. #routes gets
     the same treatment for the "Everywhere" chip's plain #routes anchor. CSS cannot read
     another element's height, so 92px is that 71px plus ~20px of slack: a larger default font
     grows the row, and a 5px margin would put the block's top back behind it. */
  #routes,.origin{scroll-margin-top:92px}
  .origin{display:grid;grid-template-columns:200px minmax(0,1fr);gap:34px;align-items:start}
  /* trip-index.js's filter sets the hidden attribute on a block. The cascade sorts by
     ORIGIN before specificity: any normal author rule beats a normal user-agent rule
     no matter what each one's specificity is, so .origin{display:grid} above (an
     author rule) always wins over the browser's own [hidden]{display:none} default
     (a user-agent rule) — without this it loses regardless, and a "hidden" block
     stays visible. .origin[hidden] is itself an author rule, so it outranks .origin
     the ordinary way (specificity, both being author-origin now). */
  .origin[hidden]{display:none}
  .origin-head{display:flex;flex-direction:column;gap:6px}
  .origin-head img{display:block;width:100%;height:auto;aspect-ratio:16/10;object-fit:cover;border-radius:18px;max-width:100%}
  .origin-head h2{font-size:1.5rem;margin:8px 0 0}
  .origin-head span{font-size:.8rem;color:var(--ink-soft,#6c6a6b)}
  .dests{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 34px;border-top:1px solid #d5d0bf}
  .dests a{display:grid;grid-template-columns:1fr auto;align-items:center;gap:4px 14px;padding:14px 4px;border-bottom:1px solid #d5d0bf;text-decoration:none;color:inherit}
  .dests a:hover .to{color:var(--blue-deep,#24758A)}
  .dests .to{font-weight:600;font-size:1rem;line-height:1.3}
  .dests .to em{font-style:normal;color:var(--blue-deep,#24758A);margin-right:6px}
  .dests .est{font-size:.78rem;color:var(--ink-soft,#6c6a6b)}
  .dests .pr{grid-row:1/3;grid-column:2;text-align:right;font-size:.76rem;color:var(--ink-soft,#6c6a6b);font-variant-numeric:tabular-nums;white-space:nowrap}
  .dests .pr b{font-size:1.08rem;color:var(--ink,#3A3739)}
  .dests .sh{display:inline-block;margin-left:8px;background:#FDF0D6;color:#8A5A06;border-radius:999px;padding:2px 9px;font-size:.68rem;font-weight:700;vertical-align:1px}

  .anywhere{background:#22302F;color:#fff}
  .anywhere .wrap{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:30px;align-items:center;padding-block:56px}
  .anywhere h2{font-size:clamp(1.7rem,3.2vw,2.4rem);margin:0}
  .anywhere p{color:rgba(255,255,255,.78);margin-top:10px;max-width:36rem}
  .anywhere .acts{display:flex;flex-wrap:wrap;gap:12px}
  .btn-line{border:1.5px solid rgba(255,255,255,.4);color:#fff;background:transparent}

  @media(max-width:900px){
    .ix-hero .wrap{grid-template-columns:1fr;gap:0;padding-block:18px 0}
    .hero-copy{padding-bottom:56px;gap:12px;min-height:250px}
    .fares{margin-bottom:22px;margin-top:-36px;padding:18px}
    .trust ul{gap:8px 18px;font-size:.78rem;max-width:none}
    .band{padding-block:36px}
    .pop-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .fromsticky{position:static}
    .fromsticky .lbl{display:none}
    .fchips{padding-inline:0}
    /* F5: the sticky row is 'position:static' down here, so it can no longer sit over an
       anchor target — nothing to clear. */
    #routes,.origin{scroll-margin-top:0}
    .origins{gap:36px;padding-block:32px 54px}
    .origin{grid-template-columns:1fr;gap:12px}
    .origin-head{flex-direction:row;align-items:center;gap:14px}
    .origin-head img{width:64px;height:64px;aspect-ratio:1;border-radius:14px}
    .origin-head h2{margin-top:0;font-size:1.35rem}
    .dests{grid-template-columns:1fr}
    .anywhere .wrap{grid-template-columns:1fr;padding-block:40px}
  }
</style>
</head>
<body>
${header}
<main>
  <section class="ix-hero">
    <div class="hero-media">${imgTag(heroPhoto, { p, sizes: '100vw', eager: true, cls: 'hero-img' })}</div>
    <div class="wrap">
      <div class="hero-copy">
        <span class="eyebrow">Sri Lanka, door to door</span>
        <h1>Sri Lanka transfer routes</h1>
        <p class="hero-sub">Fixed-price private transfers on the island's most-travelled roads — and a shared seat where we run one. Pick a route for the price, the distance and what the drive is like.</p>
        <ul class="chips">
          <li>${IX_ICON.pin}${dirs.length} routes</li>
          <li>${IX_ICON.tag}Fixed prices</li>
          <li>${IX_ICON.star}5.0 on Tripadvisor</li>
        </ul>
      </div>
      <aside class="fares" aria-label="Find a route">
        <div><div class="kick">Any two points, door to door</div><h2>Where are you going?</h2></div>
        ${faresForm(T, p)}
        <p class="fine">Not on the list below? We still drive it.</p>
      </aside>
    </div>
  </section>
  <div class="trust"><div class="wrap"><ul>
    <li>${IX_ICON.shield}Fully insured &amp; safe drivers</li>
    <li>${IX_ICON.snow}AC cars &amp; vans</li>
    <li>${IX_ICON.undo}Free cancellation 24h before</li>
    <li>${IX_ICON.chat}WhatsApp support 7 days</li>
  </ul></div></div>

  <section class="band" style="padding-bottom:24px"><div class="wrap">
    <div class="sec-head"><span class="eyebrow">Most booked</span><h2>Where most trips start</h2></div>
    <div class="pop-grid">${popHtml}</div>
  </div></section>

  <div class="fromsticky"><div class="wrap">
    <span class="lbl">Leaving from</span>
    <div class="fchips" role="group" aria-label="Leaving from">
      <a class="fchip" href="#routes" data-from="">Everywhere</a>
      ${chipsHtml}
    </div>
  </div></div>

  <div class="wrap origins" id="routes">${originsHtml}</div>

  <section class="anywhere"><div class="wrap">
    <div><h2>Going somewhere that isn't listed?</h2><p>These are the roads we drive most. We price any two points in Sri Lanka, door to door — or string several stops into one trip.</p></div>
    <div class="acts">
      <a class="btn btn-cta" href="${p}search.html">Get a fixed price</a>
      <a class="btn btn-line" href="${p}plan.html">Plan a multi-stop trip</a>
    </div>
  </div></section>
</main>
${footer}
${bootScript}
<script src="${p}${assetV('trip-index.js')}"></script>
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
    out.set(`trip/${slug(a, b)}/index.html`, routePage(T, content, a, b, true));
    out.set(`trip/${slug(b, a)}/index.html`, routePage(T, content, b, a, false));
  }
  out.set('trip/index.html', tripIndex(T, photos));
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
