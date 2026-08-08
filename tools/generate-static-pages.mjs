import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderStandalone, ORIGIN } from './render-page.mjs';
import { ROOT } from './generate-route-pages.mjs';

const legalStyle = `
  .legal-hero{background:linear-gradient(160deg,#0d8f8c,#0AB9B6 60%,#2aa9bf);color:#fff;padding:104px 0 40px;margin-top:-74px}
  .legal-hero h1{color:#fff;font-weight:700;margin:0}
  .legal-hero p{color:rgba(255,255,255,.9);margin:.4rem 0 0}
  .legal-body{max-width:64ch}
  .legal-body h2{margin:1.8rem 0 .5rem;font-size:1.2rem}
  .legal-body p,.legal-body li{color:var(--ink-soft,#4a5a57);line-height:1.65}
  .legal-body ul{margin:.4rem 0 1rem;padding-left:1.2rem}`;

function legalPage(slug, heading, tagline, description, fragmentFile) {
  const body = readFileSync(join(ROOT, 'tools/legal', fragmentFile), 'utf8');
  return renderStandalone({
    title: `${heading} — Ceylon Hop`,
    description,
    canonicalPath: `/${slug}.html`,
    depth: 0,
    style: legalStyle,
    bodyHtml: `<section class="legal-hero"><div class="wrap"><h1>${heading}</h1><p>${tagline}</p></div></section>
  <section class="section"><div class="wrap legal-body">
${body.trimEnd()}
  </div></section>`,
  });
}

