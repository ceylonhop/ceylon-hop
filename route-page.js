/* ============================================================
   CEYLON HOP — route page runtime (design A)
   docs/superpowers/plans/2026-08-16-unified-route-page.md

   STRICTLY A LAYER ON TOP. The page is already complete and sellable as
   static HTML — price, boarding points and CTAs are all in the markup a
   crawler sees. This file only adds what cannot be baked: the dates other
   travellers are actually on, and a date field to filter them.

   So every failure mode here is silent. No API, slow API, blocked by CORS,
   malformed response — the page keeps working exactly as generated.
   web-tests/unit/route-page-unified.test.js asserts the static half against
   script-stripped markup precisely so this file can never become load-bearing.
   ============================================================ */
(function () {
  'use strict';

  var host = document.querySelector('[data-shared-cta]');
  if (!host) return; // private-only route: nothing live to add
  var FROM = host.getAttribute('data-from');
  var TO = host.getAttribute('data-to');
  var MIN = parseInt(host.getAttribute('data-min') || '3', 10);
  if (!FROM || !TO) return;

  // Same contract as search.html/booking.html: `?api=off` disables, `?api=<origin>`
  // points elsewhere. Empty means the traveller turned it off — leave the static page be.
  var base = (window.CEYLON_HOP_API || '').replace(/\/$/, '');
  if (!base) return;

  var DAY = 86400000;
  var today = new Date(); today.setHours(0, 0, 0, 0);
  function iso(d) { return d.toISOString().slice(0, 10); }
  function fmt(d) {
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  var state = { date: null, lists: [] };

  /* ---- the live block, appended after the static CTA ---- */
  var live = document.createElement('div');
  live.className = 'live-dates';
  live.hidden = true;
  host.parentNode.insertBefore(live, host);

  function listOn(d) {
    for (var i = 0; i < state.lists.length; i++) {
      if (state.lists[i].date === iso(d)) return state.lists[i];
    }
    return null;
  }

  function rowsHtml() {
    var L = state.lists.slice().sort(function (a, b) {
      if (state.date) {
        var ea = a.date === iso(state.date) ? 1 : 0, eb = b.date === iso(state.date) ? 1 : 0;
        if (ea !== eb) return eb - ea;
      }
      return String(a.date).localeCompare(String(b.date));
    });
    var h = '';
    for (var i = 0; i < L.length; i++) {
      var l = L[i];
      var got = l.committed || 0;
      var need = Math.max(0, (l.minSeats || MIN) - got);
      var exact = state.date && l.date === iso(state.date);
      var when = new Date(l.date + 'T00:00:00');
      h += '<a class="ld-row' + (exact ? ' is-yours' : '') + '" href="board.html#/' + encodeURIComponent(l.code) + '">' +
        '<span class="ld-when">' + esc(fmt(when)) + (l.slot ? ' · ' + esc(l.slot) : '') +
        (exact ? ' <span class="ld-tag">your date</span>' : '') + '</span>' +
        '<span class="ld-count"><b>' + got + ' of ' + (l.minSeats || MIN) + '</b>' +
        (need > 0 ? ' — ' + need + ' more to run' : ' — running') + '</span>' +
        '<span class="ld-meter"><i style="width:' + Math.min(100, (got / (l.minSeats || MIN)) * 100) + '%"></i></span>' +
        '<span class="ld-go">→</span></a>';
    }
    return h;
  }

  function render() {
    var head, body = '';
    var mine = state.date ? listOn(state.date) : null;

    if (state.date && !mine) {
      // The traveller named a date nobody is on yet. Under design A this is not an
      // "unavailable" state — it is an invitation, and the only branch on the page.
      head = 'No one\'s going ' + esc(fmt(state.date)) + ' yet';
      body = '<p class="ld-first">Put your name down and it goes up instantly. Your card is saved and ' +
        '<b>charged only if ' + (MIN - 1) + ' more travellers join</b> — if they don\'t, you pay nothing.</p>';
      if (state.lists.length) {
        body += '<p class="ld-alt">Or join a date already gathering:</p><div class="ld-rows">' + rowsHtml() + '</div>';
      }
    } else if (!state.lists.length) {
      // Nobody on this route yet. The card promises "here are the dates people are on",
      // so saying nothing leaves it looking broken — and a route only ever gets its FIRST
      // list because someone was invited to start one. Ask, rather than showing a void.
      head = 'Be the first to pick a date';
      body = '<p class="ld-first">No one has put their name down on this route yet. ' +
        'Choose the day you want to travel and it goes up instantly — the van runs once ' +
        '<b>' + MIN + ' travellers</b> are going, and you pay nothing if it never fills.</p>';
    } else {
      var total = 0;
      for (var i = 0; i < state.lists.length; i++) total += state.lists[i].committed || 0;
      head = total + ' traveller' + (total === 1 ? ' is' : 's are') + ' already going this way';
      body = '<div class="ld-rows">' + rowsHtml() + '</div>';
    }

    live.hidden = false;
    live.innerHTML = '<div class="ld-head">' + head + '</div>' + body;
  }

  /* ---- the date field, added only once we know it can do something ---- */
  function mountDateField() {
    var bar = document.createElement('div');
    bar.className = 'ld-datebar';
    bar.innerHTML =
      '<button type="button" class="ld-chip is-on" data-flex>I\'m flexible</button>' +
      '<button type="button" class="ld-chip" data-pick>Choose a date</button>' +
      '<input type="date" class="ld-date" aria-label="travel date" min="' + iso(new Date(today.getTime() + DAY)) + '">';
    live.parentNode.insertBefore(bar, live);

    var flex = bar.querySelector('[data-flex]');
    var pick = bar.querySelector('[data-pick]');
    var input = bar.querySelector('.ld-date');

    function sync() {
      flex.classList.toggle('is-on', !state.date);
      pick.classList.toggle('is-on', !!state.date);
      pick.textContent = state.date ? fmt(state.date) + ' ✕' : 'Choose a date';
      render();
    }
    flex.addEventListener('click', function () { state.date = null; input.value = ''; sync(); });
    pick.addEventListener('click', function () {
      if (state.date) { state.date = null; input.value = ''; sync(); return; }
      if (input.showPicker) { try { input.showPicker(); } catch (e) { input.focus(); } } else input.focus();
    });
    input.addEventListener('change', function () {
      if (input.value) { state.date = new Date(input.value + 'T00:00:00'); sync(); }
    });
  }

  var qs = new URLSearchParams({ from: FROM, to: TO });
  fetch(base + '/board?' + qs.toString(), { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !Array.isArray(d.lists)) return;
      state.lists = d.lists.filter(function (l) {
        return l.status === 'gathering' || l.status === 'confirmed';
      });
      mountDateField();
      render();
    })
    .catch(function () { /* silent: the static page is already the offer */ });
})();
