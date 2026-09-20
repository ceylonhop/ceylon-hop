/* ============================================================
   CEYLON HOP — route page fares
   ============================================================
   A route page advertises the ENGINE's fare (owner decision 2026-09-20, "Option A").

   The fares in the markup are baked from the catalogue. Hot zones are rows in the prod
   database, so the catalogue cannot know them: Kandy → Ella said $59.99 here and charged $66
   on the booking page. search.html got this rule first (#648); this is the same rule for
   /trip/, and the intent below is byte-identical to search.js's so the two pages share one
   sessionStorage answer.

   The page's <head> adds `fares-pending` before first paint, which holds every [data-fare]
   figure back (transparent, in place). This file asks the engine for the car fare, then the
   van fare — one after the other, because ch-pricing.js tracks one intent at a time — writes
   them in, and releases the hold. A fare that has been SHOWN never changes: once the cap has
   released the catalogue fares, a late answer is dropped.

   Every failure is silent and ends the same way — the catalogue fares, exactly as generated:
   no API, ?api=off, engine switched off (404), unreachable, slower than CAP_MS, or this file
   not loading at all (the <head> releases the hold on its own timer).
   ============================================================ */
(function () {
  'use strict';
  var CAP_MS = 4000;
  var root = document.documentElement;
  function release() { root.classList.remove('fares-pending'); }

  var card = document.querySelector('[data-live-fares]');
  var from = card && card.getAttribute('data-from-name');
  var to = card && card.getAttribute('data-to-name');
  if (!card || !from || !to || !window.CEYLON_HOP_API || !window.CH_PRICING) return release();

  var settled = false;
  var cap = setTimeout(function () { settled = true; release(); }, CAP_MS);

  function ask(vehicle) {
    return new Promise(function (resolve) {
      // Key order matters: ch-pricing caches on JSON.stringify(intent), and this is search.js's.
      window.CH_PRICING.estimate(
        { vehicle: vehicle, product: 'private', pax: 1, bags: 0, legs: [{ from: from, to: to }], extras: [] },
        { onResult: resolve, onUnavailable: function () { resolve(null); } },
        { immediate: true });
    });
  }
  function money(cents) { return '$' + (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)); }

  ask('car').then(function (car) {
    return ask('van').then(function (van) { return [car, van]; });
  }).then(function (res) {
    if (settled) return;                       // the cap already showed the catalogue fares
    settled = true;
    clearTimeout(cap);
    var car = res[0], van = res[1];
    if (car && van && typeof car.totalCents === 'number' && typeof van.totalCents === 'number') {
      var fares = { car: money(car.totalCents), van: money(van.totalCents) };
      Array.prototype.forEach.call(document.querySelectorAll('[data-fare]'), function (el) {
        var f = fares[el.getAttribute('data-fare')];
        if (f) el.textContent = f;
      });
      // The CTA books the car. booking.js reads rawPrice FIRST, so the catalogue's unfinished
      // figure must not ride along beside an engine fare — it would win over the price shown.
      var cta = card.querySelector('a.opt-cta');
      if (cta) {
        var parts = cta.getAttribute('href').split('?');
        var q = new URLSearchParams(parts[1] || '');
        q.set('price', String(car.totalCents / 100));
        q.delete('rawPrice');
        cta.setAttribute('href', parts[0] + '?' + q.toString());
      }
    }
    release();
  });
})();
