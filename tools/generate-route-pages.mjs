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

function priceChips(q, shared) {
  const chips = [
    `<div class="pc"><span class="pc-k">Private car</span><span class="pc-v">from $${q.car}</span></div>`,
    `<div class="pc"><span class="pc-k">AC van (up to 6)</span><span class="pc-v">from $${q.van}</span></div>`,
  ];
  if (shared) chips.push(`<div class="pc pc-share"><span class="pc-k">Shared seat</span><span class="pc-v">from $${shared.seat}</span></div>`);
  return chips.join('');
}

function faqItems(from, to, q, shared) {
  const items = [
    [`How long does the ${from} to ${to} transfer take?`,
      `The drive is about ${q.duration} on ${q.km} km of road. Your driver takes the fastest safe route and can add stops along the way.`],
    [`How much is a taxi from ${from} to ${to}?`,
      `A private car is from $${q.car} and an air-conditioned van (up to 6 people) from $${q.van}, fixed and door to door — the price you see is the price you pay.${shared ? ` A daily shared seat is from $${shared.seat} per person.` : ''}`],
    shared
      ? [`Is there a cheaper shared option?`, `Yes — this route runs on our ${shared.corridorLabel.replace(/\s*→\s*/g, '–')} shared service (${shared.freqText}). A single seat is from $${shared.seat}, ideal for solo travellers and couples happy to share.`]
      : [`Is there a shared option on this route?`, `This corridor is private-only, so you get the whole vehicle to yourself. If you'd like a shared seat, message us and we'll suggest the nearest daily service.`],
    [`Can we stop along the way?`,
      `Of course. A private transfer is door to door and yours for the trip — tell your driver where you'd like to stop for photos, lunch or a quick sight and they'll build it in.`],
    [`How do I book the ${from} to ${to} transfer?`,
      `Get an instant fixed price and book online, or message us on WhatsApp and we'll arrange it. You pay securely online to confirm your booking — the price you see is the price you pay.`],
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
    offers: { '@type': 'Offer', priceCurrency: 'USD', price: String(q.car), url },
  };
  return [breadcrumb, faqPage, service]
    .map(o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n');
}

function routePage(T, content, from, to, forward) {
  const key = forward ? `${from}|${to}` : `${to}|${from}`;
  const c = content.pairs[key];
  if (!c) throw new Error(`route-content.json missing pair "${key}"`);
  const fromName = T.byId[from].name, toName = T.byId[to].name;
  const q = T.privateQuote(from, to);
  const shared = T.sharedOption(from, to);
  const intro = forward ? c.intro : c.back;
  const highlights = c.highlights;
  const url = `${ORIGIN}/trip/${slug(from, to)}/`;
  const { header, footer, headAssets, bootScript } = renderChrome({ depth: 2 });
  const p = '../../';

  // Title stays private-only (no "& shared ride") so private-only routes never
  // promise a shared seat in the SERP; also keeps titles shorter. The shared option
  // lives in the body/description where it can be stated accurately per route.
  const title = `${fromName} to ${toName} — private transfer | Ceylon Hop`;
  const desc = `Private car or AC van from ${fromName} to ${toName} at a fixed price — ${q.km} km, about ${q.duration}, door to door.${shared ? ` Or share a daily seat from $${shared.seat}.` : ' Rated 5.0 on Tripadvisor.'}`;
  const faq = faqItems(fromName, toName, q, shared);

  const highlightLis = highlights.map(h => `<li>${esc(h)}</li>`).join('');
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
  .route-hero{position:relative;color:#fff;padding:104px 0 44px;margin-top:-74px;background:linear-gradient(160deg,#0d8f8c 0%,#0AB9B6 55%,#2aa9bf 100%);overflow:hidden}
  .route-hero::before{content:"";position:absolute;inset:0;background:radial-gradient(60% 60% at 80% 10%,rgba(99,191,214,.5),transparent 70%),radial-gradient(50% 50% at 10% 90%,rgba(8,120,118,.6),transparent 70%)}
  .route-hero .wrap{position:relative}
  .route-hero h1{color:#fff;font-weight:800;max-width:16ch;margin:0 0 .5rem}
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
  .faq-q p{margin:0;color:var(--ink-soft,#5a6b68)}
  .route-cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px}
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
      <p class="sub">Private transfer${shared ? ' &amp; shared ride' : ''} — ${q.km} km, about ${q.duration} door to door.</p>
      <div class="price-chips">${priceChips(q, shared)}</div>
      <div class="route-cta">
        <a class="btn btn-cta" href="${p}search.html?from=${from}&to=${to}">See prices &amp; book</a>
        <a class="btn btn-wa" href="https://wa.me/94779669662">Chat on WhatsApp</a>
      </div>
    </div>
  </section>
  <section class="section route-body">
    <div class="wrap">
      <p class="lede">${esc(intro)}</p>
      <ul class="route-hl">${highlightLis}</ul>
    </div>
  </section>
  <section class="section faq" style="background:var(--cream-deep,#f6f3ec)">
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
    return `<a class="rt-card" href="${p}trip/${slug(from, to)}/"><span class="rt-name">${esc(T.byId[from].name)} → ${esc(T.byId[to].name)}</span><span class="rt-meta">${q.km} km · from $${q.car}</span></a>`;
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
<meta name="description" content="Fixed-price private transfers and daily shared rides on Sri Lanka's most popular routes — airport to Kandy, Kandy to Ella, the south coast and more. See distances and prices.">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:title" content="Sri Lanka transfer routes — Ceylon Hop">
<meta property="og:description" content="Fixed-price private transfers and daily shared rides on Sri Lanka's most popular routes.">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="Ceylon Hop">
<meta property="og:image" content="${OG_IMAGE}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${OG_IMAGE}">
${headAssets}
<style>
  .trip-hero{background:linear-gradient(160deg,#0d8f8c,#0AB9B6 60%,#2aa9bf);color:#fff;padding:104px 0 40px;margin-top:-74px}
  .trip-hero h1{color:#fff;font-weight:800;max-width:20ch}
  .trip-hero p{color:rgba(255,255,255,.9);max-width:54ch}
  .rt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin-top:18px}
  .rt-card{display:flex;flex-direction:column;gap:4px;padding:16px 18px;border:1px solid var(--line,#e7e2d8);border-radius:14px;background:#fff;text-decoration:none;color:inherit;transition:.15s}
  .rt-card:hover{transform:translateY(-2px);box-shadow:0 10px 24px rgba(20,40,38,.08)}
  .rt-name{font-weight:700}
  .rt-meta{font-size:.85rem;color:var(--ink-soft,#5a6b68)}
</style>
</head>
<body>
${header}
<main>
  <section class="trip-hero"><div class="wrap"><h1>Sri Lanka transfer routes</h1><p>Fixed-price private transfers and daily shared rides on the island's most popular corridors. Pick a route for prices, distance and what the drive is like.</p></div></section>
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
export const SITEMAP_EXTRA = ['terms.html', 'privacy.html'];

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
