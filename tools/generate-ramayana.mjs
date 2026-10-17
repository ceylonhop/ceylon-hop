// tools/generate-ramayana.mjs
// The Ramayana trail landing page: one JSON (tools/ramayana/trail.json) → ramayana-trail-sri-lanka/index.html.
// Research and plan: reports/Ramayana trail Sri Lanka package.md (owner-approved build, 2026-10-17).
//
// Built on the destination-guide look (GUIDE_STYLE + guide-page.js): the places, two private-car trips
// with fixed "from" prices taken from the ops quote tool, when to go, temple etiquette, FAQs and
// fixed-price legs that route-list-fares.js reprices live. Stand-in photos carry an "Illustrative" label.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { renderStandalone, ORIGIN } from './render-page.mjs';
import { ROOT } from './generate-route-pages.mjs';
import { loadTransfers } from './load-transfers.mjs';
import { loadPlacePhotos, photoFor, imgTag } from './place-photos.mjs';
import { assetV, WA } from './site-chrome.mjs';
import { GUIDE_STYLE } from './generate-guides.mjs';

const require = createRequire(import.meta.url);
const { formatRouteEstimate } = require('../route-estimate.js');

export const RAMAYANA_FILE = join(ROOT, 'tools/ramayana/trail.json');
export const RAMAYANA_PATH = 'ramayana-trail-sri-lanka/';
export function loadRamayana() { return JSON.parse(readFileSync(RAMAYANA_FILE, 'utf8')); }

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const stripTags = s => String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const price = n => Number.isInteger(n) ? String(n) : n.toFixed(2);
const wa = text => `${WA}?text=${encodeURIComponent(text)}`;
/** A whole-dollar share of a car price, rounded half up ($445 for 2 → $223). */
export const perPerson = (total, n) => Math.round(total / n);

