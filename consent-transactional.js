/* Ceylon Hop — consent for the TRANSACTIONAL properties (pay.html, quote.html).
   ────────────────────────────────────────────────────────────────────────────
   Not a duplicate of consent.js. Both pages set Consent Mode v2 to 'denied' in the
   head and then deliberately omit consent.js, because its floating card overlaid the
   pay CTA on a phone (owner, 2026-08-01, repeated for quote.html 2026-08-06). That
   removed the banner — and, unintentionally, every grant with it: `analytics_storage`
   stayed denied for the whole session, so Clarity's tag never fired once and GA4 was
   reduced to cookieless pings. We had no recording of a single customer paying.

   This module keeps the owner's rule (nothing may cover the CTA) and drops the side
   effect. Three differences from consent.js:

     1. It RESERVES its own height as body padding, so the strip sits below the page
        rather than on top of it. The original objection was the overlay, not the ask.
     2. It grants `analytics_storage` ONLY. ad_storage / ad_user_data /
        ad_personalization stay denied on these pages permanently — a payer is not an
        ad audience, and this keeps the money pages out of remarketing entirely.
     3. It honours `?chc=1` from another Ceylon Hop property, because
        quote.ceylonhop.com and pay.ceylonhop.com are separate origins and
        localStorage does not travel between them.

   Self-contained by design: its own styles are injected here rather than added to the
   shared site.css, so this file can be added to or removed from a page on its own. */
(function (window, document, localStorage) {
  // ── the one owner switch ──────────────────────────────────────────────────
  // false → grant analytics on arrival, no strip, ads still denied. The
  //         legitimate-interest posture for a first-party transactional page with the
  //         privacy policy linked: our own site, a customer who has already decided to
  //         buy, no advertising and no data sold.
  // true  → ask first, with the strip below, and measure only those who accept.
  //
  // **Owner call, 2026-08-07: false, revisit at scale.** The trade is coverage against
  // exposure — asking loses the majority of a mostly-European audience, and at today's
  // volume the risk of not asking is small. Flip to `true` when the business is large
  // enough for that to stop being true; everything below the switch is still built,
  // tested and ready, so it is a one-word change and a deploy.
  var ASK_FIRST = false;

  var KEY = 'ceylonhop_consent';
  // Analytics only. Deliberately NOT the GRANT object in consent.js.
  var GRANT = { analytics_storage: 'granted' };
  var PRIVACY = 'https://ceylonhop.com/privacy.html';

  function gtag() {
    (window.dataLayer = window.dataLayer || []).push(arguments);
  }
  function grant() {
    gtag('consent', 'update', GRANT);
  }
  function remember(choice) {
    try { localStorage.setItem(KEY, choice); } catch (e) { /* private mode, or storage off */ }
  }
  function recall() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  // A stored answer wins over everything, including an inbound ?chc=1 — otherwise a
  // link could silently overturn a refusal the customer already made on this origin.
  var prior = recall();
  if (prior === 'granted') { grant(); return; }
  if (prior === 'denied') return;

  // Hand-off from another property. Only an explicit `1` carries a grant.
  var handoff = /[?&]chc=1(?:&|$)/.test(window.location.search || '');
  if (handoff || !ASK_FIRST) {
    remember('granted');
    grant();
    return;
  }

  var CSS =
    '.ch-tconsent{position:fixed;left:0;right:0;bottom:0;z-index:9998;' +
    'background:#fffdf8;border-top:1px solid #e8e2d4;box-shadow:0 -2px 14px rgba(0,0,0,.06);' +
    'padding:8px 14px;display:flex;gap:10px;align-items:center;justify-content:center;' +
    'flex-wrap:wrap;font-size:.76rem;line-height:1.35;color:#4a4744}' +
    '.ch-tconsent p{margin:0;max-width:44ch}' +
    '.ch-tconsent a{color:var(--accent-deep,#24758A)}' +
    '.ch-tconsent-btns{display:flex;gap:8px;flex:none}' +
    '.ch-tconsent button{font:inherit;font-weight:700;cursor:pointer;border-radius:8px;' +
    'padding:5px 12px;border:1px solid #d9d2c2;background:#fff;color:#4a4744}' +
    '.ch-tconsent button[data-consent="granted"]{background:var(--btn-accent,#24758A);border-color:var(--btn-accent,#24758A);color:#fff}';

  function render() {
    try {
      var style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);

      var el = document.createElement('div');
      el.className = 'ch-tconsent';
      el.setAttribute('role', 'region');
      el.setAttribute('aria-label', 'Analytics consent');
      // One short line. This strip is fixed, so every extra row of text is screen a payer
      // does not get back until they answer.
      el.innerHTML =
        '<p>Allow analytics so we can fix what breaks? No advertising. ' +
        '<a href="' + PRIVACY + '">Privacy</a>.</p>' +
        '<span class="ch-tconsent-btns">' +
        '<button type="button" data-consent="denied">No thanks</button> ' +
        '<button type="button" data-consent="granted">Allow</button>' +
        '</span>';
      document.body.appendChild(el);

      // Reserve the strip's own height so it sits BELOW the page instead of on top of
      // the CTA. This line is the entire reason this file exists rather than consent.js.
      var h = 0;
      try { h = parseInt(window.getComputedStyle(el).height, 10) || 0; } catch (e) { h = 0; }
      if (!h) h = el.offsetHeight || 64;
      document.body.style.paddingBottom = h + 16 + 'px';

      el.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest('[data-consent]') : null;
        if (!btn) return;
        var choice = btn.getAttribute('data-consent');
        remember(choice);
        if (choice === 'granted') grant();
        // Take the reserved space back with it, so the page doesn't keep a dead gap.
        document.body.style.paddingBottom = '';
        if (el.remove) el.remove();
      });
    } catch (e) {
      // A consent strip must never be the thing that breaks a payment page.
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})(window, document, window.localStorage);
