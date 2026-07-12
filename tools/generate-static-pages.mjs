import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderStandalone } from './render-page.mjs';
import { ROOT } from './generate-route-pages.mjs';

const legalStyle = `
  .legal-hero{background:linear-gradient(160deg,#0d8f8c,#0AB9B6 60%,#2aa9bf);color:#fff;padding:104px 0 40px;margin-top:-74px}
  .legal-hero h1{color:#fff;font-weight:800;margin:0}
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

export function generateStaticPages() {
  const out = new Map();
  out.set('terms.html', legalPage('terms', 'Terms &amp; Conditions', 'The agreement between you and Ceylon Hop when you book with us.',
    'Ceylon Hop terms and conditions — bookings, reservations, baggage, refunds and cancellations, liability, and how we run our transfer and shared-ride service in Sri Lanka.', 'terms.body.html'));
  out.set('privacy.html', legalPage('privacy', 'Privacy Policy', 'How Ceylon Hop handles your personal information.',
    'Ceylon Hop privacy policy — how we collect, use and protect your personal information when you book transfers and shared rides in Sri Lanka.', 'privacy.body.html'));
  out.set('404.html', notFoundPage());
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let n = 0;
  for (const [rel, content] of generateStaticPages()) {
    writeFileSync(join(ROOT, rel), content);
    n++;
  }
  console.log(`generated ${n} static pages`);
}
