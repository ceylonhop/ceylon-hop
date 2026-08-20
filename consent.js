/* Ceylon Hop — Consent Mode v2 banner. Defaults are 'denied' (set in the head snippet);
   this grants on Accept and remembers the choice. No third-party CMP. */
(function (window, document, localStorage) {
  // Was switched off 2026-08-15 because it stacked on top of the beta notice on a first
  // mobile visit. Back on 2026-08-16 with the stacking fixed (see waitForBetaNotice below),
  // because switching it off had a consequence nobody had costed: the head snippet defaults
  // Consent Mode to DENIED, so with no way to grant, every GA4 hit from this site carried
  // gcs=G100 — a cookieless ping that never becomes a user. prod.ceylonhop.com was reporting
  // zero visitors while tracking looked, by every other measure, perfectly healthy. The apex
  // has no consent snippet at all, which is why it kept reporting normally and the gap went
  // unnoticed.
  var SHOW_BANNER = true;
  var KEY = 'ceylonhop_consent';
  var GRANT = { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' };
  function gtag(){
    if (typeof window.gtag === 'function') { window.gtag.apply(window, arguments); return; }
    (window.dataLayer = window.dataLayer || []).push(arguments);
  }

  window.chConsent = function (choice) {
    try { localStorage.setItem(KEY, choice); } catch (e) {}
    if (choice === 'granted') gtag('consent', 'update', GRANT);
    var el = document.getElementById('ch-consent'); if (el && el.remove) el.remove();
  };

  var prior = null;
  try { prior = localStorage.getItem(KEY); } catch (e) {}
  if (prior === 'granted') { gtag('consent', 'update', GRANT); return; }
  if (prior === 'denied') return; // respect a prior reject, no banner
  if (!SHOW_BANNER) return;       // owner switch above — nothing to ask right now

  function render() {
    document.body.insertAdjacentHTML('beforeend',
      '<div id="ch-consent" class="ch-consent" role="dialog" aria-label="Cookie consent">' +
        '<p>We use cookies for analytics and advertising to improve your trip planning. ' +
        '<a href="/privacy.html">Learn more</a>.</p>' +
        '<div class="ch-consent-btns">' +
          '<button type="button" class="btn btn-sm" onclick="chConsent(\'denied\')">Reject</button>' +
          '<button type="button" class="btn btn-cta btn-sm" onclick="chConsent(\'granted\')">Accept</button>' +
        '</div>' +
      '</div>');
  }
  /* The stacking fix. Both scripts are deferred and consent.js is FIRST in document order, so
     at execution time the beta notice does not exist yet — a plain querySelector here would
     always miss it and we would stack all over again. Waiting for 'load' is what makes the
     check meaningful: beta-notice.js runs on the same deferred pass and renders immediately
     (readyState is 'interactive' by then), so by 'load' the postcard is either on screen or
     was never going to be.

     No notice (already dismissed, or a transactional page where it deliberately never shows)
     → ask straight away. Notice up → hold, and ask once the customer has closed it. Greeting
     an arrival and asking about cookies at the same moment is what made this unusable. */
  function waitForBetaNotice(then) {
    if (!document.querySelector('.ch-beta')) return then();
    // window.MutationObserver, not the bare global: this module is called with an explicit
    // window, and failing open (ask now) beats never asking at all if it is missing.
    var MO = window.MutationObserver;
    if (!MO) return then();
    var obs = new MO(function () {
      if (!document.querySelector('.ch-beta')) { obs.disconnect(); then(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }
  function start() { waitForBetaNotice(render); }
  // setTimeout(0) so beta-notice.js's own load handler has run before we look for its markup.
  if (document.readyState === 'complete') setTimeout(start, 0);
  else window.addEventListener('load', function () { setTimeout(start, 0); });
})(window, document, window.localStorage);
