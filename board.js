/* ============================================================
   CEYLON HOP — THE RIDE BOARD (production logic)
   Ports the approved prototype (docs/prototypes/ride-board-prototype.html)
   and wires it to the real board API. Design/markup/classes are kept
   identical; the in-memory LISTS / fake-login / fake-actions are replaced
   with real fetch() calls (credentials included).

   Pure, side-effect-free helpers are exposed on window.RideBoard for unit
   tests. The DOM app only boots when the board markup is present, so the
   file can be eval'd in jsdom to test the helpers without a server.
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- static reference data (design copy) ---------------- */
  // Fallback display names + set pickup/drop-off points, keyed by place id.
  // The API returns from/to as NAMES; these power the pickup blurb + name→id
  // resolution only, and always fall back to the raw name when unknown.
  var PLACE_NAMES = {
    'cmb-airport': 'Airport (CMB)', 'colombo': 'Colombo', 'negombo': 'Negombo', 'bentota': 'Bentota',
    'hikkaduwa': 'Hikkaduwa', 'galle': 'Galle', 'weligama': 'Weligama', 'mirissa': 'Mirissa',
    'kandy': 'Kandy', 'nuwara-eliya': 'Nuwara Eliya', 'ella': 'Ella', 'sigiriya': 'Sigiriya',
    'anuradhapura': 'Anuradhapura', 'yala': 'Yala', 'arugam-bay': 'Arugam Bay', 'trincomalee': 'Trincomalee'
  };
  var POINTS = {
    'cmb-airport': 'Airport arrivals hall (CMB)', 'colombo': 'Colombo — Fort / Galle Face', 'negombo': 'Negombo — beach road',
    'bentota': 'Bentota — main junction', 'hikkaduwa': 'Hikkaduwa — beach road', 'galle': 'Galle — Fort clock tower',
    'weligama': 'Weligama — bay road', 'mirissa': 'Mirissa — beach entrance', 'kandy': 'Kandy — lake roundabout',
    'nuwara-eliya': 'Nuwara Eliya — town centre', 'ella': 'Ella — main street (by the station)', 'sigiriya': 'Sigiriya — Dambulla junction',
    'anuradhapura': 'Anuradhapura — town centre', 'yala': 'Tissamaharama — town centre', 'arugam-bay': 'Arugam Bay — main point', 'trincomalee': 'Trincomalee — town centre'
  };
  // Departure windows — a list gathers on a slot; the exact time is set when it locks.
  var SLOTS = {
    morning: { label: 'morning', range: 'departs 7–9 am', opts: ['07:00', '08:00', '09:00'] },
    afternoon: { label: 'afternoon', range: 'departs 1–3 pm', opts: ['13:00', '14:00', '15:00'] }
  };
  // Private-car fare + rough bus time per corridor — for the "you travel either way" framing.
  var ALT = {
    'airport-cultural': { priv: 62, bus: '6h bus' }, 'hill-line': { priv: 68, bus: '7h bus + train' }, 'ella-east': { priv: 74, bus: '6h bus' },
    'south-coast': { priv: 45, bus: '2.5h bus' }, 'yala-south': { priv: 52, bus: '5h bus' }, 'ella-south': { priv: 78, bus: '7h bus' }
  };
  var CORRIDOR_TIME = {
    'airport-cultural': '~4h door to door', 'hill-line': '~3.5h door to door', 'ella-east': '~3h door to door',
    'south-coast': '~1.5h door to door', 'yala-south': '~2.5h door to door', 'ella-south': '~3.5h door to door'
  };
  var AV = ['#0AB9B6', '#63BFD6', '#F9A429', '#8f7ad6', '#4aa66a', '#d66a9c', '#e0745f'];
  var MIN_DEFAULT = 4;   // names needed to lock the van (per-list minSeats overrides)
  var CAP_DEFAULT = 6;   // seats in the van (per-list capacity overrides)
  var TA_URL = 'https://www.tripadvisor.com/Attraction_Review-g3736162-d33018957-Reviews-Ceylon_Hop-Seeduwa_Western_Province.html';

  // name → id index (best-effort): prototype short names + transfers-data full names.
  var NAME2ID = {};
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
  Object.keys(PLACE_NAMES).forEach(function (id) { NAME2ID[norm(PLACE_NAMES[id])] = id; });
  (function () {
    var T = (typeof window !== 'undefined') && window.TRANSFERS;
    if (T && Array.isArray(T.PLACES)) {
      T.PLACES.forEach(function (p) {
        NAME2ID[norm(p.name)] = p.id;
        NAME2ID[norm(p.name.split(/[\s(\/]/)[0])] = NAME2ID[norm(p.name.split(/[\s(\/]/)[0])] || p.id; // first token
      });
    }
  })();
  NAME2ID[norm('Airport')] = 'cmb-airport';
  NAME2ID[norm('CMB')] = 'cmb-airport';
  function resolvePlaceId(name) { return NAME2ID[norm(name)] || null; }
  function pointFor(name, id) {
    var pid = id || resolvePlaceId(name);
    return (pid && POINTS[pid]) || String(name || '');
  }

  /* ---------------- PURE helpers (unit-tested) ---------------- */

  // Remaining-time formatter. Takes remaining milliseconds (a duration, not a
  // timestamp) so it is pure. Clamps at zero.
  function fmtCountdown(ms) {
    var s = Math.max(0, Math.floor(Number(ms) || 0));
    var h = Math.floor(s / 3600000), m = Math.floor((s % 3600000) / 60000), sec = Math.floor((s % 60000) / 1000);
    if (h >= 24) { var d = Math.floor(h / 24); return d + 'd ' + (h % 24) + 'h'; }
    if (h >= 1) return h + 'h ' + String(m).padStart(2, '0') + 'm';
    return m + 'm ' + String(sec).padStart(2, '0') + 's';
  }

  // The departure window for a slot key ('morning' | 'afternoon'); defaults to morning.
  function slotWindow(slot) { return SLOTS[slot] || SLOTS.morning; }

  // Integer cents → dollars (number). seatPrice arrives as integer cents.
  function centsToDollars(cents) {
    var n = Number(cents);
    if (!isFinite(n)) return 0;
    return Math.round(n) / 100;
  }

  // "$24" for whole dollars, "$24.50" otherwise.
  function money(dollars) {
    var n = Number(dollars) || 0;
    return '$' + (Number.isInteger(n) ? String(n) : n.toFixed(2));
  }

  // Short-code country → flag emoji. Passes through anything that isn't a
  // 2-letter code (already an emoji, or a 3–4 letter code) so it never breaks.
  function flagOf(country) {
    if (!country) return '';
    var c = String(country).trim();
    if (/^[A-Za-z]{2}$/.test(c)) {
      var up = c.toUpperCase();
      return String.fromCodePoint(0x1F1E6 + up.charCodeAt(0) - 65, 0x1F1E6 + up.charCodeAt(1) - 65);
    }
    return c;
  }

  // ISO date (or date-only) → "Sat 8 Aug". Date-only strings are pinned to local
  // midnight so the weekday never drifts a day across time zones.
  function fmtDate(iso) {
    if (!iso) return '';
    var d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T00:00:00') : new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  // Seat-scarcity language for a normalized list (or any {committed,minSeats,capacity,confirmed|status}).
  function scarcityText(list) {
    var min = list.minSeats != null ? list.minSeats : MIN_DEFAULT;
    var cap = list.capacity != null ? list.capacity : CAP_DEFAULT;
    var committed = list.committed != null ? list.committed : (list.members ? list.members.length : 0);
    var confirmed = list.confirmed != null ? list.confirmed : (list.status === 'confirmed');
    var need = Math.max(0, min - committed);
    var conf = confirmed || need === 0;
    var left = Math.max(0, cap - committed);
    if (conf) return { cls: 'pill-teal pill-dot', txt: 'Locked in 🚐 · ' + left + ' seat' + (left === 1 ? '' : 's') + ' left' };
    if (need === 1) return { cls: 'pill-tomato pill-dot pill-pulse', txt: '1 seat to lock it in — almost there' };
    return { cls: 'pill-saffron pill-dot', txt: need + ' seats to lock it in' };
  }

  // The board card's "when" line.
  function whenLine(list) {
    var s = slotWindow(list.slot);
    return list.confirmed
      ? list.whenLabel + ' · departs ' + (list.lockedTime || s.opts[1])
      : list.whenLabel + ' · ' + s.label + ' · ' + s.range;
  }

  // PublicList (wire shape) → the internal card model the renderers use.
  // Pure: no Date.now(), no DOM. This is the "projectionToCard" formatter.
  function normalizeList(pl) {
    pl = pl || {};
    var status = pl.status || 'gathering';
    var members = (pl.members || []).map(function (m, i) {
      return {
        position: m.position != null ? m.position : (i + 1),
        name: m.firstName || m.name || '',
        country: m.country || '',
        flag: flagOf(m.country),
        photoUrl: m.photoUrl || null,
        isStarter: !!m.isStarter
      };
    });
    var committed = pl.committed != null ? pl.committed : members.length;
    return {
      code: pl.code,
      corridorId: pl.corridorId || null,
      from: pl.from || '',
      to: pl.to || '',
      fromId: resolvePlaceId(pl.from),
      toId: resolvePlaceId(pl.to),
      date: pl.date || null,
      whenLabel: fmtDate(pl.date),
      slot: pl.slot || 'morning',
      lockedTime: pl.lockedTime || null,
      minSeats: pl.minSeats != null ? pl.minSeats : MIN_DEFAULT,
      capacity: pl.capacity != null ? pl.capacity : CAP_DEFAULT,
      seatPriceCents: pl.seatPrice != null ? pl.seatPrice : null,
      cost: centsToDollars(pl.seatPrice),
      status: status,
      confirmed: status === 'confirmed',
      cancelled: status === 'cancelled' || status === 'expired',
      note: pl.note || null,
      cutoffAt: pl.cutoffAt || null,
      cutoffMs: pl.cutoffAt ? Date.parse(pl.cutoffAt) : NaN,
      committed: committed,
      members: members
    };
  }

  var RideBoard = {
    fmtCountdown: fmtCountdown,
    slotWindow: slotWindow,
    scarcityText: scarcityText,
    whenLine: whenLine,
    normalizeList: normalizeList,
    centsToDollars: centsToDollars,
    money: money,
    flagOf: flagOf,
    fmtDate: fmtDate,
    resolvePlaceId: resolvePlaceId,
    SLOTS: SLOTS,
    MIN_DEFAULT: MIN_DEFAULT,
    CAP_DEFAULT: CAP_DEFAULT
  };
  if (typeof window !== 'undefined') window.RideBoard = RideBoard;

  /* ============================================================
     Everything below is the DOM app — only runs on the board page.
     ============================================================ */
  if (typeof document === 'undefined' || !document.getElementById('board-grid')) return;

  var API_BASE = (window.CEYLON_HOP_API || 'https://ceylon-hop-api.onrender.com').replace(/\/$/, '');
  var CLIENT_ID = String(window.GOOGLE_CLIENT_ID || '').trim();
  var SHARE_ORIGIN = 'https://ceylonhop.com';

  var state = {
    me: null,
    lists: [],            // currently displayed normalized lists
    byCode: {},           // code → normalized list (detail cache)
    mineCodes: new Set(), // lists the signed-in user is on
    manageTokens: {},     // code → manageToken (from create/join)
    fromOptions: [],      // union of from-names seen (filter select, never shrinks)
    filter: { from: 'all', when: 'all', mine: false },
    detailId: null,
    pendingCredential: null,
    gisReady: false
  };

  /* ---------------- escaping ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- API layer ---------------- */
  function apiFetch(path, opts) {
    opts = opts || {};
    opts.credentials = 'include';
    return fetch(API_BASE + path, opts).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error((data && data.error) || ('http_' + res.status));
          err.status = res.status; err.body = data;
          throw err;
        }
        return data;
      });
    });
  }
  function apiGet(path) { return apiFetch(path); }
  function apiPost(path, body) {
    return apiFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
  }

  /* ---------------- toast ---------------- */
  var toastEl = document.getElementById('toast');
  var toastTimer = null;
  function toast(title, sub) {
    if (!toastEl) return;
    toastEl.innerHTML = '<b>' + esc(title) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '');
    toastEl.hidden = false;
    // force reflow so the transition plays
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
      setTimeout(function () { toastEl.hidden = true; }, 500);
    }, 4200);
  }

  /* ---------------- countdown helpers (impure wrappers) ---------------- */
  function remaining(cutoffMs) { return (cutoffMs || 0) - Date.now(); }
  function isUrgent(cutoffMs) { return isFinite(cutoffMs) && remaining(cutoffMs) < 3 * 3600000; }
  function cdHtml(cutoffMs) { return '<span class="cd">closes in ' + esc(fmtCountdown(remaining(cutoffMs))) + '</span>'; }

  /* ---------------- identity helpers ---------------- */
  var iAmOn = function (L) { return state.mineCodes.has(L.code); };
  function isYouMember(L, m) {
    return iAmOn(L) && state.me &&
      m.name === state.me.firstName &&
      (!state.me.country || !m.country || m.country === state.me.country);
  }

  /* ---------------- avatar / rows ---------------- */
  function avatar(m, i, cls) {
    var name = m.name || '';
    var ini = (name.slice(0, 2).toUpperCase()) || '·';
    var color = AV[((i % AV.length) + AV.length) % AV.length];
    var img = m.photoUrl
      ? '<img src="' + esc(m.photoUrl) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">'
      : '';
    var flag = m.flag ? '<span class="flag">' + m.flag + '</span>' : '';
    return '<span class="avatar ' + (cls || '') + '" style="background:' + color + '">' +
      '<span class="ini">' + esc(ini) + '</span>' + img + flag + '</span>';
  }

  function listRows(L) {
    var rows = [];
    var min = L.minSeats;
    var members = L.members;
    var over = members.length > min;
    var shown = over ? members.slice(0, min - 1) : members;
    var openUsed = false;
    shown.forEach(function (m, i) {
      var you = isYouMember(L, m);
      rows.push('<div class="lrow ' + (you ? 'you' : '') + '">' +
        '<span class="num">' + (i + 1) + '.</span>' + avatar(m, i) +
        '<span class="who">' + esc(m.name) + (you ? ' <small>(you)</small>' : '') +
        (m.isStarter ? ' <small>started this list</small>' : '') + '</span></div>');
    });
    if (over) {
      var rest = members.slice(min - 1);
      var stack = rest.slice(0, 3).map(function (m, i) { return avatar(m, (min - 1 + i), 'xs' + (i ? ' stack' : '')); }).join('');
      rows.push('<div class="lrow"><span class="num">' + min + '.</span>' +
        '<span style="display:flex;align-items:center">' + stack + '</span>' +
        '<span class="who" style="font-size:.85rem;color:var(--ink-soft)">+' + rest.length + ' also riding</span></div>');
    } else {
      for (var i = shown.length; i < min; i++) {
        if (!openUsed && !L.confirmed) {
          openUsed = true;
          rows.push('<div class="lrow open" data-join="' + esc(L.code) + '">' +
            '<span class="num">' + (i + 1) + '.</span>' +
            '<span class="slot"><span class="hand">your name here?</span><span class="dash"></span></span></div>');
        } else {
          rows.push('<div class="lrow open ghost" data-join="' + esc(L.code) + '">' +
            '<span class="num">' + (i + 1) + '.</span>' +
            '<span class="slot"><span class="hand">·</span><span class="dash"></span></span></div>');
        }
      }
    }
    return rows.join('');
  }

  function taBadge(caption) {
    return '<a class="ta" href="' + TA_URL + '" target="_blank" rel="noopener" title="Ceylon Hop on Tripadvisor">' +
      '<span class="owl"><i></i><i class="h"></i></span><b>Tripadvisor</b>' +
      '<span class="bubbles"><i></i><i></i><i></i><i></i><i></i></span>' +
      '<span class="t">' + esc(caption || '5.0 · loved by travellers') + '</span></a>';
  }

  /* ---------------- board card ---------------- */
  function card(L) {
    var min = L.minSeats;
    var need = Math.max(0, min - L.committed);
    var conf = L.confirmed || need === 0;
    var hot = !conf && need === 1;
    var mine = iAmOn(L);
    var sc = scarcityText(L);
    var alt = ALT[L.corridorId] || { priv: 0, bus: '' };
    var dots = Array.apply(null, { length: min }).map(function (_, i) {
      return '<i class="' + (i < Math.min(L.committed, min) ? 'f' : '') + '"></i>';
    }).join('');
    var clock = conf
      ? '<span class="m"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>locked ✓</span>'
      : '<span class="m countdown ' + (isUrgent(L.cutoffMs) ? 'urgent' : '') + '" data-cut="' + L.cutoffMs + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' + cdHtml(L.cutoffMs) + '</span>';
    var starter = L.members[0];
    return '<article class="lcard ' + (conf ? 'confirmed' : '') + ' ' + (hot ? 'hot' : '') + ' ' + (mine ? 'mine' : '') + ' reveal">' +
      (conf ? '<span class="stamp"><b>It\'s on!</b>van locked</span>' : '') +
      (mine ? '<span class="mine-tag">You\'re on this ✓</span>' : '') +
      '<div class="lcard-top">' +
      '<div class="lcard-route">' + esc(L.from) + ' <span class="arr">→</span> ' + esc(L.to) + '</div>' +
      '<div class="lcard-meta">' +
      '<span class="m"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>' + esc(whenLine(L)) + '</span>' +
      clock +
      '</div>' +
      '<div class="lcard-status">' +
      '<span class="pill ' + sc.cls + '">' + sc.txt + '</span>' +
      '<span class="goal-dots">' + dots + '</span>' +
      '</div>' +
      '</div>' +
      '<div class="tear"></div>' +
      '<div class="lcard-list">' + listRows(L) + '</div>' +
      '<div class="lcard-foot">' +
      '<div class="lprice">≈ <b>' + money(L.cost) + '</b> each · <span class="free">$0 to join</span>' +
      (alt.priv ? '<br><span class="vs">vs $' + alt.priv + ' private · ' + esc(alt.bus) + '</span>' : '') + '</div>' +
      '<button class="btn ' + (conf ? 'btn-ghost' : (mine ? 'btn-ghost' : 'btn-primary')) + ' btn-sm" data-view="' + esc(L.code) + '">' +
      (mine ? 'View your ride' : conf ? 'See ride · hop on' : 'See ride & join') +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>' +
      '</div>' +
      (L.note
        ? '<div class="started"><svg style="width:14px;height:14px;color:var(--accent-deep)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg><b>' + esc(starter ? starter.name : '') + ':</b>&nbsp;"' + esc(L.note) + '"</div>'
        : (starter ? '<div class="started">started by ' + avatar(starter, 0) + ' <b>' + esc(starter.name) + '</b></div>' : '')) +
      '</article>';
  }

  var grid = document.getElementById('board-grid');
  var filtersEl = document.getElementById('filters');

  function render() {
    var shown = state.lists;
    var empty = shown.length === 0
      ? '<div class="board-empty"><div class="plus">🗺️</div>' +
        '<h3>No lists match yet' + (state.filter.mine ? " — you haven't joined any" : '') + '.</h3>' +
        '<p>' + (state.filter.mine ? 'Add your name to a ride and it shows up here.' : "Be the first to start this one — we'll help gather names, and you travel either way.") + '</p>' +
        '<button class="btn btn-primary" id="empty-start">' + (state.filter.mine ? 'Browse the board' : 'Start this list') + '</button></div>'
      : '';
    grid.innerHTML = shown.map(card).join('') + empty +
      '<button class="lcard-new reveal" id="new-list"><div>' +
      '<div class="plus">+</div><h3>Your ride\'s not up here?</h3>' +
      '<p>Start your own list on any route, any day — we help gather names.</p>' +
      '<span class="hand">you\'re name #1 ✍️</span></div></button>';

    var es = document.getElementById('empty-start');
    if (es) es.addEventListener('click', function () {
      if (state.filter.mine) { state.filter.mine = false; loadBoard(); }
      else openModal(null);
    });
    grid.querySelectorAll('[data-join]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); openDetail(el.getAttribute('data-join'), true); });
    });
    grid.querySelectorAll('[data-view]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); openDetail(el.getAttribute('data-view')); });
    });
    grid.querySelectorAll('.lcard').forEach(function (c) {
      c.addEventListener('click', function (e) {
        if (e.target.closest('[data-join],[data-view],a')) return;
        var btn = c.querySelector('[data-view]');
        if (btn) openDetail(btn.getAttribute('data-view'));
      });
    });
    var nl = document.getElementById('new-list');
    if (nl) nl.addEventListener('click', function () { openModal(null); });
    observe();
  }

  function updateMyRidesButton() {
    var n = state.mineCodes.size;
    var btn = document.getElementById('my-rides-btn');
    if (!btn) return;
    btn.hidden = n === 0;
    var c = document.getElementById('mr-count');
    if (c) c.textContent = n;
  }

  function rememberFromOptions(lists) {
    var seen = {};
    state.fromOptions.forEach(function (n) { seen[n] = true; });
    lists.forEach(function (L) { if (L.from) seen[L.from] = true; });
    state.fromOptions = Object.keys(seen).sort(function (a, b) { return a.localeCompare(b); });
  }

  function renderFilters() {
    var open = state.lists.filter(function (L) { return !L.confirmed && L.committed < L.minSeats; }).length;
    var mineN = state.mineCodes.size;
    var f = state.filter;
    filtersEl.innerHTML =
      '<label class="fsel"><span>Leaving from</span>' +
      '<select id="f-from"><option value="all">Anywhere</option>' +
      state.fromOptions.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('') +
      '</select></label>' +
      '<label class="fsel"><span>When</span>' +
      '<select id="f-when"><option value="all">Any time</option><option value="week">This week</option><option value="fortnight">Next 2 weeks</option></select></label>' +
      (mineN ? '<button class="chip ' + (f.mine ? 'active' : '') + '" id="f-mine">My rides · ' + mineN + '</button>' : '') +
      ((f.from !== 'all' || f.when !== 'all' || f.mine) ? '<button class="chip ghost" id="f-clear">Clear</button>' : '') +
      '<span class="count"><b>' + open + '</b> gathering now</span>';
    var ff = document.getElementById('f-from'), fw = document.getElementById('f-when');
    ff.value = f.from; fw.value = f.when;
    ff.addEventListener('change', function () { f.from = ff.value; f.mine = false; loadBoard(); });
    fw.addEventListener('change', function () { f.when = fw.value; f.mine = false; loadBoard(); });
    var fm = document.getElementById('f-mine');
    if (fm) fm.addEventListener('click', function () { if (f.mine) { f.mine = false; loadBoard(); } else showMine(); });
    var fc = document.getElementById('f-clear');
    if (fc) fc.addEventListener('click', function () { f.from = 'all'; f.when = 'all'; f.mine = false; loadBoard(); });
  }

  /* ---------------- board loads ---------------- */
  function loadBoard() {
    state.filter.mine = false;
    var qs = [];
    if (state.filter.from !== 'all') qs.push('from=' + encodeURIComponent(state.filter.from));
    if (state.filter.when !== 'all') qs.push('when=' + encodeURIComponent(state.filter.when));
    var path = '/board' + (qs.length ? '?' + qs.join('&') : '');
    return apiGet(path).then(function (data) {
      var lists = ((data && data.lists) || []).map(normalizeList);
      lists.forEach(function (L) { state.byCode[L.code] = L; });
      rememberFromOptions(lists);
      state.lists = lists;
      renderFilters();
      render();
    }).catch(function (e) {
      state.lists = [];
      renderFilters();
      grid.innerHTML =
        '<div class="board-empty"><div class="plus">📡</div><h3>Couldn\'t reach the board.</h3>' +
        '<p>Check your connection and try again — nothing on your side is lost.</p>' +
        '<button class="btn btn-primary" id="retry-board">Try again</button></div>';
      var r = document.getElementById('retry-board');
      if (r) r.addEventListener('click', loadBoard);
      report(e);
    });
  }

  function showMine() {
    if (!state.me) { toast('Sign in to see your rides', 'Join a ride first and it shows up here.'); return; }
    state.filter.mine = true; state.filter.from = 'all'; state.filter.when = 'all';
    if (document.body.classList.contains('detail-open')) closeDetail();
    return apiGet('/board/mine').then(function (data) {
      var lists = ((data && data.lists) || []).map(normalizeList);
      state.mineCodes = new Set(lists.map(function (L) { return L.code; }));
      lists.forEach(function (L) { state.byCode[L.code] = L; });
      state.lists = lists;
      updateMyRidesButton();
      renderFilters();
      render();
      var b = document.getElementById('board');
      if (b) b.scrollIntoView({ behavior: 'smooth' });
    }).catch(function (e) {
      if (e.status === 401) { state.me = null; toast('Please sign in again'); }
      else { toast("Couldn't load your rides"); report(e); }
    });
  }

  // Best-effort: learn which board cards are mine (for the highlight + badge)
  // without changing what's displayed.
  function refreshMineCodes() {
    if (!state.me) { state.mineCodes = new Set(); updateMyRidesButton(); return Promise.resolve(); }
    return apiGet('/board/mine').then(function (data) {
      var lists = ((data && data.lists) || []).map(normalizeList);
      state.mineCodes = new Set(lists.map(function (L) { return L.code; }));
      lists.forEach(function (L) { state.byCode[L.code] = L; });
      updateMyRidesButton();
      if (!state.filter.mine) render();
    }).catch(function () { /* signed-out or transient — ignore */ });
  }

  /* ---------------- ride detail page ---------------- */
  var detailInner = document.getElementById('detail-inner');

  function personEl(m, i) {
    return '<div class="d-person">' + avatar(m, i) +
      '<b>' + esc(m.name) + (isYouMember(currentDetail(), m) ? ' (you)' : '') + '</b>' +
      '<small>' + (m.isStarter ? 'started this list' : 'on the list') + '</small></div>';
  }
  function currentDetail() { return state.byCode[state.detailId] || {}; }

  function renderDetail(L) {
    var min = L.minSeats, cap = L.capacity;
    var need = Math.max(0, min - L.committed);
    var conf = L.confirmed || need === 0;
    var slots = conf ? 0 : need;
    var youIn = iAmOn(L);
    var sc = scarcityText(L);
    var s = slotWindow(L.slot);
    var alt = ALT[L.corridorId] || { priv: 0, bus: '' };
    var people = L.members.map(personEl).join('') +
      Array.apply(null, { length: slots }).map(function (_, i) {
        return '<div class="d-person slot" data-detail-join><span class="circ">＋</span><span class="hand">' + (i === 0 && !youIn ? 'you?' : 'a friend?') + '</span></div>';
      }).join('');
    var dots = Array.apply(null, { length: min }).map(function (_, i) { return '<i class="' + (i < Math.min(L.committed, min) ? 'f' : '') + '"></i>'; }).join('');
    var whoRow = L.members.slice(0, 5).map(function (m, i) { return avatar(m, i, 'sm'); }).join('') +
      (conf ? '' : Array.apply(null, { length: need }).map(function () { return '<span class="slotmini">·</span>'; }).join(''));
    var clock = conf ? 'departs ' + esc(L.lockedTime || '—')
      : '<span class="countdown ' + (isUrgent(L.cutoffMs) ? 'urgent' : '') + '" data-cut="' + L.cutoffMs + '">' + cdHtml(L.cutoffMs) + '</span>';
    var timeChips = conf
      ? '<span class="tset locked">Departure locked: <b>' + esc(L.lockedTime || s.opts[1]) + '</b></span>'
      : '<div class="tset"><span class="tlbl">Likely departure — set when the van locks:</span><div class="topts">' +
        s.opts.map(function (t, i) { return '<span class="topt ' + (i === 1 ? 'lead' : '') + '">' + t + '</span>'; }).join('') +
        '</div><span class="tnote">Everyone\'s asked their preferred time when they join; the group\'s most popular wins.</span></div>';
    var shareUrl = SHARE_ORIGIN + '/board/' + L.code;
    var waText = 'shared van ' + L.from + ' → ' + L.to + ', ' + L.whenLabel + ' — ≈' + money(L.cost) + ' each, $0 unless it runs: ' + shareUrl;
    var starterName = L.members[0] ? L.members[0].name : 'Someone';

    detailInner.innerHTML =
      '<div class="d-head"><button class="d-back" id="d-back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg> Back to the board</button></div>' +
      '<div class="d-grid"><div>' +
      '<h1 class="d-title">' + esc(L.from) + ' <span class="arr">→</span> ' + esc(L.to) + '</h1>' +
      '<div class="d-meta">' +
      '<span class="m"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>' + esc(L.whenLabel) + ' · ' + esc(s.label) + '</span>' +
      '<span class="m"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' + clock + '</span>' +
      '<span class="m"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17h2l2-6h10l2 6h2M6 17a2 2 0 1 0 4 0M14 17a2 2 0 1 0 4 0M7 11V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4"/></svg>air-con van · ' + cap + ' seats</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:6px">' +
      '<span class="pill ' + sc.cls + '">' + sc.txt + '</span>' + taBadge('5.0 · 200+ real trips') + '</div>' +
      '<div class="guarantee-banner"><span class="gb-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 6v6c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V6l-8-4z"/><path d="m9 12 2 2 4-4"/></svg></span>' +
      '<div><b>You travel either way.</b> If four names come, you split this van cheap. If not, we move you into a private car or the next shared ride at the split price — <b>you\'re never left without a ride</b>, and never charged for one that doesn\'t happen.</div></div>' +
      '<div class="d-block"><h2>Who\'s in so far <span class="hand">— real travellers, verified</span></h2>' +
      '<div class="d-people">' + people + '</div>' +
      (L.note ? '<div class="d-note"><b>' + esc(starterName) + ' says:</b> "' + esc(L.note) + '"</div>' : '') + '</div>' +
      '<div class="d-block"><h2>When it leaves</h2>' + timeChips + '</div>' +
      '<div class="d-block"><h2>Pickup &amp; drop-off</h2><div class="d-route">' +
      '<div class="rr-stop"><span class="rr-dot a"></span><div><b>Pickup — ' + esc(pointFor(L.from, L.fromId)) + '</b><p>Our set shared-ride pickup for ' + esc(L.from) + '. Staying within ~10 km? We can usually collect from your door — ask when you join.</p></div></div>' +
      '<div class="rr-stop"><span class="rr-dot b"></span><div><b>Drop-off — ' + esc(pointFor(L.to, L.toId)) + '</b><p>Dropped right in ' + esc(L.to) + ', not a bus stand. ' + esc(CORRIDOR_TIME[L.corridorId] || '') + ' with a comfort stop on the way.</p></div></div>' +
      '</div></div>' +
      '<div class="d-block"><h2>How the money works</h2><div class="tl">' +
      '<div class="tl-row"><span class="tl-dot" style="background:var(--teal)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>' +
      '<div><h4>Now — you pay $0</h4><p>Adding your name places a hold on your card via PayHere. <b>Nothing is charged.</b> Scratch off anytime before it closes and the hold disappears.</p></div></div>' +
      '<div class="tl-row"><span class="tl-dot" style="background:var(--saffron)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>' +
      '<div><h4>When the list closes</h4><p>The moment <b>' + min + ' names</b> are up the van locks in and everyone\'s charged their share (≈ <b>' + money(L.cost) + '</b>). <b>If it never fills, you\'re never charged</b> — go private and split it, or take the next shared ride.</p></div></div>' +
      '<div class="tl-row"><span class="tl-dot" style="background:var(--tomato)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17h2l2-6h10l2 6h2M6 17a2 2 0 1 0 4 0M14 17a2 2 0 1 0 4 0M7 11V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4"/></svg></span>' +
      '<div><h4>' + esc(L.whenLabel) + ' — the van rolls</h4><p>Licensed Ceylon Hop driver from ' + esc(pointFor(L.from, L.fromId)) + '. Your driver\'s name and WhatsApp arrive by email the evening before.</p></div></div>' +
      '</div></div>' +
      '<div class="d-block"><h2>Who\'s driving</h2><div class="d-trust">' +
      '<div class="t"><span class="ico" style="background:var(--teal)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 6v6c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V6l-8-4z"/><path d="m9 12 2 2 4-4"/></svg></span><div><b>Ceylon Hop — a real operator</b><span>Licensed drivers, insured AC vans. The same fleet as our private transfers.</span></div></div>' +
      '<div class="t"><span class="ico" style="background:var(--saffron)"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17l-6.2 3.9 1.6-7L2 9.2l7.1-.6L12 2z"/></svg></span><div><b>5.0 on Tripadvisor</b><span>Every review is from a real trip across the island.</span></div></div>' +
      '<div class="t"><span class="ico" style="background:#25D366"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5.1-1.3A10 10 0 1 0 12 2z"/></svg></span><div><b>Humans on WhatsApp</b><span>Question at 6am from a train platform? We answer.</span></div></div>' +
      '<div class="t"><span class="ico" style="background:var(--blue)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span><div><b>Verified travellers only</b><span>Everyone signs in with Google. First name + country is all anyone sees.</span></div></div>' +
      '</div></div>' +
      '<div class="d-block d-faq faq"><h2>Quick answers</h2>' +
      '<details><summary>Can I cancel after adding my name?</summary><p>Yes — scratch off anytime <b>before the deadline</b>, no questions, hold released. After the list fills and everyone\'s charged, normal cancellation terms apply.</p></details>' +
      '<details><summary>Where exactly is the pickup?</summary><p>Our set shared-ride point for this city — <b>' + esc(pointFor(L.from, L.fromId)) + '</b>. If you\'re staying within ~10 km we can usually collect from your door instead; just ask when you join. You\'ll get the exact pickup time the evening before.</p></details>' +
      '<details><summary>Luggage? Surfboards?</summary><p>A backpack + day bag each is always fine. Boards and bikes usually fit — mention it in a note and we\'ll confirm.</p></details>' +
      '</div></div>' +
      // ---- sticky join card ----
      '<aside class="d-join">' +
      (youIn
        ? '<div class="on-hero"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><div><b>You\'re on this list</b><span>' + (conf ? 'The van is locked — see you at pickup.' : 'We\'ll charge ≈' + money(L.cost) + ' only if it fills. $0 held for now.') + '</span></div></div>'
        : '<div class="zero-hero"><b>$0</b><span>to add your name today</span></div><div class="zero-sub">You\'re only charged <b>≈ ' + money(L.cost) + '</b> if the van locks in. Never a cent before.</div>') +
      '<span class="pill ' + sc.cls + '" style="margin:4px 0 2px">' + sc.txt + '</span>' +
      '<div class="who-row">' + whoRow + '<span class="lbl">' + L.committed + ' of ' + min + ' in</span></div>' +
      '<span class="goal-dots" style="margin-bottom:12px;display:inline-flex">' + dots + '<span>' + (conf ? 'locked' : 'locks at ' + min) + '</span></span>' +
      (youIn
        ? '<button class="btn btn-wa btn-block" data-detail-share>Invite someone — fill it faster</button>' +
          (conf ? '' : '<button class="btn btn-scratch btn-block" data-scratch style="margin-top:8px">Scratch my name off</button>')
        : '<button class="btn btn-primary btn-block" data-detail-join>' + (conf ? 'Hop on — seats open' : 'Add my name — free') + '</button>' +
          '<p class="fine">Google sign-in · card held by PayHere, <b>never charged unless it runs</b> · scratch off anytime</p>') +
      (alt.priv ? '<div class="vs-strip"><b>≈' + money(L.cost) + '</b> shared seat · $' + alt.priv + ' private car · ' + esc(alt.bus) + '</div>' : '') +
      '<div class="deadline"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
      (conf ? 'van locked ✓' : '<span class="countdown ' + (isUrgent(L.cutoffMs) ? 'urgent' : '') + '" data-cut="' + L.cutoffMs + '">' + cdHtml(L.cutoffMs) + '</span>') + '</div>' +
      '<div class="d-share"><span class="lbl">Know someone heading that way?</span><div class="row">' +
      '<a class="btn btn-wa btn-sm" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent(waText) + '">WhatsApp</a>' +
      '<button class="btn btn-ghost btn-sm" data-copy="' + esc(shareUrl) + '">Copy link</button>' +
      '</div><p class="share-live">The link unfurls a live card — <b>always shows the current count</b>, even after it locks.</p></div>' +
      '</aside></div>';

    detailInner.querySelector('#d-back').addEventListener('click', closeDetail);
    detailInner.querySelectorAll('[data-detail-join]').forEach(function (el) { el.addEventListener('click', function () { openModal(L.code); }); });
    var sh = detailInner.querySelector('[data-detail-share]');
    if (sh) sh.addEventListener('click', function () { var ds = detailInner.querySelector('.d-share'); if (ds) ds.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    var scr = detailInner.querySelector('[data-scratch]');
    if (scr) scr.addEventListener('click', function () { doScratch(L.code); });
    var cp = detailInner.querySelector('[data-copy]');
    if (cp) cp.addEventListener('click', function () {
      var self = this;
      copy(self.getAttribute('data-copy')).then(function () { self.textContent = 'Copied ✓'; setTimeout(function () { self.textContent = 'Copy link'; }, 1600); });
    });
  }

  function openDetail(code, autoJoin) {
    state.detailId = code;
    var cached = state.byCode[code];
    if (cached) { showDetailShell(cached); }
    apiGet('/board/' + encodeURIComponent(code)).then(function (data) {
      var L = normalizeList(data);
      state.byCode[code] = L;
      if (state.detailId !== code) return;
      showDetailShell(L);
      if (autoJoin) setTimeout(function () { if (state.detailId === code) openModal(code); }, 380);
    }).catch(function (e) {
      if (state.detailId !== code) return;
      if (e.status === 404) { showDetailNotFound(); }
      else if (!cached) {
        detailInner.innerHTML = '<div class="d-head"><button class="d-back" id="d-back2">← Back to the board</button></div>' +
          '<div class="board-empty" style="margin:20px 0"><div class="plus">📡</div><h3>Couldn\'t load this ride.</h3><p>Try again in a moment.</p></div>';
        var b = document.getElementById('d-back2'); if (b) b.addEventListener('click', closeDetail);
        document.body.classList.add('detail-open'); window.scrollTo({ top: 0, behavior: 'instant' });
        report(e);
      }
    });
  }
  function showDetailShell(L) {
    renderDetail(L);
    document.body.classList.add('detail-open');
    if (location.hash !== '#/' + L.code) location.hash = '/' + L.code;
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function showDetailNotFound() {
    detailInner.innerHTML = '<div class="d-head"><button class="d-back" id="d-back2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg> Back to the board</button></div>' +
      '<div class="board-empty" style="margin:24px 0"><div class="plus">🔎</div><h3>This list has closed or moved on.</h3>' +
      '<p>It may have already run, or the link\'s expired. Browse the board for a ride going your way.</p>' +
      '<button class="btn btn-primary" id="nf-browse">Back to the board</button></div>';
    ['d-back2', 'nf-browse'].forEach(function (id) { var el = document.getElementById(id); if (el) el.addEventListener('click', closeDetail); });
    document.body.classList.add('detail-open');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function closeDetail() {
    state.detailId = null;
    document.body.classList.remove('detail-open');
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  /* ---------------- scratch off ---------------- */
  function doScratch(code) {
    var path = '/board/' + encodeURIComponent(code) + '/scratch';
    var tok = state.manageTokens[code];
    if (tok && !state.me) path += '?t=' + encodeURIComponent(tok);
    apiPost(path, null).then(function (data) {
      state.mineCodes.delete(code);
      if (data && data.list) { var L = normalizeList(data.list); state.byCode[code] = L; }
      updateMyRidesButton();
      toast('Name scratched off', 'No hold, no charge. You can hop back on anytime.');
      if (state.detailId === code && state.byCode[code]) renderDetail(state.byCode[code]);
      if (state.filter.mine) showMine(); else loadBoard();
    }).catch(function (e) {
      if (e.status === 401) toast('Please sign in again');
      else toast("Couldn't scratch that off", 'Try again in a moment.');
      report(e);
    });
  }

  /* ---------------- modal ---------------- */
  var overlay = document.getElementById('overlay');
  var current = null;   // normalized list being joined, or null when creating
  var creating = false;
  var stepIdx = 0;

  function panels() {
    var seq = [];
    if (creating) seq.push('mstep-0');
    if (!state.me) seq.push('mstep-1');
    seq.push('mstep-2', 'mstep-3');
    return seq;
  }
  function setStep(i) {
    stepIdx = i;
    var seq = panels();
    ['mstep-0', 'mstep-1', 'mstep-2', 'mstep-3'].forEach(function (id) { document.getElementById(id).hidden = (id !== seq[i]); });
    document.getElementById('steps').innerHTML = seq.map(function (_, k) { return '<span class="step-dot ' + (k <= i ? 'on' : '') + '"></span>'; }).join('');
    if (seq[i] === 'mstep-1') renderAuthStep();
    if (seq[i] === 'mstep-2') fillConfirmStep();
  }
  function populatePref(slot) {
    var opts = slotWindow(slot).opts;
    document.getElementById('pref-opts').innerHTML =
      opts.map(function (t, i) { return '<button class="pref-opt ' + (i === 1 ? 'sel' : '') + '" data-pt="' + t + '">' + t + '</button>'; }).join('') +
      '<button class="pref-opt" data-pt="flex">Flexible</button>';
  }
  document.getElementById('pref-opts').addEventListener('click', function (e) {
    var b = e.target.closest('.pref-opt'); if (!b) return;
    document.getElementById('pref-opts').querySelectorAll('.pref-opt').forEach(function (x) { x.classList.toggle('sel', x === b); });
  });
  function selectedPref() {
    var b = document.querySelector('#pref-opts .pref-opt.sel');
    return b ? b.getAttribute('data-pt') : null;
  }

  /* ----- create-a-list form (uses transfers-data) ----- */
  var T = window.TRANSFERS || { CORRIDORS: [], byId: {}, sharedOption: function () { return null; } };
  var cFrom = document.getElementById('c-from'), cTo = document.getElementById('c-to'),
    cDate = document.getElementById('c-date'), cTime = document.getElementById('c-time'),
    cNote = document.getElementById('c-note'), cEst = document.getElementById('c-est');
  var ALL_STOPS = [];
  (function () {
    var seen = {};
    (T.CORRIDORS || []).forEach(function (c) { (c.stops || []).forEach(function (id) { seen[id] = true; }); });
    ALL_STOPS = Object.keys(seen);
  })();
  function placeName(id) { return (T.byId && T.byId[id] && T.byId[id].name) || PLACE_NAMES[id] || id; }
  cFrom.innerHTML = ALL_STOPS.map(function (id) { return '<option value="' + id + '">' + esc(placeName(id)) + '</option>'; }).join('');

  function pairCorridor(a, b) {
    var so = T.sharedOption ? T.sharedOption(a, b) : null;
    if (so) return { id: so.corridorId, seat: so.seat };
    var c = (T.CORRIDORS || []).find(function (c) { return c.stops.indexOf(a) !== -1 && c.stops.indexOf(b) !== -1; });
    return c ? { id: c.id, seat: c.seat } : null;
  }
  var dupeTimer = null;
  function syncCreate() {
    var from = cFrom.value;
    var seen = {};
    (T.CORRIDORS || []).filter(function (c) { return c.stops.indexOf(from) !== -1; })
      .forEach(function (c) { c.stops.forEach(function (id) { if (id !== from) seen[id] = true; }); });
    var dests = Object.keys(seen);
    var prev = cTo.value;
    cTo.innerHTML = dests.map(function (id) { return '<option value="' + id + '">' + esc(placeName(id)) + '</option>'; }).join('');
    if (dests.indexOf(prev) !== -1) cTo.value = prev;
    var c = pairCorridor(cFrom.value, cTo.value);
    if (c) {
      cEst.innerHTML = '$' + c.seat + ' <small>/ each</small>';
      document.getElementById('m-cost').textContent = '$' + c.seat + '.00';
    }
    if (dupeTimer) clearTimeout(dupeTimer);
    dupeTimer = setTimeout(checkDupe, 350);
  }
  function checkDupe() {
    var nudge = document.getElementById('dupe-nudge');
    var from = placeName(cFrom.value), to = placeName(cTo.value), date = cDate.value;
    if (!from || !to || !date) { nudge.hidden = true; return; }
    apiGet('/board/dupe?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to) + '&date=' + encodeURIComponent(date))
      .then(function (data) {
        var dupe = data && data.list ? normalizeList(data.list) : null;
        if (!dupe) { nudge.hidden = true; return; }
        var need = Math.max(0, dupe.minSeats - dupe.committed);
        var starter = dupe.members[0] ? dupe.members[0].name : 'Someone';
        nudge.hidden = false;
        nudge.innerHTML = '<div class="dupe-in"><div class="dupe-faces">' +
          dupe.members.slice(0, 3).map(function (m, i) { return avatar(m, i, 'xs' + (i ? ' stack' : '')); }).join('') + '</div>' +
          '<div class="dupe-txt"><b>' + esc(starter) + '\'s list already goes ' + esc(dupe.from) + ' → ' + esc(dupe.to) + '</b> — ' + esc(dupe.whenLabel) + ', ' + (need > 0 ? need + ' more to run' : 'ready to run') + '. Join it instead of starting a new one?</div></div>' +
          '<button class="btn btn-primary btn-sm btn-block" id="dupe-join">Join ' + esc(starter) + '\'s list →</button>';
        var dj = document.getElementById('dupe-join');
        if (dj) dj.addEventListener('click', function () { var id = dupe.code; closeModal(); openDetail(id, true); });
      }).catch(function () { nudge.hidden = true; });
  }
  if (cFrom.querySelector('option[value="ella"]')) { cFrom.value = 'ella'; }
  syncCreate();
  if (cTo.querySelector('option[value="mirissa"]')) { cTo.value = 'mirissa'; syncCreate(); }
  cFrom.addEventListener('change', syncCreate);
  cTo.addEventListener('change', syncCreate);
  (function () { var d = new Date(Date.now() + 3 * 864e5); cDate.value = d.toISOString().slice(0, 10); cDate.min = new Date(Date.now() + 864e5).toISOString().slice(0, 10); })();
  cDate.addEventListener('change', function () { if (dupeTimer) clearTimeout(dupeTimer); dupeTimer = setTimeout(checkDupe, 250); });
  cTime.addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    cTime.querySelectorAll('.chip').forEach(function (x) { x.classList.toggle('sel', x === b); });
  });
  document.getElementById('c-continue').addEventListener('click', function () {
    var c = pairCorridor(cFrom.value, cTo.value);
    if (!c) { toast('Pick two stops on one route'); return; }
    var d = new Date(cDate.value + 'T00:00:00');
    var slot = (cTime.querySelector('.sel') || {}).dataset ? cTime.querySelector('.sel').dataset.t : 'morning';
    document.getElementById('m-route').textContent =
      placeName(cFrom.value) + ' → ' + placeName(cTo.value) + ' · ' +
      d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' + slot;
    populatePref(slot);
    setStep(stepIdx + 1);
  });

  /* ----- confirm step ----- */
  function fillConfirmStep() {
    if (state.me) {
      var av = document.getElementById('m-avatar');
      var ini = (state.me.firstName || '?').slice(0, 2).toUpperCase();
      av.innerHTML = '<span class="ini">' + esc(ini) + '</span>' +
        (state.me.photo ? '<img src="' + esc(state.me.photo) + '" alt="" referrerpolicy="no-referrer" onerror="this.remove()">' : '') +
        (state.me.country ? '<span class="flag">' + flagOf(state.me.country) + '</span>' : '');
      document.getElementById('m-signed-name').textContent = 'Signed in as ' + (state.me.firstName || 'you');
      document.getElementById('m-signed-email').textContent = state.me.country ? flagOf(state.me.country) + ' ' + state.me.country : '';
    }
    var cost = current ? current.cost : (pairCorridor(cFrom.value, cTo.value) || { seat: 21 }).seat;
    document.getElementById('m-cost').textContent = money(cost) + (Number.isInteger(Number(cost)) ? '.00' : '');
  }

  function openModal(code) {
    current = code ? (state.byCode[code] || null) : null;
    creating = !current && !code;
    if (code && !current) {
      // detail not cached yet — fetch then open
      apiGet('/board/' + encodeURIComponent(code)).then(function (d) { state.byCode[code] = normalizeList(d); openModal(code); }).catch(function () { toast("Couldn't open that ride"); });
      return;
    }
    document.getElementById('see-list').hidden = true;
    document.getElementById('m-title').textContent = current
      ? (current.confirmed || current.committed >= current.minSeats ? 'Hop on this ride' : 'Add your name')
      : 'Start a list';
    document.getElementById('m-route').textContent = current
      ? current.from + ' → ' + current.to + ' · ' + current.whenLabel + ' · ' + slotWindow(current.slot).label
      : 'any route · any day · you set it';
    populatePref(current ? current.slot : 'morning');
    setStep(0);
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeModal() { overlay.classList.remove('open'); document.body.style.overflow = ''; creating = false; }
  document.getElementById('modal-close').addEventListener('click', closeModal);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });

  /* ----- auth step (real Google Identity Services) ----- */
  function guessCountry() {
    try {
      var loc = (navigator.language || '').split('-')[1];
      if (loc && /^[A-Za-z]{2}$/.test(loc)) return loc.toUpperCase();
    } catch (e) {}
    return '';
  }
  function ensureGis(cb, tries) {
    tries = tries || 0;
    if (!CLIENT_ID) { cb(false); return; }
    if (window.google && google.accounts && google.accounts.id) {
      if (!state.gisReady) {
        try { google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onCredential, auto_select: false }); state.gisReady = true; }
        catch (e) { report(e); cb(false); return; }
      }
      cb(true); return;
    }
    if (tries > 20) { cb(false); return; }
    setTimeout(function () { ensureGis(cb, tries + 1); }, 250);
  }
  function renderAuthStep() {
    var signin = document.getElementById('auth-signin');
    var countryPanel = document.getElementById('auth-country');
    countryPanel.hidden = true; signin.hidden = false;
    var holder = document.getElementById('gis-btn-holder');
    var unavailable = document.getElementById('gis-unavailable');
    holder.innerHTML = '';
    unavailable.hidden = true;
    ensureGis(function (ok) {
      if (!ok) { unavailable.hidden = false; return; }
      try {
        google.accounts.id.renderButton(holder, { theme: 'outline', size: 'large', type: 'standard', text: 'continue_with', shape: 'pill', width: 300 });
      } catch (e) { unavailable.hidden = false; report(e); }
    });
  }
  function onCredential(response) {
    if (!response || !response.credential) return;
    state.pendingCredential = response.credential;
    // move to the country capture sub-panel
    document.getElementById('auth-signin').hidden = true;
    var cp = document.getElementById('auth-country');
    cp.hidden = false;
    var input = document.getElementById('auth-country-in');
    input.value = guessCountry();
    document.getElementById('auth-hello').textContent = 'traveller';
    setTimeout(function () { input.focus(); }, 40);
  }
  document.getElementById('auth-country-go').addEventListener('click', doLogin);
  document.getElementById('auth-country-in').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  function doLogin() {
    var country = (document.getElementById('auth-country-in').value || '').trim().toUpperCase();
    if (!/^[A-Za-z]{2,4}$/.test(country)) { toast('Enter a 2-letter country code', 'e.g. GB, US, LK'); return; }
    if (!state.pendingCredential) { toast('Please sign in again'); setStep(panels().indexOf('mstep-1')); return; }
    var btn = document.getElementById('auth-country-go');
    btn.disabled = true; btn.textContent = 'Signing in…';
    apiPost('/board/login', { credential: state.pendingCredential, country: country }).then(function (data) {
      state.me = (data && data.me) || null;
      state.pendingCredential = null;
      btn.disabled = false; btn.textContent = 'Continue';
      refreshMineCodes();
      // re-plan the step sequence now that we're signed in, and jump to confirm
      var seq = panels();
      setStep(seq.indexOf('mstep-2'));
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = 'Continue';
      if (e.status === 400) toast('Sign-in failed', 'Please try again.');
      else toast("Couldn't sign you in", 'Try again in a moment.');
      report(e);
    });
  }

  /* ----- commit (create or join) ----- */
  document.getElementById('sign-btn').addEventListener('click', doCommit);
  function doCommit() {
    var btn = document.getElementById('sign-btn');
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    var pref = selectedPref();
    var req;
    if (creating) {
      var c = pairCorridor(cFrom.value, cTo.value);
      req = apiPost('/board', {
        from: placeName(cFrom.value), to: placeName(cTo.value),
        corridorId: c ? c.id : undefined,
        date: cDate.value,
        slot: (cTime.querySelector('.sel') || { dataset: { t: 'morning' } }).dataset.t,
        note: (cNote.value || '').trim() || undefined,
        preferredTime: pref || undefined,
        seats: 1
      });
    } else {
      req = apiPost('/board/' + encodeURIComponent(current.code) + '/join', {
        preferredTime: pref || undefined, seats: 1
      });
    }
    req.then(function (data) {
      delete btn.dataset.busy;
      var L = normalizeList(data.list);
      if (data.manageToken) state.manageTokens[L.code] = data.manageToken;
      state.byCode[L.code] = L;
      state.mineCodes.add(L.code);
      current = L;
      updateMyRidesButton();
      // refresh whatever's on screen
      if (state.detailId === L.code) renderDetail(L);
      if (state.filter.mine) showMine(); else loadBoard();
      showSuccess(L);
    }).catch(function (e) {
      delete btn.dataset.busy;
      if (e.status === 401) { toast('Please sign in to continue'); state.me = null; setStep(panels().indexOf('mstep-1')); }
      else if (e.status === 409) { toast(e.body && e.body.error === 'full' ? 'That ride just filled up' : 'That list just closed', 'Refreshing the board.'); closeModal(); loadBoard(); }
      else if (e.status === 400 && e.body && e.body.error === 'date_in_past') { toast('Pick a future date'); setStep(0); }
      else if (e.status === 400 && e.body && e.body.error === 'unknown_corridor') { toast('That route isn\'t served yet'); setStep(0); }
      else { toast("Couldn't add your name", 'Try again in a moment.'); report(e); }
    });
  }

  function showSuccess(L) {
    var need = Math.max(0, L.minSeats - L.committed);
    setStep(panels().length - 1);
    var lineNo = L.members.length || 1;
    document.getElementById('yl-num').textContent = lineNo + '.';
    // your written-in row avatar
    var yr = document.querySelector('#mstep-3 .yourrow .avatar');
    if (yr && state.me) {
      yr.innerHTML = '<span class="ini">' + esc((state.me.firstName || '?').slice(0, 2).toUpperCase()) + '</span>' +
        (state.me.photo ? '<img src="' + esc(state.me.photo) + '" alt="" referrerpolicy="no-referrer" onerror="this.remove()">' : '') +
        (state.me.country ? '<span class="flag">' + flagOf(state.me.country) + '</span>' : '');
    }
    // handwriting animation
    var target = (state.me && state.me.firstName) || 'You';
    var el = document.getElementById('yl-name');
    var k = 0;
    (function write() {
      if (k <= target.length) { el.innerHTML = esc(target.slice(0, k)) + '<span class="caret"></span>'; k++; setTimeout(write, 85); }
      else setTimeout(function () { var c = el.querySelector('.caret'); if (c) c.remove(); }, 900);
    })();
    document.getElementById('done-head').textContent = creating
      ? 'Your list is up on the board.'
      : need === 0 ? 'That was the 4th name — it’s on!' : 'Your name’s on the list.';
    document.getElementById('done-sub').textContent = creating
      ? 'You’re name #1 — ' + need + ' more and the van rolls. Lists fill when their starter shares them.'
      : need === 0
        ? 'Everyone’s charged their share and the van is locked in. See you at the pickup.'
        : need + ' more name' + (need > 1 ? 's' : '') + ' and the van rolls.';
    var sl = document.getElementById('see-list');
    sl.hidden = !creating;
    sl.onclick = function () { var id = L.code; closeModal(); openDetail(id); };
    prepShare(L, need);
  }

  function prepShare(L, need) {
    var url = SHARE_ORIGIN + '/board/' + L.code;
    var s = slotWindow(L.slot).label;
    document.getElementById('sc-route').textContent = L.from + ' → ' + L.to;
    document.getElementById('sc-meta').textContent = L.whenLabel + ' · ' + s + ' · ' + L.committed + ' of ' + L.minSeats + ' in · ≈ ' + money(L.cost) + ' each';
    document.getElementById('sc-faces').innerHTML = L.members.slice(0, 5).map(function (m, i) { return avatar(m, i, 'sm'); }).join('');
    document.getElementById('sc-dots').innerHTML = Array.apply(null, { length: L.minSeats }).map(function (_, i) { return '<i class="' + (i < L.committed ? 'f' : '') + '"></i>'; }).join('');
    document.getElementById('sc-msg').textContent = need > 0
      ? need + ' seat' + (need > 1 ? 's' : '') + ' to lock it in — you pay $0 unless it runs.'
      : 'The van\'s locked in — seats still open.';
    document.getElementById('share-url').value = url;
    var msg = 'hey — I put my name on a shared van list, ' + L.from + ' → ' + L.to + ', ' + L.whenLabel + ' · ' + s + '. ≈' + money(L.cost) + ' each, runs when ' + (need > 0 ? need + ' more sign' : 'you grab a seat') + ', $0 if it doesn\'t happen. add your name: ' + url;
    document.getElementById('wa-share').href = 'https://wa.me/?text=' + encodeURIComponent(msg);
    document.getElementById('fb-share').href = 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(url);
  }
  document.getElementById('copy-btn').addEventListener('click', function () {
    var self = this;
    copy(document.getElementById('share-url').value).then(function () { self.textContent = 'Copied ✓'; setTimeout(function () { self.textContent = 'Copy'; }, 1600); });
  });

  /* ---------------- my-rides nav ---------------- */
  var mrBtn = document.getElementById('my-rides-btn');
  if (mrBtn) mrBtn.addEventListener('click', showMine);

  /* ---------------- misc ---------------- */
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(function () {});
    try { var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); document.body.removeChild(t); } catch (e) {}
    return Promise.resolve();
  }
  function report(e) {
    try { if (window.chTrack) window.chTrack('exception', { description: (e && e.message) || 'board_error' }); } catch (x) {}
    if (e && e.status !== 404 && e.status !== 401) { try { console.error('[ride-board]', e); } catch (x) {} }
  }

  /* deep link: landing on a shared list URL (#/CODE) opens its page directly */
  function openFromHash() {
    var code = location.hash.replace(/^#\//, '');
    if (code && state.detailId !== code) openDetail(code);
    else if (!code && document.body.classList.contains('detail-open')) closeDetail();
  }

  /* live countdown ticker */
  function startTicker() {
    setInterval(function () {
      document.querySelectorAll('.countdown[data-cut]').forEach(function (el) {
        var ms = +el.getAttribute('data-cut');
        var t = el.querySelector('.cd');
        if (t) t.textContent = 'closes in ' + fmtCountdown(remaining(ms));
        el.classList.toggle('urgent', isUrgent(ms));
      });
    }, 1000);
  }

  /* reveals */
  var io = null;
  function observe() {
    if (io) io.disconnect();
    if (!('IntersectionObserver' in window)) { document.querySelectorAll('.reveal:not(.in)').forEach(function (el) { el.classList.add('in'); }); return; }
    io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }); }, { threshold: 0.1 });
    document.querySelectorAll('.reveal:not(.in)').forEach(function (el) { io.observe(el); });
  }

  /* ---------------- boot ---------------- */
  function boot() {
    var ta = document.getElementById('intro-ta');
    if (ta) ta.innerHTML = taBadge('Rated 5.0 by 200+ travellers');
    apiGet('/board/me').then(function (data) { state.me = (data && data.me) || null; }).catch(function () { state.me = null; })
      .then(function () { return loadBoard(); })
      .then(function () { if (state.me) refreshMineCodes(); })
      .then(function () {
        openFromHash();
        window.addEventListener('hashchange', openFromHash);
        startTicker();
      });
  }
  boot();
})();