const notFoundPage = () => renderStandalone({
  title: 'Page not found — Ceylon Hop',
  description: 'That page could not be found. Explore Sri Lanka transfer routes or head back to the Ceylon Hop home page.',
  robots: 'noindex, follow',
  depth: 0,
  absolute: true, // served for missing URLs at any depth → assets/nav must be root-absolute
  style: `.nf{min-height:64vh;display:grid;place-items:center;text-align:center;padding:52px 20px 72px;overflow:hidden}
  .nf .wrap{max-width:560px}
  .nf-art{width:min(430px,86vw);height:auto;display:block;margin:0 auto 8px}
  .nf .eyebrow{color:var(--teal-deep,#08938f)}
  .nf h1{font-family:var(--display,Georgia,serif);font-size:clamp(2rem,6vw,3.1rem);line-height:1.05;margin:.25rem 0 .55rem;color:var(--ink,#2C2A2B)}
  .nf .lead{color:var(--ink-soft,#6c6a6b);font-size:1.02rem;max-width:40ch;margin:0 auto}
  .nf .flex{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:24px}
  @keyframes nf-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)}}
  @keyframes nf-spin{to{transform:rotate(360deg)}}
  @keyframes nf-dash{to{stroke-dashoffset:-30}}
  @keyframes nf-pin{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
  .nf-island{animation:nf-bob 5.5s ease-in-out infinite;transform-origin:center}
  .nf-sun{animation:nf-spin 40s linear infinite;transform-origin:398px 72px}
  .nf-road{stroke-dasharray:6 9;animation:nf-dash 2.6s linear infinite}
  .nf-pin{animation:nf-pin 3.4s ease-in-out infinite;transform-origin:center}
  @media (prefers-reduced-motion:reduce){.nf-island,.nf-sun,.nf-road,.nf-pin{animation:none}}`,
  // Relative hrefs so the <base> (apex "/" or github.io "/<repo>/") applies.
  bodyHtml: `<section class="nf"><div class="wrap">
    <svg class="nf-art" viewBox="0 0 480 300" role="img" aria-label="A little palm-tree island with a road that runs off the map">
      <defs>
        <radialGradient id="nfSky" cx="50%" cy="36%" r="72%"><stop offset="0%" stop-color="#fdfbf3"/><stop offset="100%" stop-color="#e7f4f0"/></radialGradient>
        <linearGradient id="nfSea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#a4ddd7"/><stop offset="100%" stop-color="#54c1ba"/></linearGradient>
        <linearGradient id="nfLand" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f4e7c8"/><stop offset="100%" stop-color="#e7d1a1"/></linearGradient>
      </defs>
      <rect width="480" height="300" fill="url(#nfSky)"/>
      <g class="nf-sun"><circle cx="398" cy="72" r="23" fill="#f6b44c"/><g stroke="#f6b44c" stroke-width="4" stroke-linecap="round"><line x1="398" y1="30" x2="398" y2="18"/><line x1="398" y1="126" x2="398" y2="114"/><line x1="356" y1="72" x2="344" y2="72"/><line x1="452" y1="72" x2="440" y2="72"/><line x1="368" y1="42" x2="360" y2="34"/><line x1="428" y1="102" x2="436" y2="110"/><line x1="428" y1="42" x2="436" y2="34"/><line x1="368" y1="102" x2="360" y2="110"/></g></g>
      <ellipse cx="240" cy="278" rx="262" ry="44" fill="url(#nfSea)"/>
      <g stroke="#ffffff" stroke-opacity=".55" stroke-width="3" stroke-linecap="round" fill="none"><path d="M96 276 q11 -8 22 0 t22 0"/><path d="M300 284 q11 -8 22 0 t22 0"/></g>
      <g class="nf-island">
        <ellipse cx="214" cy="256" rx="112" ry="17" fill="#3aa89f" opacity=".22"/>
        <path d="M214 148 C256 154 278 190 273 220 C268 246 244 258 214 258 C184 258 160 246 155 218 C150 188 172 152 214 148 Z" fill="url(#nfLand)" stroke="#d8c193" stroke-width="2"/>
        <path d="M214 148 C250 153 271 182 267 205 C230 194 192 198 166 210 C171 179 188 153 214 148 Z" fill="#8fce9f"/>
        <path d="M203 212 C199 188 197 172 198 156" stroke="#9a6b3f" stroke-width="6" fill="none" stroke-linecap="round"/>
        <g fill="#4bb08a"><path d="M198 154 C176 148 160 152 148 164 C168 158 186 158 200 162 Z"/><path d="M198 154 C220 148 236 152 248 164 C228 158 210 158 196 162 Z"/><path d="M198 154 C190 132 176 122 158 120 C172 138 182 150 196 160 Z"/><path d="M198 154 C206 132 220 122 238 120 C224 138 214 150 200 160 Z"/></g>
        <circle cx="198" cy="155" r="5" fill="#3f9a78"/>
      </g>
      <path class="nf-road" d="M246 236 C296 230 324 204 350 172" stroke="#caa96b" stroke-width="6" fill="none" stroke-linecap="round"/>
      <g class="nf-pin"><path d="M352 118 c-16 0 -29 13 -29 29 c0 21 29 46 29 46 c0 0 29 -25 29 -46 c0 -16 -13 -29 -29 -29 Z" fill="#ef6a4a"/><circle cx="352" cy="147" r="11" fill="#fff"/><text x="352" y="152" text-anchor="middle" font-size="15" font-weight="800" fill="#ef6a4a" font-family="Georgia, serif">?</text></g>
    </svg>
    <span class="eyebrow">404 &middot; off the map</span>
    <h1>You&rsquo;ve wandered off the map</h1>
    <p class="lead">This little road doesn&rsquo;t lead anywhere &mdash; but plenty of ours do. Let&rsquo;s get you back on the island.</p>
    <div class="flex"><a class="btn btn-cta" href="index.html">Back to home</a><a class="btn btn-primary" href="plan.html">Plan a trip</a></div>
  </div></section>`,
});

// ---------------------------------------------------------------------------
// Travel-guide posts (M16). These five articles were published on the old
// WordPress site and are indexed at their apex slugs; they are ported here so
// the URLs keep resolving to the real article after the domain cutover.
//
// The prose in tools/blog/<slug>.body.html is the AUTHOR'S, recovered verbatim
// from the live pages — only WordPress/Elementor markup was stripped. Nothing
// in this file rewrites it. Body images are deliberately dropped: every source
// src lived under the WordPress /wp-content/ tree, which dies at cutover.
// ---------------------------------------------------------------------------

const WPM = 220; // reading speed used for the honest "N min read" figure

