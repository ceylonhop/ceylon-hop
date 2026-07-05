/* Ceylon Hop — analytics helper. Pushes GA4-shaped events to the GTM dataLayer.
   Fully no-op safe: if GTM/dataLayer is absent (tests, local dev, consent denied)
   the push is harmless and never throws. No IDs or secrets live here. */
(function (window) {
  window.dataLayer = window.dataLayer || [];
  window.chTrack = function (event, params) {
    try {
      window.dataLayer.push(Object.assign({ event: event }, params || {}));
    } catch (e) { /* analytics must never break the page */ }
  };
  // Production only: apex or www. Keeps sandbox/Pages/localhost out of GA4.
  window.chIsProd = function () {
    return /(^|\.)ceylonhop\.com$/.test(window.location.hostname);
  };
})(window);
