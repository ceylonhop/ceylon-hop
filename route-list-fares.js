/* ============================================================
   CEYLON HOP — list fares
   ============================================================
   A LIST price advertises the engine's fare too (spec 2026-09-21 §6). The /trip/ index and
   the "where next" cards bake the catalogue fare; the page each one links to shows the
   engine's (hot zones live in the prod DB). Kandy → Ella read $59.99 here, $66 there.

   ch-pricing.js tracks one intent at a time, so a list cannot use it. This asks
   POST /quote/v2/estimate-batch ONCE for every distinct pair on the page — car fares, the
   "from" price — and writes the answers in.

   Same rules as route-page-fares.js: the <head> sets `list-fares-pending` before first paint
   (figures held transparent, in place) and releases it on its own timer; a fare that has been
   SHOWN never changes, so an answer later than CAP_MS is dropped; and every failure — no API,
   ?api=off, 404, a null row, a network error, this file not loading — ends at the catalogue
   figure already in the markup. Silently.
   ============================================================ */
(function () {
  'use strict';
  var CAP_MS = 4000;
  var root = document.documentElement;
  function release() { root.classList.remove('list-fares-pending'); }

  var els = Array.prototype.slice.call(document.querySelectorAll('[data-list-fare][data-from-name][data-to-name]'));
  if (!els.length || !window.CEYLON_HOP_API || !window.fetch) return release();

  var keys = [], intents = [];
  els.forEach(function (el) {
    var from = el.getAttribute('data-from-name'), to = el.getAttribute('data-to-name');
    var k = from + '|' + to;
    if (keys.indexOf(k) !== -1) return;
    // More than 60 distinct pairs cannot be priced in one batch request (API cap); leave the
    // rest on catalogue rather than send a request the API would reject outright.
    if (keys.length >= 60) return;
    keys.push(k);
    // Key order is search.js's and route-page-fares.js's. Keep it.
    intents.push({ vehicle: 'car', product: 'private', pax: 1, bags: 0, legs: [{ from: from, to: to }], extras: [] });
  });

  if (!intents.length) return release();

  var settled = false;
  var cap = setTimeout(function () { settled = true; release(); }, CAP_MS);
  function money(cents) { return '$' + (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)); }

  fetch(window.CEYLON_HOP_API.replace(/\/$/, '') + '/quote/v2/estimate-batch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intents: intents })
  }).then(function (res) { return res.ok ? res.json() : null; }).then(function (body) {
    if (settled) return;                      // the cap already showed the catalogue fares
    settled = true;
    clearTimeout(cap);
    var results = body && body.results;
    if (results && results.length === keys.length) {
      els.forEach(function (el) {
        var idx = keys.indexOf(el.getAttribute('data-from-name') + '|' + el.getAttribute('data-to-name'));
        var r = idx !== -1 ? results[idx] : null;
        if (r && typeof r.totalCents === 'number') el.textContent = money(r.totalCents);
      });
    }
    release();
  }).catch(function () {
    // F5 fix: release() unconditionally (idempotent — classList.remove) — the .then above sets
    // settled = true before its own release(), so if anything in that handler throws (a bad
    // response shape, a DOM surprise), the old `if (!settled) release()` guard here found
    // settled already true and skipped release too, leaving the figures held until CAP_MS.
    if (!settled) { settled = true; clearTimeout(cap); }
    release();
  });
})();