const BLOG_POSTS = [
  {
    slug: 'how-to-use-buses-in-sri-lanka-the-ultimate-guide-for-the-adventurous-travelers',
    photo: 'blog-bus.jpg',
    photoAlt: 'A red intercity bus rounding a bend on a Sri Lankan road',
    // Emoji-free headline for <title>/JSON-LD (matches the old indexed title);
    // `heading` is the <h1> exactly as it was published.
    title: 'How to Use Buses in Sri Lanka: The Ultimate Guide for the Adventurous Travelers',
    heading: 'How to Use Buses in Sri Lanka: The Ultimate Guide for the Adventurous Travelers 🚌🌴',
    crumb: 'How to use buses in Sri Lanka',
    kicker: 'Guide',
    published: '2025-03-03',
    modified: '2025-05-06',
    related: [
      ['ultimate-tuk-tuk-guide-to-getting-around-in-sri-lanka/', 'Ultimate tuk-tuk guide to getting around in Sri Lanka'],
      ['trip/colombo-to-kandy/', 'Colombo to Kandy — the same trip by private transfer'],
      ['search.html', 'Get a fixed price for any route'],
    ],
  },
  {
    slug: 'ultimate-tuk-tuk-guide-to-getting-around-in-sri-lanka',
    photo: 'blog-post-1.jpg',
    photoAlt: 'A tuk-tuk coming down a street in Mirissa, Sri Lanka',
    title: 'Ultimate Tuk Tuk Guide to Getting Around in Sri Lanka',
    heading: 'Ultimate Tuk Tuk Guide to Getting Around in Sri Lanka',
    crumb: 'Ultimate tuk-tuk guide',
    kicker: 'Guide',
    published: '2025-05-06',
    modified: '2025-05-06',
    related: [
      ['how-to-use-buses-in-sri-lanka-the-ultimate-guide-for-the-adventurous-travelers/', 'How to use buses in Sri Lanka'],
      ['search.html', 'Fixed prices for the longer hops between towns'],
    ],
  },
  {
    slug: 'best-time-to-visit-sri-lanka-a-month-by-month-guide',
    photo: 'blog-post-2.jpg',
    photoAlt: 'Mist drifting through palms over Sri Lankan hill country',
    title: 'Best Time to Visit Sri Lanka: A Month-by-Month Guide',
    heading: 'Best Time to Visit Sri Lanka: A Month-by-Month Guide 🌴✨',
    crumb: 'Best time to visit Sri Lanka',
    kicker: 'Planning',
    published: '2025-03-03',
    modified: '2025-05-06',
    related: [
      ['plan.html', 'Plan a multi-stop trip around the island'],
      ['trip/', 'All Sri Lanka transfer routes'],
    ],
  },
  {
    slug: '9-must-visit-places-in-sri-lanka',
    photo: 'blog-post-3.jpg',
    photoAlt: 'Palms above the sea at Coconut Tree Hill, Mirissa',
    title: '9 Must-Visit Places in Sri Lanka',
    heading: '9 Must-Visit Places in Sri Lanka',
    crumb: '9 must-visit places',
    kicker: 'List',
    published: '2025-03-03',
    modified: '2025-05-06',
    related: [
      ['trip/cmb-airport-to-sigiriya/', 'Colombo Airport to Sigiriya — start at stop one'],
      ['trip/ella-to-mirissa/', 'Ella to Mirissa — hill country down to the whales'],
      ['tours.html', 'Ready-made tours that string these stops together'],
    ],
  },
  {
    slug: 'discover-sri-lanka-with-ceylon-hop-your-ultimate-travel-adventure',
    photo: 'blog-post-4.jpg',
    photoAlt: 'A road winding through green mountains in Sri Lanka',
    title: 'Discover Sri Lanka with Ceylon Hop: Your Ultimate Travel Adventure!',
    heading: 'Discover Sri Lanka with Ceylon Hop: Your Ultimate Travel Adventure!',
    crumb: 'Discover Sri Lanka with Ceylon Hop',
    kicker: 'Story',
    published: '2025-02-24',
    modified: '2025-05-07',
    related: [
      ['tours.html', 'Ready-made tours'],
      ['plan.html', 'Build your own multi-stop trip'],
    ],
  },
  {
    slug: 'why-we-started-ceylon-hop',
    video: 'Oo2d8CfGOgI',
    videoTitle: "Ceylon Hop — Sri Lanka's first hop-on hop-off service",
    photo: 'blog-post-0.jpg',
    photoAlt: 'A busy Sri Lankan market street',
    title: 'Why We Started Ceylon Hop',
    heading: 'Why We Started Ceylon Hop 🚌',
    crumb: 'Why we started Ceylon Hop',
    kicker: 'Story',
    published: '2025-05-06',
    modified: '2025-05-12',
    related: [
      ['about.html', 'About Ceylon Hop'],
      ['why.html', 'Why hop with us'],
    ],
  },
];

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const stripTags = s => s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&nbsp;/g, ' ');
// Emoji/pictographs are lovely in the body copy but noise in a SERP snippet.
const deEmoji = s => s.replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{200D}\u{2600}-\u{27BF}]/gu, '');
const squash = s => s.replace(/\s+/g, ' ').trim();

