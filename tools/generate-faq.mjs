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
const stripTags = s => String(s).replace(/<\/(?:p|li|ul|ol|div|h[1-6])>|<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
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
  const out = String(html).replace(/\{fare:([a-z0-9-]+):([a-z0-9-]+):(shared|private)\}/g, (_, from, to, service) => {
    for (const id of [from, to]) if (!T.byId[id]) throw new Error(`faq: {fare:${from}:${to}:${service}} — unknown place "${id}"`);
    if (service === 'shared') {
      const s = T.sharedOption(from, to);
      if (!s) throw new Error(`faq: {fare:${from}:${to}:shared} — no shared product on that leg`);
      return `$${price(s.seat)}`;
    }
    return `$${price(T.privateQuote(from, to).car)}`;
  });
  if (/\{fare:/.test(out)) throw new Error('faq: malformed {fare:…} token left in output');
  return out;
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
  .topic details{border-top:1px solid var(--line);scroll-margin-top:84px}
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
  .tip>b:first-child{display:block;font-family:var(--hand);font-weight:600;font-size:1.05rem;color:#8a5000;margin-bottom:.1rem}
  .tip.warn{background:#fdeeec}.tip.warn::before{background:var(--tomato)}.tip.warn>b:first-child{color:#a3210f}
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
    .dc,.pill,.topic summary::after,.ch-row{transition:none}
  }`;

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [rel, html] of generateFaq()) {
    const abs = join(ROOT, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, html);
  }
  console.log('generated the travel FAQ');
}
