/* Ceylon Hop — the Europe-only cookie strip (owner decision 2026-09-27).
   ────────────────────────────────────────────────────────────────────────────
   Loaded on demand by analytics.js: automatically for a visitor on a European clock who has
   not answered yet, and for anyone who presses "Cookie choices" in the footer. Never shipped
   as a <script src>, so the ~70% of visitors outside Europe never download it.

   Why it exists: the head snippet denies advertising storage in the EEA / UK / CH (#677) and
   there was no banner to grant it (#561), so Clarity recorded every European visitor
   cookielessly: one "user" per page view (UK 162 sessions = 162 users, 25–27 Sep 2026).

   What an answer does:
     Accept → ad_storage, ad_user_data, ad_personalization granted; Clarity told directly.
     Reject → the same three denied: today's baseline in Europe, an opt-out elsewhere.
   analytics_storage is never touched: it stays granted by the head default, as before.
   The answer is stored under 'ceylonhop_cookie_choice' and the head snippet replays it on
   every later page, ahead of GTM.

   Layout: a strip fixed to the bottom, so it cannot shift the page (no CLS). It reserves its
   height as body margin so the end of the page is still reachable, and flags <html> with
   .ch-consent-open + --ch-consent-h so the fixed bottom controls (WhatsApp button, the
   board's Start bar and toast, the route pages' book bar) move up clear of it rather than
   being covered. z-index sits above those (40–90 is theirs) but below overlays, pickers and
   lightboxes (100+).

   Self-contained: its styles are injected here rather than added to the shared site.css. */
(function (window, document) {
  var KEY = 'ceylonhop_cookie_choice';

  var CSS =
    '.ch-consent{position:fixed;left:0;right:0;bottom:0;z-index:95;' +
    'background:var(--paper,#fffdf8);border-top:1px solid var(--line,#e8e2d4);' +
    'box-shadow:0 -2px 14px rgba(0,0,0,.06);' +
    'padding:10px 16px calc(10px + env(safe-area-inset-bottom,0px));' +
    'display:flex;gap:10px 14px;align-items:center;justify-content:center;flex-wrap:wrap;' +
    'font-size:.82rem;line-height:1.4;color:var(--ink-soft,#4a4744)}' +
    '.ch-consent p{margin:0;max-width:52ch}' +
    '.ch-consent a{color:var(--accent-deep,#24758A)}' +
    '.ch-consent-btns{display:flex;gap:8px;flex:none}' +
    '.ch-consent-btn{font:inherit;font-weight:700;cursor:pointer;border-radius:8px;min-height:36px;' +
    'padding:6px 16px;border:1px solid var(--ink,#3A3739);background:#fff;color:var(--ink,#3A3739)}' +
    '.ch-consent-btn:focus-visible{outline:3px solid rgba(36,117,138,.45);outline-offset:2px}' +
    'html.ch-consent-open body{margin-bottom:var(--ch-consent-h)}' +
    'html.ch-consent-open .wa-fab,html.ch-consent-open .start-bar,html.ch-consent-open .toast,' +
    'html.ch-consent-open .trip-bookbar' +
    '{margin-bottom:var(--ch-consent-h)}';

  function gtag() {
    if (typeof window.gtag === 'function') { window.gtag.apply(window, arguments); return; }
    (window.dataLayer = window.dataLayer || []).push(arguments);
  }

  function choose(choice) {
    try { window.localStorage.setItem(KEY, choice); } catch (e) { /* private mode: ask again next page */ }
    gtag('consent', 'update', { ad_storage: choice, ad_user_data: choice, ad_personalization: choice });
    try {
      if (typeof window.clarity === 'function') {
        window.clarity('consentv2', { ad_Storage: choice, analytics_Storage: 'granted' });
      }
    } catch (e) { /* Clarity must never break the page */ }
    if (typeof window.chTrack === 'function') window.chTrack('consent_choice', { choice: choice });
    close();
  }

  function close() {
    var el = document.getElementById('ch-consent');
    if (el && el.parentNode) el.parentNode.removeChild(el);
    document.documentElement.classList.remove('ch-consent-open');
    document.documentElement.style.removeProperty('--ch-consent-h');
  }

  function show() {
    if (document.getElementById('ch-consent')) return;
    if (!document.getElementById('ch-consent-css')) {
      var style = document.createElement('style');
      style.id = 'ch-consent-css';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    var el = document.createElement('div');
    el.id = 'ch-consent';
    el.className = 'ch-consent';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Cookie choices');
    el.innerHTML =
      '<p>We’d like to use cookies to measure our ads and see how visits flow through the site. ' +
      '<a href="/privacy.html#cookies">Privacy</a></p>' +
      '<span class="ch-consent-btns">' +
      '<button type="button" class="ch-consent-btn" data-consent="denied">Reject</button>' +
      '<button type="button" class="ch-consent-btn" data-consent="granted">Accept</button>' +
      '</span>';
    el.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-consent]') : null;
      if (btn) choose(btn.getAttribute('data-consent'));
    });
    document.body.appendChild(el);

    var h = el.offsetHeight || 64; // jsdom and not-yet-laid-out pages report 0
    document.documentElement.style.setProperty('--ch-consent-h', h + 'px');
    document.documentElement.classList.add('ch-consent-open');
  }

  window.chConsentShow = show;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
  else show();
})(window, document);