const bodyText = body => squash(decode(stripTags(body)));

const readMinutes = body => Math.max(1, Math.round(bodyText(body).split(' ').length / WPM));

// The meta description is lifted from the article's own opening prose — never
// written fresh — so it can never promise something the page does not say.
function deriveDescription(body) {
  const paras = [...body.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m => squash(deEmoji(decode(stripTags(m[1])))));
  let out = '';
  for (const p of paras) {
    out = out ? `${out} ${p}` : p;
    if (out.length >= 130) break;
  }
  out = squash(out);
  if (out.length <= 158) return out;
  const cut = out.slice(0, 158);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

const longDate = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
});

const blogStyle = `
  .post-hero{position:relative;color:#fff;padding:104px 0 48px;margin-top:-74px;background:linear-gradient(160deg,#0d8f8c 0%,#0AB9B6 55%,#2aa9bf 100%);overflow:hidden}
  .post-hero::before{content:"";position:absolute;inset:0;background:radial-gradient(60% 60% at 82% 8%,rgba(99,191,214,.5),transparent 70%),radial-gradient(52% 52% at 8% 92%,rgba(8,120,118,.6),transparent 70%)}
  .post-hero .wrap{position:relative;z-index:2;max-width:900px}
  /* With a photo the decorative radial gradients are replaced by a real scrim,
     so white hero text keeps its contrast over an arbitrary image. */
  .post-hero-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0}
  .post-hero.has-photo::before{background:linear-gradient(180deg,rgba(12,58,56,.60),rgba(12,58,56,.82));z-index:1}
  .post-embed{margin:2rem 0;max-width:360px}
  .post-embed .frame{position:relative;width:100%;aspect-ratio:9/16;border-radius:var(--r,16px);overflow:hidden;background:#0c3a38}
  .post-embed iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
  .post-embed figcaption{margin-top:.6rem;font-size:.86rem;color:var(--ink-soft,#4a5a57)}
  .post-hero .breadcrumbs{padding-top:0;margin-bottom:18px}
  .post-kicker{display:inline-block;font-size:.74rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;padding:.32rem .7rem;border-radius:999px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.3)}
  .post-hero h1{color:#fff;font-weight:700;max-width:22ch;margin:.7rem 0 .5rem;font-size:clamp(1.9rem,4.4vw,2.9rem);line-height:1.12}
  .post-meta{color:rgba(255,255,255,.88);font-size:.9rem;margin:0}
  .post-body{padding:clamp(40px,5vw,68px) 0 clamp(32px,4vw,52px)}
  .post-body .wrap{max-width:900px}
  .article{max-width:68ch;font-size:1.06rem;line-height:1.78}
  .article > p:first-child{font-size:1.14rem;color:var(--ink,#2C2A2B)}
  .article p{margin:0 0 1.15rem;color:var(--ink-soft,#4a5a57)}
  .article h2{font-family:var(--display,Georgia,serif);font-size:clamp(1.35rem,2.6vw,1.72rem);line-height:1.2;margin:2.4rem 0 .7rem;color:var(--ink,#2C2A2B)}
  .article h3{font-size:1.08rem;margin:1.7rem 0 .45rem;color:var(--ink,#2C2A2B)}
  .article ul,.article ol{margin:0 0 1.2rem;padding-left:1.25rem}
  .article li{margin:.42rem 0;color:var(--ink-soft,#4a5a57)}
  .article a{color:var(--accent-deep,#08938f);text-underline-offset:2px}
  .article blockquote{margin:1.3rem 0;padding:.85rem 1.15rem;border-left:3px solid var(--accent,#0AB9B6);background:var(--pc-teal,#e3f4ef);border-radius:0 var(--r-sm,10px) var(--r-sm,10px) 0}
  .article blockquote p{margin:0;color:var(--ink,#2C2A2B)}
  .article strong{color:var(--ink,#2C2A2B)}
  .post-next{margin:44px 0 0;padding:24px 26px;background:var(--paper,#fffdf8);border:1px solid var(--line,#e7e3d6);border-radius:var(--r,16px);max-width:68ch}
  .post-next h2{font-size:1.05rem;margin:.35rem 0 .7rem}
  .post-next ul{margin:0;padding-left:1.1rem}
  .post-next li{margin:.35rem 0}
  .post-next a{color:var(--accent-deep,#08938f);font-weight:600}
  .post-cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}`;