function rimg(r, key, { p, sizes, eager = false }) {
  const ph = r.photos[key];
  if (!ph) throw new Error(`ramayana: photos missing "${key}"`);
  const base = `${p}img/ramayana/${key}`;
  return `<img src="${base}-900.jpg" srcset="${base}-900.jpg 900w, ${base}-1800.jpg 1800w" sizes="${sizes}" `
    + `width="${ph.w}" height="${ph.h}" alt="${esc(ph.alt)}" style="object-position:${esc(ph.focal || '50% 50%')}" `
    + (eager ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"') + '>'
    + (ph.illustrative ? '<span class="ill">Illustrative photo</span>' : '');
}

const eyebrow = t => `<div class="eyebrow">${esc(t)}</div>`;
const sh = (eb, h2, sub) => `<div class="sh reveal">${eyebrow(eb)}<h2>${h2}</h2>${sub ? `<p>${sub}</p>` : ''}</div>`;
const fromPrice = r => Math.min(...r.trips.map(t => t.price.car));

function hero(r, p) {
  const ph = r.photos[r.hero.photo];
  return `<div class="g-hero">
    ${rimg(r, r.hero.photo, { p, sizes: '100vw', eager: true })}
    <div class="wrap">
      ${eyebrow(r.hero.eyebrow)}
      <h1>Ramayana Tour in Sri Lanka</h1>
      <p class="sub">${r.hero.sub}</p>
    </div>
    <span class="credit">Photo: ${esc(ph.credit)} / Unsplash · ${esc(r.hero.credit)}</span>
  </div>`;
}

function facts(r) {
  const items = [...r.facts.map(f => `<div class="fact"><small>${esc(f.label)}</small><b>${esc(f.value)}</b></div>`),
    `<div class="fact"><small>Private car</small><b>from $${fromPrice(r)} <span class="unit">per car</span></b></div>`];
  return `<div class="facts"><div class="wrap">${items.join('')}</div></div>`;
}

const NAV = [['sites', 'The places'], ['plan', 'Two trips'], ['when', 'When to go'], ['etiquette', 'Temples & food'], ['qa', 'Your questions'], ['next', 'Book a leg']];
const jumpNav = () => `<div class="jump" id="jump"><div class="wrap">${NAV.map(([id, label], i) =>
  `<a href="#${id}"${i === 0 ? ' class="on"' : ''}>${esc(label)}</a>`).join('')}</div></div>`;

function intro(r, p) {
  const teaser = r.trips.map(t => `<a class="tz" href="#plan"><small>${esc(t.tag)}</small><b>${esc(t.name)}</b><span>${esc(t.teaser)}</span><em>from $${t.price.car} per car <i>See the day plan ↓</i></em></a>`).join('\n      ');
  return `<section class="lede-s"><div class="wrap reveal"><p class="lede">${esc(r.lede)} <em>${esc(r.ledeEm)}</em> ${esc(r.ledeTail)}</p><span class="hand">— the Ceylon Hop team</span></div></section>
  <section class="teaser-s"><div class="wrap">
    <div class="teaser reveal">
      ${teaser}
    </div>
    <div class="trust reveal">
      <span class="pill pill-saffron">★ Tripadvisor — Excellent</span>
      <a class="tr-team" href="${p}about.html"><span class="faces"><img src="${p}img/team-roshen.jpg" alt="" width="40" height="40"><img src="${p}img/team-devan.jpg" alt="" width="40" height="40"><img src="${p}img/team-dasis.jpg" alt="" width="40" height="40"></span><span><b>A small Sri Lankan team</b><small>Meet the people behind your trip →</small></span></a>
    </div>
  </div></section>`;
}

function sites(r, p) {
  const cards = r.sites.map((s, i) => `<article class="poi${s.feature ? ' feature' : ''} reveal" id="${esc(s.id)}">
        ${rimg(r, s.photo, { p, sizes: s.feature ? '(max-width:760px) 100vw, 60vw' : '(max-width:760px) 100vw, 45vw' })}
        <span class="n">${i + 1}</span>
        <div class="bd">
          <h3>${esc(s.name)}</h3>
          <p>${s.text}</p>
          <div class="spec">${s.spec.map(([k, v]) => `<div><small>${esc(k)}</small><b>${esc(v)}</b></div>`).join('')}</div>
          ${s.tip ? `<div class="tip"><b>Our tip</b>${s.tip}</div>` : ''}
        </div>
      </article>`).join('\n      ');
  const more = r.more.map(m => `<div class="fx reveal"><span class="km">${m.n}<small>${esc(m.where)}</small></span><b>${esc(m.name)}</b><p>${m.text}</p></div>`).join('\n      ');
  return `<section class="section" id="sites"><div class="wrap">
    ${sh('The places', 'Where the story is remembered', r.sitesSub)}
    <div class="poi-list">
      ${cards}
    </div>
    <div class="sh reveal far-head"><h3 class="h2-small">More places on the trail</h3></div>
    <div class="far">
      ${more}
    </div>
    <div class="tip warn reveal r-cave"><b>${esc(r.cave.title)}</b>${r.cave.text}</div>
    <span class="checked reveal"><i></i>${esc(r.factsNote)}</span>
  </div></section>`;
}

function trips(r) {
  const days = r.trips.map(t => {
    const tl = t.plan.map(([d, title, text, us]) => `<li${us ? ' class="us"' : ''}><time>${esc(d)}</time><div><b>${esc(title)}</b><span>${esc(text)}</span></div></li>`).join('\n        ');
    return `<div class="day reveal"><h3>${esc(t.name)} · ${t.days} days</h3><p class="sub">${esc(t.sub)}</p><ul class="tl">
        ${tl}
      </ul><div class="dayfoot"><div class="pricebox"><small>Private car · driver for all ${t.days} days</small><b>$${t.price.car} per car</b><span>That’s $${perPerson(t.price.car, 2)} each for 2 · $${perPerson(t.price.car, 3)} each for 3 · Van for up to 6: $${t.price.van} ($${perPerson(t.price.van, 6)} each for 6)</span></div><div class="preload">${esc(t.note)}</div><a class="btn btn-cta" href="${wa(t.wa)}">Ask for this trip on WhatsApp</a></div></div>`;
  }).join('\n      ');
  return `<section class="section" id="plan"><div class="wrap">
    ${sh('Two ways to do it', 'Six days or eight, in your own car', r.plansSub)}
    <div class="days">
      ${days}
    </div>
    <span class="checked reveal"><i></i>${esc(r.priceNote)}</span>
  </div></section>`;
}

function when(r) {
  return `<section class="section" id="when"><div class="wrap">
    ${sh('When to go', 'Best months, and the festivals', '')}
    <div class="months">${r.months.map(m => `<div class="mo${m.kind ? ` ${m.kind}` : ''} reveal"><small>${esc(m.when)}</small><b>${esc(m.title)}</b><p>${esc(m.text)}</p>${m.tag ? `<span class="tag">${esc(m.tag)}</span>` : ''}</div>`).join('')}</div>
  </div></section>`;
}

function etiquette(r) {
  return `<section class="section" id="etiquette"><div class="wrap">
    ${sh('At the temples · on the road', 'Temples, food and comfort', '')}
    <ul class="tips reveal">${r.tips.map(t => `<li>${t}</li>`).join('')}</ul>
  </div></section>`;
}

function faq(r) {
  const tabs = r.faq.map((g, i) => `<button type="button"${i === 0 ? ' class="on"' : ''} data-g="${i}">${esc(g.tab)}</button>`).join('');
  const groups = r.faq.map((g, i) => `<div class="group${i === 0 ? ' on' : ''}">${g.items.map((q, j) =>
    `<details${i === 0 && j === 0 ? ' open' : ''}><summary>${esc(q.q)}</summary><div class="dc"><div><p>${q.a}</p></div></div></details>`).join('')}</div>`).join('\n      ');
  return `<section class="section qa" id="qa"><div class="wrap">
    ${sh('Your questions, answered', 'The things families ask us', 'Pick a topic, tap a question.')}
    <div class="qtabs" id="qtabs">${tabs}</div>
    <div class="groups">
      ${groups}
    </div>
  </div></section>`;
}

function legs(r, T, photos, p) {
  const cards = r.legs.map(([from, to]) => {
    if (!T.byId[from] || !T.byId[to]) throw new Error(`ramayana: unknown leg ${from} → ${to}`);
    const q = T.privateQuote(from, to);
    const est = formatRouteEstimate({ distanceKm: q.km, durationMin: q.durationMin, state: q.estimated ? 'estimated' : 'browse' });
    const f = T.byId[from].name, t = T.byId[to].name;
    return `<a class="rt-card" href="${p}trip/${from}-to-${to}/">${imgTag(photoFor(photos, to), { p, sizes: '(max-width:760px) 76vw, 25vw' })}<span class="rt-bd"><span class="rt-name">${esc(f)} → ${esc(t)}</span><span class="rt-meta">${est}</span><span class="rt-fare">from <b data-list-fare data-from-name="${esc(f)}" data-to-name="${esc(t)}">$${price(q.car)}</b> fixed</span><span class="rt-go">Choose date &amp; book</span></span></a>`;
  }).join('');
  return `<section class="section" id="next"><div class="wrap">
    ${sh('Just need a ride?', 'Book one leg at a fixed price', 'Doing it yourself? Every leg of the trail is a fixed-price transfer.')}
    <div class="next reveal">${cards}</div>
    <span class="swipe-hint">Swipe for more routes →</span>
    <div class="live"><i></i>Live prices from our booking engine — what you see is what you pay</div>
  </div></section>`;
}

function askBand(r) {
  return `<section class="section-tight ask"><div class="wrap">
    <div class="reveal">${eyebrow('Real people, real answers')}<h2>${esc(r.ask.heading)}</h2><p>${esc(r.ask.text)}</p></div>
    <a class="wa reveal" href="${wa(r.ask.wa)}"><i></i>Message us on WhatsApp</a>
  </div></section>`;
}

function credits(r, p) {
  const names = [...new Set(Object.values(r.photos).map(x => x.credit))];
  return `<div class="credits"><div class="wrap"><span>Photos:</span>${names.map(n => `<span>${esc(n)}</span>`).join('')}<span>— on Unsplash · <a href="${p}credits.html">all credits</a></span></div></div>`;
}

function jsonLd(r, url) {
  const org = { '@type': 'Organization', name: 'Ceylon Hop', url: `${ORIGIN}/` };
  const trip = t => ({
    '@context': 'https://schema.org', '@type': 'TouristTrip', name: t.name, description: t.description,
    touristType: ['Hindu pilgrims', 'Families'], provider: org,
    offers: { '@type': 'Offer', price: String(t.price.car), priceCurrency: 'USD', url: `${url}#plan` },
    itinerary: { '@type': 'ItemList', numberOfItems: t.stops.length, itemListElement: t.stops.map(([name, town], i) => ({
      '@type': 'ListItem', position: i + 1,
      item: { '@type': 'TouristAttraction', name, address: { '@type': 'PostalAddress', addressLocality: town, addressCountry: 'LK' } } })) },
  });
  return [
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
      { '@type': 'ListItem', position: 2, name: 'Travel Guide', item: `${ORIGIN}/blog.html` },
      { '@type': 'ListItem', position: 3, name: 'Ramayana Tour in Sri Lanka', item: url } ] },
    ...r.trips.map(trip),
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: r.faq.flatMap(g => g.items.map(q => ({
      '@type': 'Question', name: q.q, acceptedAnswer: { '@type': 'Answer', text: stripTags(q.a) } }))) },
  ].map(o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n');
}

