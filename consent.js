/* Ceylon Hop — Consent Mode v2 banner. Defaults are 'denied' (set in the head snippet);
   this grants on Accept and remembers the choice. No third-party CMP. */
(function (window, document, localStorage) {
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

  function render() {
    document.body.insertAdjacentHTML('beforeend',
      '<div id="ch-consent" class="ch-consent" role="dialog" aria-label="Cookie consent">' +
        '<p>We use cookies for analytics to improve your trip planning. ' +
        '<a href="/privacy.html">Learn more</a>.</p>' +
        '<div class="ch-consent-btns">' +
          '<button type="button" class="btn btn-sm" onclick="chConsent(\'denied\')">Reject</button>' +
          '<button type="button" class="btn btn-cta btn-sm" onclick="chConsent(\'granted\')">Accept</button>' +
        '</div>' +
      '</div>');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})(window, document, window.localStorage);