function blogPost(post) {
  const body = readFileSync(join(ROOT, 'tools/blog', `${post.slug}.body.html`), 'utf8').trimEnd();
  const url = `${ORIGIN}/${post.slug}/`;
  const description = deriveDescription(body);
  const minutes = readMinutes(body);
  const p = '../';

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description,
      datePublished: post.published,
      dateModified: post.modified,
      // The WordPress export credits the admin login ("k1ato"), not a person —
      // the blog is written by the company, so the byline is the company.
      author: { '@type': 'Organization', name: 'Ceylon Hop', url: `${ORIGIN}/` },
      publisher: { '@type': 'Organization', name: 'Ceylon Hop', url: `${ORIGIN}/` },
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      image: `${ORIGIN}/og-cover.jpg`,
      inLanguage: 'en',
      wordCount: bodyText(body).split(' ').length,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: 'Travel Guide', item: `${ORIGIN}/blog.html` },
        { '@type': 'ListItem', position: 3, name: post.title, item: url },
      ],
    },
  ].map(o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n');

  const related = post.related
    .map(([href, label]) => `<li><a href="${p}${href}">${esc(label)}</a></li>`).join('\n        ');

  return renderStandalone({
    title: `${post.title} — Ceylon Hop`,
    description,
    canonicalPath: `/${post.slug}/`,
    depth: 1,
    active: 'blog.html',
    style: blogStyle,
    bodyHtml: `${jsonLd}
  <section class="post-hero${post.photo ? ' has-photo' : ''}">${post.photo ? `\n    <img class="post-hero-img" src="${p}img/${post.photo}" alt="${esc(post.photoAlt || '')}">` : ''}
    <div class="wrap">
      <nav class="breadcrumbs on-dark" aria-label="Breadcrumb"><a href="${p}index.html">Home</a><svg class="bc-sep" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg><a href="${p}blog.html">Travel Guide</a><svg class="bc-sep" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg><span class="bc-cur" aria-current="page">${esc(post.crumb)}</span></nav>
      <span class="post-kicker">${esc(post.kicker)}</span>
      <h1>${post.heading}</h1>
      <p class="post-meta"><time datetime="${post.published}">${longDate(post.published)}</time> &middot; ${minutes} min read &middot; Ceylon Hop</p>
    </div>
  </section>
  <section class="section post-body">
    <div class="wrap">
      <article class="article">
${body}${post.video ? `\n<figure class="post-embed">\n  <div class="frame"><iframe src="https://www.youtube-nocookie.com/embed/${post.video}" title="${esc(post.videoTitle || '')}" loading="lazy" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>\n  <figcaption>${esc(post.videoTitle || '')}</figcaption>\n</figure>` : ''}
      </article>
      <aside class="post-next">
        <span class="eyebrow">Keep reading</span>
        <h2>Where to next</h2>
        <ul>
        ${related}
        </ul>
      </aside>
      <div class="post-cta">
        <a class="btn btn-cta" href="${p}search.html">Get a fixed price</a>
        <a class="btn btn-ghost" href="${p}blog.html">All travel guides</a>
      </div>
    </div>
  </section>`,
  });
}

// Slugs + read times the blog hub links to (kept honest against the real prose).
export function blogIndex() {
  return BLOG_POSTS.map(post => {
    const body = readFileSync(join(ROOT, 'tools/blog', `${post.slug}.body.html`), 'utf8');
    return { slug: post.slug, title: post.title, kicker: post.kicker, published: post.published, minutes: readMinutes(body) };
  });
}

export function generateStaticPages() {
  const out = new Map();
  out.set('terms.html', legalPage('terms', 'Terms &amp; Conditions', 'The agreement between you and Ceylon Hop when you book with us.',
    'Ceylon Hop terms and conditions — bookings, reservations, baggage, refunds and cancellations, liability, and how we run our transfer and shared-ride service in Sri Lanka.', 'terms.body.html'));
  out.set('privacy.html', legalPage('privacy', 'Privacy Policy', 'How Ceylon Hop handles your personal information.',
    'Ceylon Hop privacy policy — how we collect, use and protect your personal information when you book transfers and shared rides in Sri Lanka.', 'privacy.body.html'));
  out.set('404.html', notFoundPage());
  for (const post of BLOG_POSTS) out.set(`${post.slug}/index.html`, blogPost(post));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let n = 0;
  for (const [rel, content] of generateStaticPages()) {
    const abs = join(ROOT, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    n++;
  }
  console.log(`generated ${n} static pages`);
}
