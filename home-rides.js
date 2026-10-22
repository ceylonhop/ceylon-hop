/* home-rides.js — "Travel with others?" on the home page (plan
   docs/superpowers/plans/2026-10-19-ride-board-fomo.md, PR 2; design revised 2026-10-21). The
   open shared-taxi rides that still need people, stacked: who's going, seats to go, when names
   close, and the bus the seat beats. Each card is ONE link to the board, landed on that ride
   (board.html?hl=CODE). Data: GET /board (public). Words and urgency: ride-fomo.js, the helper
   the board rows use, so the two pages never disagree. The section is shown before first paint
   by an inline script and hidden again only when there is nothing real to show.

   Says "shared taxi" on every card, and compares with the bus — never with our own private car,
   which this page sells (spec 2026-07-23, "Positioning"). */
(function () {
  var sec = document.getElementById('home-rides');
  var list = document.getElementById('hr-list');
  var F = window.CHRideFomo;
  var API = String(window.CEYLON_HOP_API || '').replace(/\/$/, '');
  if (!sec || !list) return;
  if (!F || !API) { sec.hidden = true; return; }

  var MAX = 4;
  var SLOT = { morning: '7–9 am', afternoon: '1–3 pm' };
  var AV = ['#0AB9B6', '#63BFD6', '#F9A429', '#8f7ad6', '#4aa66a', '#d66a9c', '#e0745f']; // board.js's avatar colours
  var MINUTES = { minutes: true }; // never a second hand on the home page

  function track(n, p) { try { if (window.chTrack) window.chTrack(n, p || {}); } catch (e) {} }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { n = Number(n) || 0; return '$' + (Number.isInteger(n) ? String(n) : n.toFixed(2)); }
  function flagOf(c) {
    c = String(c || '').trim();
    if (!/^[A-Za-z]{2}$/.test(c)) return c;
    var up = c.toUpperCase();
    return String.fromCodePoint(0x1F1E6 + up.charCodeAt(0) - 65, 0x1F1E6 + up.charCodeAt(1) - 65);
  }
  // "Colombo Airport (CMB)" → "Colombo Airport", "Sigiriya / Dambulla" → "Sigiriya"
  function mainName(n) { return String(n || '').split(/\s*[(\/]/)[0].trim(); }
  function day(iso) {
    return /^\d{4}-\d{2}-\d{2}$/.test(iso || '')
      ? new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
      : '';
  }
  function fromWire(pl) {
    return {
      code: pl.code, corridorId: pl.corridorId || null, from: pl.from || '', to: pl.to || '', date: pl.date, slot: pl.slot || 'morning',
      minSeats: pl.minSeats != null ? pl.minSeats : 3, capacity: pl.capacity != null ? pl.capacity : 6,
      committed: pl.committed != null ? pl.committed : (pl.members || []).length,
      confirmed: pl.status === 'confirmed', cancelled: pl.status === 'cancelled' || pl.status === 'expired',
      cutoffMs: pl.cutoffAt ? Date.parse(pl.cutoffAt) : NaN,
      cost: (Number(pl.seatPrice) || 0) / 100,
      members: (pl.members || []).map(function (m) { return { name: m.firstName || '', flag: flagOf(m.country), photoUrl: m.photoUrl || null }; })
    };
  }
  function face(m, i) {
    return '<span class="hr-face" style="background:' + AV[i % AV.length] + '">' + esc((m.name || '·').slice(0, 2).toUpperCase()) +
      (m.photoUrl ? '<img src="' + esc(m.photoUrl) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '') +
      (m.flag ? '<span class="hr-flag">' + m.flag + '</span>' : '') + '</span>';
  }
  function card(L, now) {
    var togo = F.seatsToGo(L), closes = F.closesText(L.cutoffMs, now, MINUTES), bus = F.busTime(L.corridorId);
    var faces = L.members.slice(0, 4).map(face).join('');
    for (var k = 0; k < Math.min(togo.need, 3); k++) faces += '<span class="hr-face hr-open" aria-hidden="true">+</span>';
    return '<a class="hr-card" href="board.html?hl=' + encodeURIComponent(L.code) + '" data-ride="' + esc(L.code) + '">' +
      '<div class="hr-top"><h3 class="hr-route">' + esc(mainName(L.from)) + ' <span class="hr-arr" aria-hidden="true">→</span><span class="hr-sr"> to </span> ' + esc(mainName(L.to)) + '</h3>' +
        '<span class="hr-togo' + (togo.hot ? ' hot' : '') + '">' + esc(togo.text) + '</span></div>' +
      '<div class="hr-who"><span class="hr-faces">' + faces + '</span><span class="hr-meta">' +
        '<span class="hr-kind"><b>Shared taxi</b> · ' + esc(day(L.date)) + ' · ' + esc(SLOT[L.slot] || SLOT.morning) + '</span>' +
        (closes ? '<span class="hr-close' + (closes.urgent ? ' urgent' : '') + '" data-close="' + L.cutoffMs + '">' + esc(closes.text) + '</span>' : '') +
      '</span></div>' +
      '<div class="hr-foot-row"><span class="hr-price"><b>' + money(L.cost) + '</b> a seat' + (bus ? ' · or ' + esc(bus) : '') + '</span>' +
        '<span class="hr-go">See it on the board ›</span></div>' +
      '</a>';
  }
  function render(lists) {
    var now = Date.now();
    var rides = F.stripRides(lists.map(fromWire), now, MAX);
    if (!rides.length) { sec.hidden = true; return; }
    list.removeAttribute('aria-busy');
    list.innerHTML = rides.map(function (L) { return card(L, now); }).join('');
    list.querySelectorAll('[data-ride]').forEach(function (a) {
      a.addEventListener('click', function () {
        track('select_item', { item_list_id: 'home_rides', item_list_name: 'Home: travel with others', item_id: a.getAttribute('data-ride') });
      });
    });
  }

  fetch(API + '/board', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (!d || !Array.isArray(d.lists)) { sec.hidden = true; return; } render(d.lists); })
    .catch(function () { sec.hidden = true; });

  // Minutes only, so once a minute is plenty.
  setInterval(function () {
    var now = Date.now();
    list.querySelectorAll('[data-close]').forEach(function (el) {
      var c = F.closesText(+el.getAttribute('data-close'), now, MINUTES);
      if (!c) return;
      if (el.textContent !== c.text) el.textContent = c.text;
      el.classList.toggle('urgent', c.urgent);
    });
  }, 30000);
})();
