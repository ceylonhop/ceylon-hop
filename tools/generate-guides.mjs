// tools/generate-guides.mjs
// Destination guides: one JSON per destination in tools/guides/, one generated page at
// guides/<slug>/index.html. Design: docs/superpowers/specs/2026-09-28-destination-guides-design.md
//
// The page is rendered through renderStandalone() so header, footer, <head> assets, analytics
// and the error beacon are byte-identical to every other generated page. Where-next cards are
// the trip pages' a.rt-card markup, so route-list-fares.js prices them live without changes.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
const mapsUrl = q => `https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(q)}`;

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

const SPEC_LABELS = { from: 'From town', open: 'Open', give: 'Give it', level: 'Effort', ticket: 'Ticket' };
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
      ${sh('Where to eat', 'Eat', esc(g.eatSub || 'Nothing fancy on this list unless it earns it. Cash for most places.'))}
      ${placeRow(g, g.eat, g.eatCollector, p, true)}
    </div>
    <div class="es-block">
      ${sh('Where to stay', 'Stay', esc(g.staySub || 'Nights are cold and most places don’t have heating — ask for extra blankets wherever you stay.'))}
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

/** Every rate-card corridor that touches the destination, outbound first, then the way in —
    or, when the guide lists `next` (a hub like Ella has too many corridors for one row), just the
    outbound legs to those places, in that order. Byte-compatible with the trip pages' cards so
    route-list-fares.js prices them live. */
function whereNext(g, T, placePhotos, p) {
  const id = g.placeId;
  const legs = [];
  const onCorridor = to => BASE_PAIRS.some(([a, b]) => (a === id && b === to) || (b === id && a === to));
  if (g.next) {
    for (const to of g.next) {
      if (!onCorridor(to)) throw new Error(`guide "${g.slug}": next "${to}" is not a BASE_PAIRS corridor from "${id}"`);
      legs.push([id, to]);
    }
  } else {
    for (const [a, b] of BASE_PAIRS) { if (a === id) legs.push([a, b]); else if (b === id) legs.push([b, a]); }
    for (const [a, b] of BASE_PAIRS) { if (a === id) legs.push([b, a]); else if (b === id) legs.push([a, b]); }
  }
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

function jsonLd(g, url) {
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

  // Runs before anything below it paints: the API origin ("?api=off" / "?api=ORIGIN", the same
  // contract as the trip pages) and the Where-next fare hold that route-list-fares.js releases.
  const head = `<script>(function(){var q=new URLSearchParams(location.search).get('api');window.CEYLON_HOP_API=(q==='off')?'':(q||window.CEYLON_HOP_API||'https://ceylon-hop-api.onrender.com');
  if(window.CEYLON_HOP_API){var d=document.documentElement;d.classList.add('list-fares-pending');setTimeout(function(){d.classList.remove('list-fares-pending');},4500);}
  document.documentElement.classList.add('js');})();</script>`;

  return renderStandalone({
    title: g.title, description: g.description, canonicalPath: `/${guidePath(g.slug)}`, depth: 2, active: 'blog.html',
    ogImage: `img/guides/${g.slug}/og.jpg`, // 1200×630 cut of the hero, so shared links unfurl with it
    style: GUIDE_STYLE,
    bodyHtml: `${head}
${jsonLd(g, url)}
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
  .g-hero h1{color:#fff;font-size:clamp(3.2rem,10vw,6.4rem);line-height:.98;margin:0 0 .5rem;font-variation-settings:"opsz" 11;text-shadow:0 2px 24px rgba(0,0,0,.25)}
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
    .poi.feature h3{font-size:clamp(2rem,3.4vw,2.8rem);font-variation-settings:"opsz" 11}
    .poi.feature p{font-size:1.08rem}
    .poi:not(.feature):last-child:nth-child(even){grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr}
    .poi:not(.feature):last-child:nth-child(even) img{height:100%;aspect-ratio:auto;min-height:360px}}
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
  .wa i{width:22px;height:22px;border-radius:50%;background:#0B7A44;display:inline-block} /* the site's .btn-wa green, not raw WhatsApp #25D366 (retired-hexes.test.js) */
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
  let n = 0;
  for (const [rel, html] of generateGuides()) {
    const abs = join(ROOT, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, html);
    n++;
  }
  console.log(`generated ${n} guide pages`);
}