export function renderRamayana(r, T, photos) {
  const p = '../';
  const url = `${ORIGIN}/${RAMAYANA_PATH}`;
  // Same head script as the guides: the API origin ("?api=off" / "?api=ORIGIN") and the fare hold
  // that route-list-fares.js releases.
  const head = `<script>(function(){var q=(/^(localhost|127\\.0\\.0\\.1|\\[::1\\])$|\\.(localhost|test)$/.test(location.hostname)?new URLSearchParams(location.search).get('api'):null);window.CEYLON_HOP_API=(q==='off')?'':(q||window.CEYLON_HOP_API||'https://ceylon-hop-api.onrender.com');
  if(window.CEYLON_HOP_API){var d=document.documentElement;d.classList.add('list-fares-pending');setTimeout(function(){d.classList.remove('list-fares-pending');},4500);}
  document.documentElement.classList.add('js');})();</script>`;
  return renderStandalone({
    title: esc(r.title), description: r.description, canonicalPath: `/${RAMAYANA_PATH}`, depth: 1, active: 'blog.html',
    ogImage: 'img/ramayana/og.jpg', style: GUIDE_STYLE + RAMAYANA_STYLE,
    bodyHtml: `${head}
${jsonLd(r, url)}
  ${hero(r, p)}
  ${facts(r)}
  ${jumpNav()}
  ${intro(r, p)}
  ${sites(r, p)}
  ${trips(r)}
  ${when(r)}
  ${etiquette(r)}
  ${faq(r)}
  ${legs(r, T, photos, p)}
  ${askBand(r)}
  ${credits(r, p)}
<script src="${p}${assetV('route-list-fares.js')}"></script>
<script src="${p}${assetV('guide-page.js')}"></script>`,
  });
}

