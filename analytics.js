/* Ceylon Hop — analytics helper. Pushes GA4-shaped events to the GTM dataLayer.
   Fully no-op safe: if GTM/dataLayer is absent (tests, local dev, consent denied)
   the push is harmless and never throws. No IDs or secrets live here. */
(function (window, document) {
  window.dataLayer = window.dataLayer || [];
  window.chTrack = function (event, params) {
    try {
      window.dataLayer.push(Object.assign({ event: event }, params || {}));
    } catch (e) { /* analytics must never break the page */ }
  };
  // Production only: apex or www. Keeps sandbox/Pages/localhost out of GA4.
  window.chIsProd = function () {
    return /^(www\.)?ceylonhop\.com$/.test(window.location.hostname);
  };

  // Outbound WhatsApp CTAs sit on a dozen pages and fired nothing, so the most
  // common way a traveller actually reaches us looked like a bounce in GA4.
  // One delegated listener covers every link, including markup that search.js /
  // plan.js / booking.js render later.
  //
  // A wa.me link with NO phone number is board.js sharing a van with a friend,
  // not someone contacting us — counting those would inflate the metric with
  // the board's own virality loop. Hence the digits check on the path.
  function contactLink(target) {
    var a = target && target.closest ? target.closest('a[href]') : null;
    if (!a) return null;
    var url;
    try { url = new window.URL(a.getAttribute('href'), window.location.href); }
    catch (e) { return null; }
    if (url.hostname !== 'wa.me') return null;          // not a lookalike host
    return /^\/\d+$/.test(url.pathname) ? a : null;     // has a phone = a contact
  }

  // Capture phase, so a handler that stops propagation can't blind us. Never
  // calls preventDefault: the link must still open WhatsApp. Bound once — a
  // page that includes this script twice must not double-count contacts.
  if (window.chContactBound) return;
  window.chContactBound = true;
  document.addEventListener('click', function (ev) {
    var a = contactLink(ev.target);
    if (!a) return;
    window.chTrack('contact_whatsapp', {
      method: 'whatsapp',
      link_id: a.id || '',
      page: window.location.pathname,
    });
  }, true);
})(window, document);
