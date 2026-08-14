import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadTransfers } from './load-transfers.mjs';
import { renderChrome } from './site-chrome.mjs';

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

function priceChips(q, shared) {
  const chips = [
    `<div class="pc"><span class="pc-k">Private car</span><span class="pc-v">from $${price(q.car)}</span></div>`,
    `<div class="pc"><span class="pc-k">AC van (up to 6)</span><span class="pc-v">from $${price(q.van)}</span></div>`,
  ];
  if (shared) chips.push(`<div class="pc pc-share"><span class="pc-k">Shared seat</span><span class="pc-v">from $${shared.seat}</span></div>`);
  return chips.join('');
}

function faqItems(from, to, q, shared) {
  const items = [
    [`How long does the ${from} to ${to} transfer take?`,
      `The drive is about ${humanDuration(q.duration)} on ${q.km} km of road. Your driver takes the fastest safe route and can add stops along the way.`],
    [`How much is a taxi from ${from} to ${to}?`,
      `A private car is from $${price(q.car)} and an air-conditioned van (up to 6 people) from $${price(q.van)}, fixed and door to door — the price you see is the price you pay.${shared ? ` A shared seat is from $${shared.seat} per person.` : ''}`],
    shared
      ? [`Is there a cheaper shared option?`, `Yes — this route runs on our ${shared.corridorLabel.replace(/\s*→\s*/g, '–')} shared service (${shared.freqText}). A single seat is from $${shared.seat}, ideal for solo travellers and couples happy to share.`]
      : [`Is there a shared option on this route?`, `This corridor is private-only, so you get the whole vehicle to yourself. If you'd like a shared seat, message us and we'll suggest the nearest shared service.`],
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
    serviceType: 'Private airport & intercity transfer',
    name: `${from} to ${to} private transfer`,
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
  const url = `${ORIGIN}/trip/${slug(from, to)}/`;
  const { header, footer, headAssets, bootScript } = renderChrome({ depth: 2 });
  const p = '../../';

  // Private-only routes must never promise a seat in the SERP, so the shared half is added ONLY
  // where a shared seat genuinely exists on this corridor — matching the H1 and the price chips.
  const title = shared
    ? `${fromName} to ${toName} — transfer & shared seat from $${shared.seat} | Ceylon Hop`
    : `${fromName} to ${toName} — private transfer | Ceylon Hop`;
  const desc = `Private car or AC van from ${fromName} to ${toName} at a fixed price — ${q.km} km, about ${humanDuration(q.duration)}, door to door.${shared ? ` Or share a seat from $${shared.seat}.` : ' Rated 5.0 on Tripadvisor.'}`;
  const faq = faqItems(fromName, toName, q, shared);

  const highlightLis = highlights.map(h => `<li>${esc(h)}</li>`).join('');
  const related = relatedRoutes(from, to);
  const relatedHtml = related.map(d => {
    const rq = T.privateQuote(d.from, d.to);
    return `<a class="rt-card" href="${p}trip/${slug(d.from, d.to)}/"><span class="rt-name">${esc(T.byId[d.from].name)} → ${esc(T.byId[d.to].name)}</span><span class="rt-meta">${rq.km} km · from $${price(rq.car)}</span></a>`;
  }).join('');
  const faqHtml = faq.map(([qq, a]) => `<div class="faq-q"><h3>${esc(qq)}</h3><p>${esc(a)}</p></div>`).join('\n        ');

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
<style>
  .route-hero{position:relative;color:#fff;padding:104px 0 44px;margin-top:-74px;background:linear-gradient(160deg,#1E6273 0%,#24758A 55%,#277F97 100%);overflow:hidden}
  .route-hero::before{content:"";position:absolute;inset:0;background:radial-gradient(60% 60% at 80% 10%,rgba(99,191,214,.5),transparent 70%),radial-gradient(50% 50% at 10% 90%,rgba(30,98,115,.6),transparent 70%)}
  .route-hero .wrap{position:relative}
  .route-hero h1{color:#fff;font-weight:700;max-width:16ch;margin:0 0 .5rem}
  .route-hero .sub{color:rgba(255,255,255,.92);max-width:52ch;margin:0 0 1.4rem}
  .price-chips{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 1.4rem}
  .pc{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);border-radius:14px;padding:10px 14px;min-width:120px}
  .pc-k{display:block;font-size:.74rem;text-transform:uppercase;letter-spacing:.04em;color:rgba(255,255,255,.85)}
  .pc-v{display:block;font-size:1.15rem;font-weight:800}
  .pc-share{background:rgba(255,214,140,.2);border-color:rgba(255,214,140,.5)}
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
      <nav class="route-crumbs" aria-label="Breadcrumb" style="color:rgba(255,255,255,.8)"><a href="${p}index.html" style="color:inherit">Home</a> · <a href="${p}trip/" style="color:inherit">Routes</a> · ${esc(fromName)} to ${esc(toName)}</nav>
      <h1>${esc(fromName)} to ${esc(toName)}</h1>
      <p class="sub">Private transfer${shared ? ' &amp; shared ride' : ''} — ${q.km} km, about ${humanDuration(q.duration)} door to door.</p>
      <div class="price-chips">${priceChips(q, shared)}</div>
      <div class="route-cta">
        <a class="btn btn-cta" href="${p}search.html?from=${from}&to=${to}">See prices &amp; book</a>
        <a class="btn btn-wa" href="https://wa.me/94779669662" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22c5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2zm0 18.15a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.24 8.24 0 1 1 6.97 3.86zm4.52-6.16c-.25-.12-1.47-.72-1.69-.8-.23-.08-.39-.12-.56.13-.16.25-.64.8-.79.97-.14.16-.29.18-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.42.08-.16.04-.31-.02-.43-.06-.12-.56-1.35-.76-1.85-.2-.48-.41-.42-.56-.43h-.48c-.16 0-.43.06-.66.31-.22.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.16 1.75 2.67 4.25 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.07.14-1.18-.06-.1-.22-.16-.47-.28z"/></svg> Chat on WhatsApp</a>
      </div>
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
        <a class="btn btn-primary" href="${p}search.html?from=${from}&to=${to}">Get your fixed price</a>
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
    return `<a class="rt-card" href="${p}trip/${slug(from, to)}/"><span class="rt-name">${esc(T.byId[from].name)} → ${esc(T.byId[to].name)}</span><span class="rt-meta">${q.km} km · from $${price(q.car)}</span></a>`;
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
  const out = new Map();
  for (const [a, b] of BASE_PAIRS) {
    out.set(`trip/${slug(a, b)}/index.html`, routePage(T, content, a, b, true));
    out.set(`trip/${slug(b, a)}/index.html`, routePage(T, content, b, a, false));
  }
  out.set('trip/index.html', tripIndex(T, content));
  // terms/privacy are added to the sitemap in Unit 2 (Task 2.4) via SITEMAP_EXTRA.
  out.set('sitemap.xml', sitemap(SITEMAP_EXTRA));
  return out;
}

// Static pages that live outside the route generator but belong in the sitemap.
// The blog posts are the site's only earned rankings, so they must be listed. Trailing
// slashes are intentional — these are directory URLs and match the live WordPress ones.
// "about 2h 57m" is false precision: the number is a model, not a measurement, and two routes of
// different length were quoting the same minute. One rounding scheme for every page.
export function humanDuration(text) {
  const m = /^(?:(\d+)h)?\s*(?:(\d+)m)?$/.exec(String(text).trim());
  let mins;
  if (m && (m[1] || m[2])) mins = (Number(m[1] || 0) * 60) + Number(m[2] || 0);
  else {
    const only = /^(\d+)\s*min$/.exec(String(text).trim());
    if (!only) return String(text); // unrecognised → leave it alone
    mins = Number(only[1]);
  }
  if (mins < 60) return `${Math.round(mins / 15) * 15} minutes`;
  const halves = Math.max(2, Math.round(mins / 30));
  const h = Math.floor(halves / 2);
  return halves % 2 ? `${h}\u00bd hours` : `${h} hour${h === 1 ? '' : 's'}`;
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
