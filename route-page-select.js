/* ============================================================
   CEYLON HOP — route page: vehicle choice + mobile book bar
   ============================================================
   The fares card's two tiles are radios (car / van). Whichever is checked decides what the
   page's two booking links carry — the card's own CTA and, on a phone, the sticky book bar's:
   `vehicle`, `price`, and — ONLY while the catalogue fare is what's on screen — `rawPrice`.
   booking.js reads rawPrice FIRST, so it must never ride beside an engine fare (see
   route-page-fares.js for why the catalogue and engine fares can never both be true at once).

   route-page-fares.js writes the two engine fares into every [data-fare] element, records
   them in cents on the card (data-engine-car / data-engine-van) and dispatches `ch:fares` on
   the card — it does not touch either href itself any more. This file is what turns a radio
   click, or that event, into an updated link: it re-derives BOTH hrefs from whichever vehicle
   is currently checked, every time either can have changed (a `change`, an engine answer, or
   coming back to a bfcache-restored page whose radio the browser reset without firing either).

   No engine fare recorded yet (still pending, or the engine never answered) → the catalogue
   figures in data-cat-car/van and data-raw-car/van are what's shown, so that is what the href
   carries.

   The bar's own [data-fare] figure is kept in sync by COPYING the matching tile's text, not by
   recomputing a number here — the tile is the one place that is always right, whichever script
   last wrote to it and whichever state (catalogue, engine, still pending) it is in.

   No JS at all → no listener ever runs. The static href already books the car — the checked
   radio at generation time — and the bar stays permanently hidden (shipped with `hidden`, and
   nothing here to ever remove it). The page is fully usable either way.

   The bar's IntersectionObserver only makes sense under the phone media query, and that query
   is watched, not just read once at load: a page loaded wide and later narrowed still gets the
   bar, and one loaded narrow and later widened stops observing (and hides the bar) rather than
   leaving the observer running forever.
   ============================================================ */
(function () {
  'use strict';
  var card = document.querySelector('[data-live-fares]');
  if (!card) return;
  var bar = document.querySelector('.trip-bookbar');
  var cardCta = card.querySelector('a.opt-cta');
  var links = [cardCta];
  if (bar) links.push(bar.querySelector('a.bar-cta'));

  function chosen() {
    var r = card.querySelector('input[name=vehicle]:checked');
    return r ? r.value : 'car';
  }

  function sync() {
    var v = chosen();
    var cents = card.getAttribute('data-engine-' + v);
    links.forEach(function (a) {
      if (!a) return;
      var parts = a.getAttribute('href').split('?');
      var params = new URLSearchParams(parts[1] || '');
      params.set('vehicle', v);
      if (cents) {
        params.set('price', String(Number(cents) / 100));
        params.delete('rawPrice');
      } else {
        params.set('price', card.getAttribute('data-cat-' + v));
        params.set('rawPrice', card.getAttribute('data-raw-' + v));
      }
      a.setAttribute('href', parts[0] + '?' + params.toString());
    });
    if (bar) {
      var label = bar.querySelector('[data-bar-label]');
      if (label) label.textContent = 'AC ' + v + ' · total, fixed';
      var fig = bar.querySelector('[data-fare]');
      var tile = card.querySelector('.veh [data-fare="' + v + '"]');
      if (fig && tile) {
        fig.setAttribute('data-fare', v);
        fig.textContent = tile.textContent;
      }
    }
  }

  card.addEventListener('change', sync);
  card.addEventListener('ch:fares', sync);
  // A back/forward navigation can restore a checked radio the browser remembered (bfcache or a
  // plain reload after a form autofill) while the static/last-rendered href still says car —
  // neither `change` nor `ch:fares` fires for that, so re-sync explicitly.
  window.addEventListener('pageshow', sync);
  sync();

  // The bar is phone-only, and "phone" can change mid-visit — a tablet rotated, or a desktop
  // window resized into or out of a split view. Reading matchMedia() once at load would either
  // never turn the bar on for a page loaded wide and later narrowed, or leave the observer
  // running forever on a page loaded narrow and later widened. So the observer itself is
  // created and torn down as the query's match state changes, not just read once.
  if (bar && 'IntersectionObserver' in window) {
    var mql = window.matchMedia('(max-width:900px)');
    var io = null;

    function startObserving() {
      if (io) return;
      io = new IntersectionObserver(function (entries) {
        bar.hidden = entries[0].isIntersecting;
      }, { threshold: 0 });
      io.observe(card);
    }
    function stopObserving() {
      if (!io) return;
      io.disconnect();
      io = null;
      bar.hidden = true;
    }
    function onMqlChange(e) {
      if (e.matches) startObserving(); else stopObserving();
    }

    if (mql.matches) startObserving();
    if (mql.addEventListener) mql.addEventListener('change', onMqlChange);
    else if (mql.addListener) mql.addListener(onMqlChange); // older Safari
  }
})();