export function generateRamayana() {
  return new Map([[`${RAMAYANA_PATH}index.html`, renderRamayana(loadRamayana(), loadTransfers(), loadPlacePhotos())]]);
}

// Page-only additions on top of GUIDE_STYLE (namespaced where a bare class could collide with the chrome).
const RAMAYANA_STYLE = `
  .poi .ill{position:absolute;top:16px;right:16px;background:rgba(20,30,28,.62);color:#fff;font-size:.66rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;border-radius:999px;padding:.3rem .65rem}
  .teaser-s{padding:28px 0 0}
  .teaser{display:grid;gap:14px}
  @media(min-width:760px){.teaser{grid-template-columns:1fr 1fr;gap:20px}}
  .tz{display:flex;flex-direction:column;gap:4px;background:var(--paper);border-radius:var(--r-lg);box-shadow:var(--shadow);padding:20px 22px;text-decoration:none;color:inherit;border:1.5px solid transparent;transition:border-color .2s,transform .2s}
  .tz:hover{border-color:var(--accent);transform:translateY(-2px)}
  .tz small{font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft);font-weight:600}
  .tz b{font-family:var(--display);font-size:1.45rem;line-height:1.15}
  .tz span{font-size:.92rem;color:var(--ink-soft)}
  .tz em{font-style:normal;font-weight:600;margin-top:8px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
  .tz em i{font-style:normal;color:var(--accent-deep);font-size:.88rem}
  .trust{display:flex;flex-wrap:wrap;gap:14px 28px;align-items:center;margin-top:18px}
  .tr-team{display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit}
  .tr-team .faces{display:flex}.tr-team .faces img{width:40px;height:40px;border-radius:50%;object-fit:cover;border:2px solid var(--cream);margin-left:-10px}.tr-team .faces img:first-child{margin-left:0}
  .tr-team b{display:block;font-size:.92rem}.tr-team small{font-size:.8rem;color:var(--accent-deep);font-weight:600}
  .r-cave{max-width:46rem;margin-top:28px}
  #plan .checked{margin-top:22px}
  .pricebox{background:var(--pc-sky);border-radius:14px;padding:14px 16px}
  .pricebox small{display:block;font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft);font-weight:600}
  .pricebox b{display:block;font-family:var(--display);font-size:1.6rem;line-height:1.2;margin:.15rem 0}
  .pricebox span{font-size:.86rem;color:var(--ink-soft)}
  .tips li b{font-weight:600}
  @media(prefers-reduced-motion:reduce){.tz{transition:none}}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [rel, html] of generateRamayana()) {
    const abs = join(ROOT, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, html);
  }
  console.log('generated the Ramayana trail page');
}
