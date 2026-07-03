// Static site chrome (header/footer/head) for generated pages. Mirrors site.js's
// runtime-injected chrome, but with RELATIVE hrefs so nested pages (e.g.
// /trip/<slug>/) resolve correctly on the apex, the github.io project path, and
// local file serving — site.js emits page-relative hrefs that break from a subdir.
//
// Differences from site.js chrome, on purpose:
//  - correct WhatsApp number (+94 77 966 9662; site.js's footer has a typo)
//  - Terms/Privacy link to the real pages instead of "#"
//  - no image-slot CTA band (would render an empty drop-zone on the live site)

const WA = 'https://wa.me/94779669662';
const WA_DISPLAY = '+94 77 966 9662';
const YEAR = 2026;

const NAVLINKS = [
  ['Plan a trip', 'plan.html'],
  ['Tours', 'tours.html'],
  ['Travel Guide', 'blog.html'],
  ['Why us', 'why.html'],
  ['About', 'about.html'],
];

const WA_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22c5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2zm0 18.15a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.24 8.24 0 1 1 6.97 3.86zm4.52-6.16c-.25-.12-1.47-.72-1.69-.8-.23-.08-.39-.12-.56.13-.16.25-.64.8-.79.97-.14.16-.29.18-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.42.08-.16.04-.31-.02-.43-.06-.12-.56-1.35-.76-1.85-.2-.48-.41-.42-.56-.43h-.48c-.16 0-.43.06-.66.31-.22.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.16 1.75 2.67 4.25 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.07.14-1.18-.06-.1-.22-.16-.47-.28z"/></svg>';

const SOC = {
  ig: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zm0 3.68A6.16 6.16 0 1 0 18.16 12 6.16 6.16 0 0 0 12 5.84zm0 10.16A4 4 0 1 1 16 12a4 4 0 0 1-4 4zm6.41-10.4a1.44 1.44 0 1 0 1.44 1.44 1.44 1.44 0 0 0-1.44-1.44z"/></svg>',
  fb: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.78-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.44 2.89h-2.34v6.99A10 10 0 0 0 22 12z"/></svg>',
};

export function cmark(size = 34, color = 'currentColor') {
  return `<svg class="cmark" viewBox="0 0 48 48" style="width:${size}px;height:${size}px" aria-hidden="true">
      <g stroke="${color}" stroke-width="2.4" stroke-linecap="round">
        <line x1="24" y1="3" x2="24" y2="9"/><line x1="38" y1="6" x2="35" y2="11"/>
        <line x1="45" y1="18" x2="40" y2="20"/><line x1="10" y1="6" x2="13" y2="11"/>
        <line x1="3" y1="18" x2="8" y2="20"/>
      </g>
      <path d="M37 17a15 15 0 1 0 0 16" fill="none" stroke="${color}" stroke-width="6.4" stroke-linecap="round"/>
    </svg>`;
}

const prefixFor = depth => '../'.repeat(depth);

// Shared <head> essentials (after the page's own title/description/canonical/OG).
export function headAssets(depth) {
  const p = prefixFor(depth);
  return `<meta name="theme-color" content="#0AB9B6">
<link rel="icon" href="${p}favicon.svg">
<link rel="stylesheet" href="${p}site.css">`;
}

export function renderHeader(depth, active = '') {
  const p = prefixFor(depth);
  const links = NAVLINKS.map(([t, h]) => `<a href="${p}${h}"${active === h ? ' class="active"' : ''}>${t}</a>`).join('');
  const mlinks = NAVLINKS.map(([t, h]) => `<a href="${p}${h}">${t}</a>`).join('');
  return `<header class="nav" data-nav>
  <div class="wrap nav-inner">
    <a href="${p}index.html" class="brand">${cmark(34, 'currentColor')}<span>Ceylon Hop</span></a>
    <nav class="nav-links">${links}</nav>
    <div class="nav-cta">
      <button class="btn nav-burger" aria-label="Menu" data-burger><span></span><span></span><span></span></button>
    </div>
  </div>
</header>
<div class="mobile-menu" data-mobile>${mlinks}</div>`;
}

export function renderFooter(depth) {
  const p = prefixFor(depth);
  return `<footer class="footer">
  <div class="wrap foot-grid">
    <div>
      <a href="${p}index.html" class="brand" style="color:#fff">${cmark(34, '#fff')}<span>Ceylon Hop</span></a>
      <p style="margin-top:14px;color:#9a968d;max-width:30ch">Private transfers &amp; shared rides that make exploring Sri Lanka easy, social and stress-free.</p>
      <div class="soc" style="margin-top:18px">
        <a href="https://www.instagram.com/" aria-label="Instagram">${SOC.ig}</a><a href="https://www.facebook.com/" aria-label="Facebook">${SOC.fb}</a>
      </div>
    </div>
    <div><h4>Explore</h4><ul>
      <li><a href="${p}index.html#book">Get a transfer quote</a></li><li><a href="${p}plan.html">Plan a multi-stop trip</a></li>
      <li><a href="${p}tours.html">Ready-made tours</a></li><li><a href="${p}trip/">All routes</a></li></ul></div>
    <div><h4>Company</h4><ul>
      <li><a href="${p}why.html">Why Hop With Us</a></li><li><a href="${p}about.html">About</a></li>
      <li><a href="${p}blog.html">Travel guide</a></li><li><a href="${WA}">Contact</a></li></ul></div>
    <div><h4>Get in touch</h4><ul>
      <li><a href="${WA}">WhatsApp ${WA_DISPLAY}</a></li><li><a href="mailto:hello@ceylonhop.com">hello@ceylonhop.com</a></li>
      <li style="margin-top:6px"><span class="pill pill-saffron">★ Tripadvisor — Excellent</span></li></ul></div>
  </div>
  <div class="wrap foot-bottom">
    <span>© ${YEAR} Ceylon Hop. All rights reserved.</span>
    <span><a href="${p}terms.html">Terms</a> · <a href="${p}privacy.html">Privacy</a></span>
  </div>
</footer>`;
}

// Minimal boot: sticky-nav "scrolled" state + mobile burger toggle.
export const bootScript = `<script>
(function(){var n=document.querySelector('[data-nav]');function s(){if(n)n.classList.toggle('scrolled',window.scrollY>20);}s();window.addEventListener('scroll',s,{passive:true});var b=document.querySelector('[data-burger]'),m=document.querySelector('[data-mobile]');if(b&&m)b.addEventListener('click',function(){m.classList.toggle('open');});})();
</script>`;

export function renderChrome({ depth = 2, active = '' } = {}) {
  return { header: renderHeader(depth, active), footer: renderFooter(depth), headAssets: headAssets(depth), bootScript };
}

export { WA, WA_DISPLAY };
