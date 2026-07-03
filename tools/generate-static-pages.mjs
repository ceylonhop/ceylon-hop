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
  style: `.nf{min-height:52vh;display:grid;place-items:center;text-align:center;padding:120px 0 60px}
  .nf h1{font-size:clamp(2.4rem,7vw,4rem);margin:0 0 .3rem}
  .nf .flex{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:20px}`,
  // Relative hrefs so the <base> (apex "/" or github.io "/<repo>/") applies.
  bodyHtml: `<section class="nf"><div class="wrap"><span class="eyebrow">Error 404</span><h1>Page not found</h1><p class="lead">The page you were looking for has moved or never existed.</p><div class="flex"><a class="btn btn-cta" href="index.html">Back to home</a><a class="btn btn-primary" href="trip/">Browse routes</a></div></div></section>`,
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
