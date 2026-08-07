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
  // ── which property is this? ───────────────────────────────────────────
  // Five customer-facing properties now share ONE GTM container, so without a
  // property dimension every hit is an anonymous hit and nothing downstream can
  // tell a payment page from a blog post.
  //
  // A page DECLARES itself via window.CH_PROPERTY before this script loads, and
  // that is the primary source rather than the host: pay.html is reachable both
  // at pay.ceylonhop.com AND directly on the API host (customerPages.ts serves
  // it there), and both must report as `pay`. The path sniff below is only the
  // fallback for pages that predate the declaration.
  var PROPERTIES = ['site', 'pay', 'quote', 'manage', 'board', 'ops'];
  var BY_PATH = [
    [/^\/(?:p|pay\.html)$/, 'pay'],       // `/p` is the short pay-link alias
    [/^\/(?:q|quote\.html)$/, 'quote'],   // `/q` likewise for the quote link
    [/^\/manage\.html$/, 'manage'],
    [/^\/board\.html$/, 'board'],
  ];
  window.chProperty = function () {
    // An unknown value is dropped rather than passed through: a typo would mint
    // a new dimension value and quietly split every report in two.
    if (PROPERTIES.indexOf(window.CH_PROPERTY) !== -1) return window.CH_PROPERTY;
    var p = window.location.pathname || '/';
    for (var i = 0; i < BY_PATH.length; i++) if (BY_PATH[i][0].test(p)) return BY_PATH[i][1];
    return 'site';
  };

  // Staging is checked FIRST: `pay-staging.ceylonhop.com` and
  // `ops.staging.ceylonhop.com` both end in our domain and would otherwise read
  // as production.
  window.chEnv = function () {
    var h = (window.location.hostname || '').toLowerCase();
    if (/(^|[.-])staging([.-]|$)/.test(h)) return 'staging';
    if (/(^|\.)ceylonhop\.com$/.test(h) || h === 'ceylon-hop-api.onrender.com') return 'prod';
    return 'dev';
  };

  // The REVENUE gate — deliberately narrower than chEnv(). True only where a real
  // charge can actually happen, because GA4 cannot delete events after the fact and
  // one sandbox transaction in revenue is permanent.
  //
  // pay./quote./ride. are included: they are the SOLE live home of those flows —
  // there is no other host a customer reaches them on — and real USD has settled
  // through pay.ceylonhop.com since 2026-08-02 (the apex PayHere registration covers
  // the subdomain; docs/checkout-redirect-spec.md §2.1 proves it in production).
  //
  // prod.ceylonhop.com stays OUT, unchanged and for the original reason: it is the
  // pre-cutover COPY of the marketing site, which is exactly where the owner does
  // test bookings. At the apex cutover the site moves to ceylonhop.com and starts
  // matching on its own, with no code change. Do not "fix" this.
  window.chIsProd = function () {
    return /^(?:(?:www|pay|quote|ride)\.)?ceylonhop\.com$/.test(
      (window.location.hostname || '').toLowerCase()
    );
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

  // Everything below runs ONCE per page: a second copy of this script must not
  // double-count contacts, nor push a second ch_context.
  if (window.chContactBound) return;
  window.chContactBound = true;

  // ── publish the context, once, before anything else ───────────────────
  // GTM Data Layer Variables retain the last value pushed, so publishing the pair
  // here lets every later event tag segment by property without every call site —
  // or every tag — having to repeat it.
  window.chTrack('ch_context', { ch_property: window.chProperty(), ch_env: window.chEnv() });

  // Clarity gets the same pair as custom tags, which is what makes replays
  // filterable by property in its UI ("show me people paying"). GTM injects
  // Clarity asynchronously and it may not exist yet — or ever, if consent was
  // refused — so try now and then a couple of times more, and stop once it lands.
  (function tagClarity() {
    var tries = 0;
    var delays = [800, 2500, 6000];
    function attempt() {
      try {
        if (typeof window.clarity === 'function') {
          window.clarity('set', 'property', window.chProperty());
          window.clarity('set', 'env', window.chEnv());
          return; // landed — stop retrying
        }
      } catch (e) { /* a tagging failure must never break the page */ }
      if (tries < delays.length && typeof window.setTimeout === 'function') {
        window.setTimeout(attempt, delays[tries++]);
      }
    }
    attempt();
  })();
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
