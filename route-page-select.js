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

  if (bar && 'IntersectionObserver' in window && window.matchMedia('(max-width:900px)').matches) {
    new IntersectionObserver(function (entries) {
      bar.hidden = entries[0].isIntersecting;
    }, { threshold: 0 }).observe(card);
  }
})();
