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
    morning: { label: 'morning', range: 'departs 7–9 am', win: '7–9 am', opts: ['07:00', '08:00', '09:00'] },
    afternoon: { label: 'afternoon', range: 'departs 1–3 pm', win: '1–3 pm', opts: ['13:00', '14:00', '15:00'] }
  };
  // Private-car fare + rough bus time per corridor — for the shared/private/bus price compare.
  var ALT = {
    'airport-cultural': { priv: 62, bus: '6h bus' }, 'hill-line': { priv: 68, bus: '7h bus + train' }, 'ella-east': { priv: 74, bus: '6h bus' },
    'south-coast': { priv: 45, bus: '2.5h bus' }, 'yala-south': { priv: 52, bus: '5h bus' }, 'ella-south': { priv: 78, bus: '7h bus' }
  };
  var CORRIDOR_TIME = {
    'airport-cultural': '~4h door to door', 'hill-line': '~3.5h door to door', 'ella-east': '~3h door to door',
    'south-coast': '~1.5h door to door', 'yala-south': '~2.5h door to door', 'ella-south': '~3.5h door to door'
  };
  var AV = ['#0AB9B6', '#63BFD6', '#F9A429', '#8f7ad6', '#4aa66a', '#d66a9c', '#e0745f'];
  var MIN_DEFAULT = 3;   // seats needed to lock the van (per-list minSeats overrides)
  var CAP_DEFAULT = 6;   // seats in the van (per-list capacity overrides)
  var MAX_SEATS = 3;     // most one traveller may take (mirrors MAX_SEATS_PER_MEMBER on the API)
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
  /* Write a figure by counting from whatever is on screen. CH.motion.tweenNumber declines by
     itself when counting would be wrong (mismatched shapes, no change, reduced motion, hidden
     tab) and backs every count with a timer, so a stalled animation can't leave a stale price. */
  function setNum(el, next) {
    if (!el) return;
    if (window.CH && CH.motion) CH.motion.tweenNumber(el, el.textContent, next);
    else el.textContent = next;
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
    if (conf && left === 0) return { cls: 'pill-teal pill-dot', txt: 'Full 🚐 · van locked in' };
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

  /* ---------------- scheduled-van clash (pure) ---------------- */
  // The board must not start a second van on a route and day the SCHEDULED one already runs —
  // it would only split the same travellers across two half-empty vehicles (spec
  // 2026-09-19-shared-ride-by-day). POST /board enforces it (409 scheduled_day); this is the
  // same rule in the browser, so the start form can say so before sending anyone through
  // sign-in. Whole day, like the API: never just the van's slot. Date-only ISO, so the weekday
  // is the calendar day's — no time zone to get wrong.
  var WEEKDAYS_PLURAL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
  function scheduledClash(fromId, toId, dateIso) {
    var TR = (typeof window !== 'undefined') && window.TRANSFERS;
    if (!fromId || !toId || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso || '') || !TR || !TR.sharedOption) return null;
    var so = TR.sharedOption(fromId, toId);
    var d = new Date(dateIso + 'T00:00:00Z');
    if (!so || isNaN(d.getTime()) || (so.days || []).indexOf(d.getUTCDay()) === -1) return null;
    return { weekday: WEEKDAYS_PLURAL[d.getUTCDay()], time: (so.times || [])[0] || null, seat: so.seat };
  }

  /* ---------------- board rows (pure) ---------------- */
  // A row always shows the 2-hour window, never a pinned clock time: every other row is still
  // gathering on a window, and a column mixing "08:30" with "7–9 am" stops scanning.
  function windowLabel(slot) { return slotWindow(slot).win; }

  // "~4h door to door" → "~4h" — duration is the one fact that sits under a route.
  function durationOf(list) {
    var t = list && CORRIDOR_TIME[list.corridorId];
    return t ? t.replace(/\s*door to door$/, '') : '';
  }

  // "Colombo Airport (CMB)" → city + "(CMB)"; "Sigiriya / Dambulla" → city + "/ Dambulla". The
  // city is what a traveller scans for, so the tag sets it large and the qualifier small.
  function splitPlace(name) {
    var n = String(name == null ? '' : name).trim();
    var m = /^(.*?)\s+(\(.*\)|\/\s*.+)$/.exec(n);
    return m ? { main: m[1], qual: m[2] } : { main: n, qual: '' };
  }

  var SLOT_ORDER = { morning: 0, afternoon: 1 };
  // Day headings in date order; morning before afternoon; a dateless list goes last, not missing.
  function groupByDay(lists) {
    var sorted = (lists || []).map(function (L, i) { return { L: L, i: i }; }).sort(function (a, b) {
      var da = a.L.date || '￿', db = b.L.date || '￿';
      if (da !== db) return da < db ? -1 : 1;
      var sa = SLOT_ORDER[a.L.slot] || 0, sb = SLOT_ORDER[b.L.slot] || 0;
      return sa !== sb ? sa - sb : a.i - b.i;
    });
    var groups = [];
    sorted.forEach(function (x) {
      var last = groups[groups.length - 1];
      var date = x.L.date || null;
      if (!last || last.date !== date) {
        last = { date: date, label: date ? fmtDate(date) : 'Date to be set', lists: [] };
        groups.push(last);
      }
      last.lists.push(x.L);
    });
    return groups;
  }

  // One coloured seat state and one action per row. The action rules are #597/#599's: a
  // confirmed list is past its cutoff and the join route refuses it, so it never says "Hop on";
  // a list that has only reached its minimum is still gathering and still takes joiners.
  function rowState(list, mine) {
    var min = list.minSeats, cap = list.capacity;
    var need = Math.max(0, min - list.committed);
    var left = Math.max(0, cap - list.committed);
    var you = mine ? " · you're on it" : '';
    var cta = mine ? { kind: 'view', text: 'View your ride' }
      : left === 0 ? { kind: 'again', text: 'Start another van' }
      : list.confirmed ? { kind: 'view', text: "See who's going" }
      : { kind: 'view', text: 'Hop on' };
    if (left === 0) return { cls: 'f', label: 'Full', sub: list.committed + ' of ' + cap + you, cta: cta };
    if (list.confirmed || need === 0) {
      return { cls: 'l', label: 'Locked in', sub: left + ' seat' + (left === 1 ? '' : 's') + ' left' + you, cta: cta };
    }
    return { cls: 'g', label: list.committed + ' of ' + min + ' in', sub: 'needs ' + need + ' more' + you, cta: cta };
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
        seats: m.seats != null ? m.seats : 1,
        isStarter: !!m.isStarter,
        isYou: !!m.isYou
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

  /* ---------------- error reporting ----------------
     Handled failures on this page used to stop at console.error, so a broken
     join looked like silence. These two decide what reaches Sentry (via the
     /errors/client beacon) and in what shape. Kept pure and up here — above the
     DOM-app early return — so they are unit-testable without a page.

     Statuses that are NORMAL states rather than faults are deliberately quiet:
       401 — not signed in yet          404 — stale share link
       409 — van full / list closed
     Everything else, including a thrown null, is worth knowing about. */
  var QUIET_STATUSES = [401, 404, 409];
  function shouldReport(e) {
    try { return !(e && QUIET_STATUSES.indexOf(e.status) !== -1); }
    catch (x) { return true; }
  }
  /* Limits mirror the ClientErrorSchema the API enforces (message 500, stack 1500). */
  function errorPayload(ctx, e) {
    var msg = 'board_error', stack = '';
    try { if (e && e.message) msg = String(e.message); } catch (x) {}
    try { if (e && e.stack) stack = String(e.stack); } catch (x) {}
    return {
      message: ('[ride-board] ' + (ctx || 'unknown') + ': ' + msg).slice(0, 500),
      stack: stack.slice(0, 1500)
    };
  }

  /* ---------------- seats ----------------
     One name may cover the people travelling with it, up to MAX_SEATS. The van counts
     seats, not names, so these three decide what a traveller is offered and charged. */

  // Seats you already hold on this list; 0 when you're not on it. The API marks your own
  // member row (isYou), so this needs no name matching.
  function mySeatsOn(L) {
    if (!L || !L.members) return 0;
    var me = L.members.filter(function (m) { return m.isYou; })[0];
    return me ? (me.seats || 1) : 0;
  }

  // The most seats we may offer: what's free on the van plus the ones you already hold
  // (handing yours back is always allowed), capped at MAX_SEATS. Never below 1, so the
  // picker always renders — a genuinely full van is refused by the API, not hidden here.
  function seatsOnOffer(L) {
    if (!L) return MAX_SEATS;
    var room = Math.max(0, (L.capacity || CAP_DEFAULT) - (L.committed || 0)) + mySeatsOn(L);
    return Math.max(1, Math.min(MAX_SEATS, room));
  }

  // What the traveller is agreeing to be charged if the van runs. Rounded to the cent so
  // a fractional seat price can't show a long float in the "you pay" line.
  function seatTotal(eachDollars, seats) {
    var each = Number(eachDollars) || 0;
    var n = Math.max(1, Number(seats) || 1);
    return Math.round(each * n * 100) / 100;
  }

  /* ---------------- repaint decisions ----------------
     /board/mine resolves after /board has already painted, and the only thing it can
     change on a card is the "you're on this" marking (the .mine ring and tag, both from
     mineCodes). Re-rendering regardless rebuilt every node, so the whole board re-ran its
     fade-in a beat after it appeared — it read as the board loading a second time.
     listCodes = what's on screen, mineCodes = rides you're on, markedCodes = what's
     already rendered as yours. */
  function mineMarkChanged(listCodes, mineCodes, markedCodes) {
    var marked = {};
    (markedCodes || []).forEach(function (c) { marked[c] = true; });
    var wanted = (listCodes || []).filter(function (c) { return mineCodes && mineCodes.has(c); });
    if (wanted.length !== (markedCodes || []).length) return true;
    return wanted.some(function (c) { return !marked[c]; });
  }

  /* Both filter selects, derived from the (from,to) pairs the board has actually returned.
     They used to be two independent sets — every origin ever seen in one, every destination in
     the other — with nothing relating them. Ella is an origin on Ella→Mirissa and a destination
     on Kandy→Ella, so it sat in both lists and "Ella to Ella" was selectable: a combination that
     cannot exist, returning an empty board. It was not only the silly case either — with four
     origins and three destinations, twelve combinations were reachable and only four matched a
     real ride.

     Deriving both lists from the pairs narrows each select to what the other one leaves possible,
     and rules out a place as its own destination for free: a list from a place to itself is not
     a thing, so no such pair is ever in the data. This is what the old state.fromOptions comment
     always claimed ("the two selects narrow to one corridor") and never actually did.

     `active` is kept even when it matches nothing: a filter carried in from a route page can
     legitimately match zero rides, and dropping it renders the select BLANK next to a Clear
     button, with no clue why the board is empty. */
  function filterOptions(pairs, filter) {
    var f = (filter && filter.from) || 'all';
    var t = (filter && filter.to) || 'all';
    var from = [], to = [], seenF = {}, seenT = {};
    (pairs || []).forEach(function (p) {
      var a = p[0], b = p[1];
      if (!a || !b) return;
      if ((t === 'all' || b === t) && !seenF[a]) { seenF[a] = true; from.push(a); }
      if ((f === 'all' || a === f) && !seenT[b]) { seenT[b] = true; to.push(b); }
    });
    if (f !== 'all' && !seenF[f]) from.push(f);
    if (t !== 'all' && !seenT[t]) to.push(t);
    var abc = function (x, y) { return x.localeCompare(y); };
    return { from: from.sort(abc), to: to.sort(abc) };
  }

  var RideBoard = {
    shouldReport: shouldReport,
    errorPayload: errorPayload,
    mineMarkChanged: mineMarkChanged,
    mySeatsOn: mySeatsOn,
    seatsOnOffer: seatsOnOffer,
    seatTotal: seatTotal,
    fmtCountdown: fmtCountdown,
    slotWindow: slotWindow,
    scarcityText: scarcityText,
    whenLine: whenLine,
    windowLabel: windowLabel,
    durationOf: durationOf,
    splitPlace: splitPlace,
    scheduledClash: scheduledClash,
    groupByDay: groupByDay,
    rowState: rowState,
    normalizeList: normalizeList,
    centsToDollars: centsToDollars,
    money: money,
    flagOf: flagOf,
    fmtDate: fmtDate,
    resolvePlaceId: resolvePlaceId,
    filterOptions: filterOptions,
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
  // Share links resolve against whatever serves the unfurl page (this ride's own preview
  // tags). It used to be a hardcoded 'https://ceylonhop.com' — the old WordPress apex,
  // which 404s, so every shared link was dead.
  //
  // The ride domain (ride.ceylonhop.com) is a second custom domain on the API service and
  // serves codes at its root, so links are as short as they get. Until it is configured we
  // fall back to the API's own /r/ path, which keeps local dev and staging self-consistent.
  var SHARE_ORIGIN = String(window.CEYLON_HOP_SHARE_ORIGIN || '').replace(/\/$/, '');
  function shareUrlFor(code) {
    return SHARE_ORIGIN ? SHARE_ORIGIN + '/' + code : API_BASE + '/r/' + code;
  }

  var state = {
    me: null,
    lists: [],            // currently displayed normalized lists
    loadFailed: false,    // last /board fetch failed — lists is empty because we couldn't ask,
                          // NOT because there are none (renderFilters must not report "0")
    byCode: {},           // code → normalized list (detail cache)
    mineCodes: new Set(), // lists the signed-in user is on
    manageTokens: {},     // code → manageToken (from create/join)
    pairs: [],            // [from,to] pairs seen (never shrinks); both filter selects derive from these
    /* Pre-filtered by ?from=&to= so a route page can hand a traveller straight to their
       own route. Without this, "See who's going" landed on the unfiltered board and they
       had to find the route again — the page knew what they wanted and threw it away.
       Place NAMES, matching the /board query and what the route page emits. */
    filter: (function () {
      var q = new URLSearchParams(location.search);
      return { from: q.get('from') || 'all', to: q.get('to') || 'all', mine: false };
    })(),
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

  /* ---------------- inline sheet errors ----------------
     The toast sits at z-index 90; the join sheet's overlay is z-index 100 WITH a backdrop
     blur, so any toast fired while the sheet was open showed up blurred behind it. Errors
     that belong to the sheet render inside it instead — the #sheet-err strip is moved next
     to the visible step's primary button, where the eye already is. Board-level notices
     (sheet closed) keep using toast(). */
  function sheetError(title, sub) {
    var el = document.getElementById('sheet-err');
    if (!el) { toast(title, sub); return; }
    var step = document.querySelector('.mstep:not([hidden])');
    if (step) {
      // Last VISIBLE primary button: mstep-1 keeps a hidden sub-panel whose button would
      // swallow the strip. offsetParent is null for anything inside a hidden container.
      var btn = null, cands = step.querySelectorAll('.btn-primary.btn-block');
      for (var i = cands.length - 1; i >= 0; i--) { if (cands[i].offsetParent) { btn = cands[i]; break; } }
      if (btn) step.insertBefore(el, btn); else step.appendChild(el);
    }
    el.innerHTML = '<b>' + esc(title) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '');
    el.hidden = false;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }
  function clearSheetError() {
    var el = document.getElementById('sheet-err');
    if (el) el.hidden = true;
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
  // Quiet urgency gradient: 'soon' (closing within 6h) warms the tone; 'urgent' (final hour,
  // where the clock ticks seconds) adds a gentle live pulse. Not pushy — just a countdown feel.
  function cdClass(cutoffMs) {
    if (!isFinite(cutoffMs)) return '';
    var r = remaining(cutoffMs);
    if (r <= 0) return '';
    if (r < 3600000) return 'urgent';
    if (r < 6 * 3600000) return 'soon';
    return '';
  }
  function cdHtml(cutoffMs) { return '<span class="cd">closes in ' + esc(fmtCountdown(remaining(cutoffMs))) + '</span>'; }

  /* ---------------- identity helpers ---------------- */
  var iAmOn = function (L) { return state.mineCodes.has(L.code); };
  function isYouMember(L, m) {
    // The API marks your own row when you're signed in; the name match is only a fallback
    // for lists cached before that flag existed.
    if (m.isYou) return true;
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

  /* ---------------- board row ---------------- */
  // Up to four faces (flags ride on the avatars) and a "+N" for the rest.
  function faces(L) {
    var ms = L.members;
    var html = ms.slice(0, 4).map(function (m, i) { return avatar(m, i, 'xs' + (i ? ' stack' : '')); }).join('');
    if (ms.length > 4) html += '<span class="avatar xs stack rw-more">+' + (ms.length - 4) + '</span>';
    return html;
  }

  // A soft tag per place: the ride sheet's markers (hollow teal = pickup, tomato = drop-off)
  // on a tint, no border — a bordered pill on this page is a filter chip.
  function placeTag(name, cls) {
    var p = splitPlace(name);
    return '<span class="rw-pl ' + cls + '"><i class="rw-dot"></i>' + esc(p.main) +
      (p.qual ? ' <small class="rw-q">' + esc(p.qual) + '</small>' : '') + '</span>';
  }

  function rowHtml(L) {
    var mine = iAmOn(L);
    var st = rowState(L, mine);
    var dur = durationOf(L);
    var win = windowLabel(L.slot);
    var hook = st.cta.kind === 'again' ? 'data-again' : 'data-view';
    var primary = st.cta.text === 'Hop on';
    return '<article class="rw' + (mine ? ' mine' : '') + '" data-code="' + esc(L.code) + '" tabindex="0"' +
      ' aria-label="' + esc(L.from + ' to ' + L.to + ', ' + L.whenLabel + ', ' + win + ', ' + st.label) + '">' +
      '<div class="rw-when">' + esc(win) + (dur ? '<span class="rw-dur"> · ' + esc(dur) + '</span>' : '') + '</div>' +
      '<div class="rw-route"><span class="rw-places">' + placeTag(L.from, 'a') + '<span class="arr">→</span>' + placeTag(L.to, 'b') + '</span>' +
        (dur ? '<small>' + esc(dur) + '</small>' : '') + '</div>' +
      '<div class="rw-seats"><span class="rw-faces">' + faces(L) + '</span>' +
        '<span class="rw-state ' + st.cls + '"><b>' + esc(st.label) + '</b><small>' + esc(st.sub) + '</small></span></div>' +
      '<div class="rw-price">≈ <b>' + money(L.cost) + '</b> each</div>' +
      '<button class="btn btn-sm ' + (primary ? 'btn-primary' : 'btn-ghost') + ' rw-cta" ' + hook + '="' + esc(L.code) + '">' +
        esc(st.cta.text) + '</button>' +
      '</article>';
  }

  // Only when a route is chosen: the list ends with one way to start a van on it. With no
  // route there is nothing to prefill, and the filter bar's Start button already covers it.
  function routeInvite() {
    var f = state.filter;
    if (f.mine || f.from === 'all' || f.to === 'all') return '';
    return '<div class="rw-invite"><p><b>Not your day?</b> Start a van on ' + esc(f.from) + ' → ' + esc(f.to) +
      ' for your date — $0 to add your name.</p>' +
      '<button class="btn btn-ghost btn-sm" id="rw-start">Start a ride +</button></div>';
  }

  // One source for the review claim: the board previously said "200+ real trips" while the rest
  // of the site said 30 Tripadvisor reviews, ~7x apart, on a page that asks for card details.
  // That single source is now ta-data.js, which every page carrying the figure loads.
  // If it somehow didn't load, drop the count rather than render "5.0 ·  reviews".
  function taCaption(prefix, noun) {
    var n = window.TA && window.TA.reviews;
    return n ? prefix + n + ' ' + noun : '5.0 · loved by travellers';
  }

  function taBadge(caption) {
    return '<a class="ta" href="' + TA_URL + '" target="_blank" rel="noopener" title="Ceylon Hop on Tripadvisor">' +
      '<span class="owl"><i></i><i class="h"></i></span><b>Tripadvisor</b>' +
      '<span class="bubbles"><i></i><i></i><i></i><i></i><i></i></span>' +
      '<span class="t">' + esc(caption || '5.0 · loved by travellers') + '</span></a>';
  }

  var grid = document.getElementById('board-grid');
  var filtersEl = document.getElementById('filters');

  function render() {
    var shown = state.lists;
    grid.removeAttribute('aria-busy');
    if (!shown.length) {
      grid.innerHTML = '<div class="board-empty"><div class="plus">🗺️</div>' +
        '<h3>No lists match yet' + (state.filter.mine ? " — you haven't joined any" : '') + '.</h3>' +
        '<p>' + (state.filter.mine ? 'Add your name to a ride and it shows up here.' : "Be the first to start this one — we'll help gather names, and it's $0 unless it runs.") + '</p>' +
        '<button class="btn btn-primary" id="empty-start">' + (state.filter.mine ? 'Browse the board' : 'Start this list') + '</button></div>';
    } else {
      grid.innerHTML = groupByDay(shown).map(function (g) {
        return '<section class="rw-group"><h3 class="rw-day-h">' + esc(g.label) + '</h3>' + g.lists.map(rowHtml).join('') + '</section>';
      }).join('') + routeInvite();
    }

    var es = document.getElementById('empty-start');
    if (es) es.addEventListener('click', function () {
      if (state.filter.mine) { state.filter.mine = false; loadBoard(); }
      else openModal(null);
    });
    var rs = document.getElementById('rw-start');
    if (rs) rs.addEventListener('click', function () { openModal(null, { from: state.filter.from, to: state.filter.to }); });
    grid.querySelectorAll('[data-view]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); openDetail(el.getAttribute('data-view')); });
    });
    grid.querySelectorAll('[data-again]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); startAnother(el.getAttribute('data-again')); });
    });
    grid.querySelectorAll('.rw').forEach(function (r) {
      var code = r.getAttribute('data-code');
      // the whole row opens the ride — read the code off the row, since a full van has no
      // [data-view] button to read it from
      r.addEventListener('click', function (e) {
        if (e.target.closest('button,a')) return;
        openDetail(code);
      });
      r.addEventListener('keydown', function (e) {
        if (e.target !== r || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        openDetail(code);
      });
    });
    observe();
    playSeatFills();
  }

  /* A seat filling is the whole point of this board. render() rebuilds every row through
     innerHTML, so each element is BRAND NEW with no previous state for a CSS transition to
     start from — a transition cannot fire on an element that did not exist a frame ago.

     So a gain is animated explicitly, and only a real gain: we remember each list's committed
     count from the last paint and pulse that row's seat state when it went up. */
  var _prevCommitted = Object.create(null);
  function playSeatFills() {
    var reduce = window.CH && CH.motion ? CH.motion.reduce() : false;
    document.querySelectorAll('.rw[data-code]').forEach(function (rowEl) {
      var code = rowEl.getAttribute('data-code');
      var L = state.byCode[code];
      if (!L) return;
      var prev = _prevCommitted[code];
      _prevCommitted[code] = L.committed;
      // First sight of this list, or no gain — nothing happened worth pointing at. (A LOSS
      // isn't animated either: someone leaving a ride is not a moment to celebrate.)
      if (reduce || prev == null || L.committed <= prev) return;
      var b = rowEl.querySelector('.rw-state b');
      if (!b || typeof b.animate !== 'function') return;
      b.animate([
        { transform: 'scale(.85)', opacity: .4 },
        { transform: 'scale(1.12)', opacity: 1, offset: .55 },
        { transform: 'scale(1)', opacity: 1 },
      ], { duration: 460, easing: 'cubic-bezier(.22,.75,.3,1)', fill: 'backwards' });
    });
  }

  function updateMyRidesButton() {
    var n = state.mineCodes.size;
    var btn = document.getElementById('my-rides-btn');
    if (!btn) return;
    btn.hidden = n === 0;
    var c = document.getElementById('mr-count');
    if (c) c.textContent = n;
    // site.css hides .nav-cta .btn:not(.nav-burger) below 880px, so the phone route to your
    // rides is the mobile-menu entry — keep it on the same state as the desktop button.
    var mm = document.getElementById('mm-rides');
    if (mm) mm.hidden = n === 0;
    var mc = document.getElementById('mm-rides-count');
    if (mc) mc.textContent = n;
  }

  // Accumulate the (from,to) PAIRS, not two loose sets — filterOptions() derives both selects
  // from them, which is what stops the two filters offering a combination no ride matches.
  // A place name contains spaces, slashes and brackets ("Colombo Airport (CMB)",
  // "Sigiriya / Dambulla"), so the dedupe key joins on \u0000 — a character that cannot occur
  // in one — rather than punctuation that could split a name in half.
  var PAIR_SEP = '\u0000';
  function rememberPlaceOptions(lists) {
    var seen = {};
    state.pairs.forEach(function (p) { seen[p[0] + PAIR_SEP + p[1]] = true; });
    lists.forEach(function (L) { if (L.from && L.to) seen[L.from + PAIR_SEP + L.to] = true; });
    state.pairs = Object.keys(seen).map(function (k) { return k.split(PAIR_SEP); });
  }

  function renderFilters() {
    var open = state.lists.filter(function (L) { return !L.confirmed && L.committed < L.minSeats; }).length;
    var mineN = state.mineCodes.size;
    var f = state.filter;
    /* Zero is a claim; "we couldn't ask" is not the same claim. When the board fetch fails we
       clear state.lists, so this counter used to announce a confident "0 gathering now" directly
       above the card explaining that we never reached the server — and to a traveller "0 rides"
       reads as "this product is dead", not "try again". Say nothing rather than say zero. */
    var countHtml = state.loadFailed
      ? '<span class="count count-unknown">rides unavailable</span>'
      : '<span class="count"><b>' + open + '</b> gathering now</span>';
    /* Each select is narrowed by what the other one leaves possible, so every combination the
       traveller can reach matches a real ride — and a place is never offered as its own
       destination. filterOptions() also keeps an active value that currently matches nothing,
       because dropping it renders the select BLANK next to a Clear button: the traveller
       arriving from a route page would see an empty filter and no rides, with no clue the two
       were related. */
    var opts = filterOptions(state.pairs, f);
    var optionsHtml = function (list) {
      return list.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('');
    };
    filtersEl.innerHTML =
      '<label class="fsel"><span>Leaving from</span>' +
      '<select id="f-from"><option value="all">Anywhere</option>' +
      optionsHtml(opts.from) +
      '</select></label>' +
      '<label class="fsel"><span>Going to</span>' +
      '<select id="f-to"><option value="all">Anywhere</option>' +
      optionsHtml(opts.to) +
      '</select></label>' +
      (mineN ? '<button class="chip ' + (f.mine ? 'active' : '') + '" id="f-mine">My rides · ' + mineN + '</button>' : '') +
      ((f.from !== 'all' || f.to !== 'all' || f.mine) ? '<button class="chip ghost" id="f-clear">Clear</button>' : '') +
      countHtml +
      '<button class="btn btn-primary btn-sm f-start" id="f-start">Start a ride +</button>';
    var ff = document.getElementById('f-from'), ft = document.getElementById('f-to');
    ff.value = f.from; ft.value = f.to;
    ff.addEventListener('change', function () { f.from = ff.value; f.mine = false; loadBoard(); });
    ft.addEventListener('change', function () { f.to = ft.value; f.mine = false; loadBoard(); });
    var fm = document.getElementById('f-mine');
    if (fm) fm.addEventListener('click', function () { if (f.mine) { f.mine = false; loadBoard(); } else showMine(); });
    var fs = document.getElementById('f-start');
    if (fs) fs.addEventListener('click', function () { openModal(null); });
    var fc = document.getElementById('f-clear');
    if (fc) fc.addEventListener('click', function () { f.from = 'all'; f.to = 'all'; f.mine = false; loadBoard(); });
  }

  /* ---------------- board loads ---------------- */
  // Placeholder rows for the gap before /board answers. Worth having even though the
  // warm response is ~450ms: the API sleeps on Render's free tier, and a cold wake is
  // tens of seconds staring at an empty grid with no sign anything is happening.
  // Cleared by the first render() / error state, both of which overwrite grid.innerHTML.
  function showSkeleton(n) {
    if (!grid) return;
    var row =
      '<div class="bskel" aria-hidden="true">' +
        '<div class="bskel-line w40"></div>' +
        '<div class="bskel-line w60"></div>' +
        '<div class="bskel-dots"><i></i><i></i><i></i></div>' +
      '</div>';
    grid.innerHTML = new Array((n || 4) + 1).join(row);
    grid.setAttribute('aria-busy', 'true');
  }

  function loadBoard() {
    state.filter.mine = false;
    var qs = [];
    if (state.filter.from !== 'all') qs.push('from=' + encodeURIComponent(state.filter.from));
    if (state.filter.to !== 'all') qs.push('to=' + encodeURIComponent(state.filter.to));
    var path = '/board' + (qs.length ? '?' + qs.join('&') : '');
    return apiGet(path).then(function (data) {
      var lists = ((data && data.lists) || []).map(normalizeList);
      lists.forEach(function (L) { state.byCode[L.code] = L; });
      rememberPlaceOptions(lists);
      state.lists = lists;
      state.loadFailed = false; // a good response clears a previous failure
      renderFilters();
      render();
      // Top of the funnel: how many vans a traveller was actually offered, and
      // under which filter — an empty board is the single most useful signal here.
      ev('view_item_list', {
        item_list_id: LIST_ID, item_list_name: 'Ride board',
        board_count: lists.length,
        filter_from: state.filter.from, filter_to: state.filter.to
      });
    }).catch(function (e) {
      state.lists = [];
      // state.pairs is deliberately NOT cleared: it accumulates across loads, and wiping it
      // here collapsed the place dropdowns back to "Anywhere" on a failed refresh — so a
      // traveller who had filtered to their town silently lost the option to filter at all.
      state.loadFailed = true;
      renderFilters();
      grid.removeAttribute('aria-busy');
      grid.innerHTML =
        '<div class="board-empty"><div class="plus">📡</div><h3>Couldn\'t reach the board.</h3>' +
        '<p>Check your connection and try again — nothing on your side is lost.</p>' +
        '<button class="btn btn-primary" id="retry-board">Try again</button></div>';
      var r = document.getElementById('retry-board');
      if (r) r.addEventListener('click', loadBoard);
      report(e, 'loadBoard');
    });
  }

  function showMine() {
    if (!state.me) { toast('Sign in to see your rides', 'Join a ride first and it shows up here.'); return; }
    state.filter.mine = true; state.filter.from = 'all'; state.filter.to = 'all';
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
      else { toast("Couldn't load your rides"); report(e, 'myRides'); }
    });
  }

  // Best-effort: learn which board rows are mine (for the highlight + badge)
  // without changing what's displayed.
  function refreshMineCodes() {
    if (!state.me) { state.mineCodes = new Set(); updateMyRidesButton(); return Promise.resolve(); }
    return apiGet('/board/mine').then(function (data) {
      var lists = ((data && data.lists) || []).map(normalizeList);
      state.mineCodes = new Set(lists.map(function (L) { return L.code; }));
      lists.forEach(function (L) { state.byCode[L.code] = L; });
      updateMyRidesButton();
      // Only repaint if that actually marks (or unmarks) a row that's on screen. This
      // used to render() unconditionally, one round trip after the board had painted,
      // which rebuilt every node and re-ran the entrance animation for nothing.
      var marked = [];
      grid.querySelectorAll('.rw.mine').forEach(function (c) {
        var code = c.getAttribute('data-code');
        if (code) marked.push(code);
      });
      var onScreen = state.lists.map(function (L) { return L.code; });
      if (!state.filter.mine && mineMarkChanged(onScreen, state.mineCodes, marked)) render();
    }).catch(function () { /* signed-out or transient — ignore */ });
  }

  /* ---------------- ride detail page ---------------- */
  var detailInner = document.getElementById('detail-inner');

  function personEl(m, i) {
    var extra = (m.seats || 1) - 1; // people travelling on this name besides the traveller
    return '<div class="d-person">' + avatar(m, i) +
      '<b>' + esc(m.name) + (isYouMember(currentDetail(), m) ? ' (you)' : '') + '</b>' +
      '<small>' + (extra > 0 ? '+' + extra + ' with them' : m.isStarter ? 'started this list' : 'on the list') + '</small></div>';
  }
  function currentDetail() { return state.byCode[state.detailId] || {}; }

  function renderDetail(L) {
    var min = L.minSeats, cap = L.capacity;
    var need = Math.max(0, min - L.committed);
    var conf = L.confirmed || need === 0;
    var slots = conf ? 0 : need;
    var youIn = iAmOn(L);
    // Seats you could still add to your own name: what's free on the van, capped at the
    // three one traveller may hold in total.
    var myRoom = Math.min(cap - L.committed, MAX_SEATS - mySeatsOn(L));
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
      : '<span class="countdown ' + cdClass(L.cutoffMs) + '" data-cut="' + L.cutoffMs + '">' + cdHtml(L.cutoffMs) + '</span>';
    var timeChips = conf
      ? '<span class="tset locked">Departure locked: <b>' + esc(L.lockedTime || s.opts[1]) + '</b></span>'
      : '<div class="tset"><span class="tlbl">Likely departure — set when the van locks:</span><div class="topts">' +
        s.opts.map(function (t, i) { return '<span class="topt ' + (i === 1 ? 'lead' : '') + '">' + t + '</span>'; }).join('') +
        '</div><span class="tnote">Everyone\'s asked their preferred time when they join; the group\'s most popular wins.</span></div>';
    var shareUrl = shareUrlFor(L.code);
    var waText = 'shared van ' + L.from + ' → ' + L.to + ', ' + L.whenLabel + ' — ≈' + money(L.cost) + ' each, $0 unless it runs: ' + shareUrl;
    var starterName = L.members[0] ? L.members[0].name : 'Someone';

    detailInner.innerHTML =
      '<div class="d-head"><button class="d-back" id="d-back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg> Back to the board</button></div>' +
      '<div class="d-grid"><div>' +
      '<h1 class="d-title">' + esc(L.from) + ' <span class="arr">→</span> ' + esc(L.to) + '</h1>' +
      '<div class="d-meta">' +
      '<span class="m"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>' + esc(L.whenLabel) + ' · ' + esc(s.label) + '</span>' +
      '<span class="m"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' + clock + '</span>' +
      '<span class="m"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17h2l2-6h10l2 6h2M6 17a2 2 0 1 0 4 0M14 17a2 2 0 1 0 4 0M7 11V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4"/></svg>air-con van · ' + cap + ' seats</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:6px">' +
      '<span class="pill ' + sc.cls + '">' + sc.txt + '</span>' + taBadge(taCaption('5.0 · ', 'reviews')) + '</div>' +
      '<div class="guarantee-banner"><span class="gb-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 6v6c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V6l-8-4z"/><path d="m9 12 2 2 4-4"/></svg></span>' +
      '<div><b>No ride fare unless it runs.</b> Approve your card with PayHere now. At the cutoff, we charge the ride fare only if enough seats are pledged; otherwise the ride is called off.</div></div>' +
      '<div class="d-block"><h2>Who\'s in so far <span class="hand">— real travellers, verified</span></h2>' +
      '<div class="d-people">' + people + '</div>' +
      (L.note ? '<div class="d-note"><b>' + esc(starterName) + ' says:</b> "' + esc(L.note) + '"</div>' : '') + '</div>' +
      '<div class="d-block"><h2>When it leaves</h2>' + timeChips + '</div>' +
      '<div class="d-block"><h2>Pickup &amp; drop-off</h2><div class="d-route">' +
      '<div class="rr-stop"><span class="rr-dot a"></span><div><b>Pickup — ' + esc(pointFor(L.from, L.fromId)) + '</b><p>Our set shared-ride pickup for ' + esc(L.from) + '. Staying within ~10 km? We can usually collect from your door — ask when you join.</p></div></div>' +
      '<div class="rr-stop"><span class="rr-dot b"></span><div><b>Drop-off — ' + esc(pointFor(L.to, L.toId)) + '</b><p>Dropped right in ' + esc(L.to) + ', not a bus stand. ' + esc(CORRIDOR_TIME[L.corridorId] || '') + ' with a comfort stop on the way.</p></div></div>' +
      '</div></div>' +
      '<div class="d-block"><h2>How the money works</h2><div class="tl">' +
      '<div class="tl-row"><span class="tl-dot" style="background:var(--teal)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>' +
      '<div><h4>Now — approve your card</h4><p>PayHere stores an encrypted card token for this ride; Ceylon Hop never sees your card number. A small verification charge may appear and be reversed. Scratch off before the cutoff and we will not charge the ride fare.</p></div></div>' +
      '<div class="tl-row"><span class="tl-dot" style="background:var(--saffron)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>' +
      '<div><h4>When the list closes</h4><p>At the cutoff, if at least <b>' + min + ' seats</b> are pledged, we charge each approved card its share (≈ <b>' + money(L.cost) + '</b>) and confirm the van. <b>If not enough join, the ride is called off and no ride fare is charged.</b></p></div></div>' +
      '<div class="tl-row"><span class="tl-dot" style="background:var(--tomato)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17h2l2-6h10l2 6h2M6 17a2 2 0 1 0 4 0M14 17a2 2 0 1 0 4 0M7 11V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4"/></svg></span>' +
      '<div><h4>' + esc(L.whenLabel) + ' — the van rolls</h4><p>Licensed Ceylon Hop driver from ' + esc(pointFor(L.from, L.fromId)) + '. Your driver\'s name and WhatsApp arrive by email the evening before.</p></div></div>' +
      '</div></div>' +
      '<div class="d-block"><h2>Who\'s driving</h2><div class="d-trust">' +
      '<div class="t"><span class="ico" style="background:var(--teal)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 6v6c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V6l-8-4z"/><path d="m9 12 2 2 4-4"/></svg></span><div><b>Ceylon Hop — a real operator</b><span>Licensed drivers, insured AC vans. The same fleet as our private transfers.</span></div></div>' +
      '<div class="t"><span class="ico" style="background:var(--saffron)"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17l-6.2 3.9 1.6-7L2 9.2l7.1-.6L12 2z"/></svg></span><div><b>5.0 on Tripadvisor</b><span>Every review is from a real trip across the island.</span></div></div>' +
      '<div class="t"><span class="ico" style="background:#25D366"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5.1-1.3A10 10 0 1 0 12 2z"/></svg></span><div><b>Humans on WhatsApp</b><span>Question at 6am from a train platform? We answer.</span></div></div>' +
      '<div class="t"><span class="ico" style="background:var(--blue)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span><div><b>Verified travellers only</b><span>Everyone signs in with Google. First name + country is all anyone sees.</span></div></div>' +
      '</div></div>' +
      '<div class="d-block d-faq faq"><h2>Quick answers</h2>' +
      '<details><summary>Can I cancel after adding my name?</summary><p>Yes — scratch off anytime <b>before the deadline</b>, no questions, hold released. After the list fills and everyone\'s charged, normal cancellation terms apply.</p></details>' +
      '<details><summary>Where exactly is the pickup?</summary><p>Our set shared-ride point for this city — <b>' + esc(pointFor(L.from, L.fromId)) + '</b>. If you\'re staying within ~10 km we can usually collect from your door instead; just ask when you join. You\'ll get the exact pickup time the evening before.</p></details>' +
      '<details><summary>Luggage? Surfboards?</summary><p>A backpack + day bag each is always fine. Boards and bikes usually fit — mention it in a note and we\'ll confirm.</p></details>' +
      '</div></div>' +
      // ---- sticky join card ----
      '<aside class="d-join">' +
      (youIn
        ? '<div class="on-hero"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><div><b>You\'re on this list' + (mySeatsOn(L) > 1 ? ' — ' + mySeatsOn(L) + ' seats' : '') + '</b><span>' + (conf ? 'The van is locked — see you at pickup.' : 'Your card is approved. We\'ll charge ≈' + money(Math.round(L.cost * Math.max(1, mySeatsOn(L)) * 100) / 100) + ' only if the ride is confirmed at the cutoff.') + '</span></div></div>'
        : '<div class="zero-hero"><b>$0</b><span>to add your name today</span></div><div class="zero-sub">You\'re only charged <b>≈ ' + money(L.cost) + '</b> if the van locks in. Never a cent before.</div>') +
      '<span class="pill ' + sc.cls + '" style="margin:4px 0 2px">' + sc.txt + '</span>' +
      '<div class="who-row">' + whoRow + '<span class="lbl">' + L.committed + ' of ' + min + ' in</span></div>' +
      '<span class="goal-dots" style="margin-bottom:12px;display:inline-flex">' + dots + '<span>' + (conf ? 'locked' : 'locks at ' + min) + '</span></span>' +
      (youIn
        ? (conf || myRoom <= 0 ? '' : '<button class="btn btn-primary btn-block" data-detail-join style="margin-bottom:8px">Add someone with me</button>') +
          (conf ? '' : '<button class="btn btn-scratch btn-block" data-scratch style="margin-top:8px">Scratch my name off</button>')
        : '<button class="btn btn-primary btn-block" data-detail-join>' + (conf ? 'Hop on — seats open' : 'Add my name — free') + '</button>' +
          '<p class="fine">Google sign-in · card approved by PayHere · <b>no ride fare unless it runs</b> · scratch off before the cutoff</p>') +
      // Sharing is what fills a van, so the share block sits right under the actions. It used to
      // sit below the deadline, reached by an "Invite someone" button whose only job was to
      // scroll here — the same action twice, in a louder green than the primary.
      '<div class="d-share"><span class="lbl">Know someone heading that way?</span><div class="row">' +
      '<a class="btn btn-wa btn-sm" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent(waText) + '">WhatsApp</a>' +
      '<button class="btn btn-ghost btn-sm" data-copy="' + esc(shareUrl) + '">Copy link</button>' +
      '</div><p class="share-live">The link unfurls a card with the route, the seat price and <b>how many seats are left</b>.</p></div>' +
      (alt.priv ? '<div class="vs-strip"><b>≈' + money(L.cost) + '</b> shared seat · $' + alt.priv + ' private car · ' + esc(alt.bus) + '</div>' : '') +
      '<div class="deadline"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
      (conf ? 'van locked ✓' : '<span class="countdown ' + cdClass(L.cutoffMs) + '" data-cut="' + L.cutoffMs + '">' + cdHtml(L.cutoffMs) + '</span>') + '</div>' +
      '</aside></div>';

    detailInner.querySelector('#d-back').addEventListener('click', closeDetail);
    detailInner.querySelectorAll('[data-detail-join]').forEach(function (el) { el.addEventListener('click', function () { openModal(L.code); }); });
    // Scratching used to fire on the first click with no warning (owner, 2026-09-18). It now
    // asks inline — nothing is sent until "Yes". Inline rather than window.confirm(): the
    // browser dialog looks foreign to the page and some browsers suppress it.
    var scr = detailInner.querySelector('[data-scratch]');
    if (scr) scr.addEventListener('click', function () {
      if (detailInner.querySelector('.scratch-ask')) return;
      var ask = document.createElement('div');
      ask.className = 'scratch-ask';
      ask.innerHTML = '<p><b>Scratch your name off?</b> Your card hold is released and the seat frees up. ' +
        'You can hop back on any time while the list is still gathering.</p>' +
        '<div class="row"><button class="btn btn-scratch btn-sm" data-scratch-yes>Yes, scratch me off</button>' +
        '<button class="btn btn-primary btn-sm" data-scratch-keep>Keep my seat</button></div>';
      scr.style.display = 'none'; // not `hidden`: .btn's own display rule outranks the [hidden] reset
      scr.insertAdjacentElement('afterend', ask);
      ask.querySelector('[data-scratch-keep]').addEventListener('click', function () { ask.remove(); scr.style.display = ''; });
      ask.querySelector('[data-scratch-yes]').addEventListener('click', function () { ask.remove(); doScratch(L.code); });
    });
    var cp = detailInner.querySelector('[data-copy]');
    if (cp) cp.addEventListener('click', function () {
      var self = this;
      copy(self.getAttribute('data-copy')).then(function () { self.textContent = 'Copied ✓'; setTimeout(function () { self.textContent = 'Copy link'; }, 1600); });
    });
    playRosterArrivals(L);
  }

  /* Somebody joining is the single best thing that happens on this board, and it happened
     silently: renderDetail rebuilds the roster wholesale, so a new traveller simply existed in
     the list where a moment ago they didn't. We remember who was on each list at the last paint
     and animate only the names that are new — so YOUR join is a moment, and so is watching
     someone else's land while you have the ride open. */
  var _prevMembers = Object.create(null);
  function playRosterArrivals(L) {
    if (!L || !L.members) return;
    var key = L.code;
    var names = L.members.map(function (m) { return m.name + '#' + (m.seats || 1); });
    var prev = _prevMembers[key];
    _prevMembers[key] = names;
    var reduce = window.CH && CH.motion ? CH.motion.reduce() : false;
    if (reduce || !prev) return;                    // first sight of this roster — no arrivals to mark
    var people = detailInner.querySelectorAll('.d-person:not(.slot)');
    names.forEach(function (n, i) {
      if (prev.indexOf(n) !== -1) return;           // already there last time
      var el = people[i];
      if (!el || typeof el.animate !== 'function') return;
      el.animate([
        { opacity: 0, transform: 'scale(.82) translateY(6px)' },
        { opacity: 1, transform: 'none' },
      ], { duration: 420, easing: 'cubic-bezier(.22,.75,.3,1)' });
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
      // Someone opened a specific van — the step between browsing and joining.
      ev('select_item', {
        item_list_id: LIST_ID, item_id: L.code,
        item_name: (L.from || '') + ' → ' + (L.to || ''),
        seats_committed: L.committed, seats_needed: L.minSeats
      });
      if (autoJoin) setTimeout(function () { if (state.detailId === code) openModal(code); }, 380);
    }).catch(function (e) {
      if (state.detailId !== code) return;
      if (e.status === 404) { showDetailNotFound(); }
      else if (!cached) {
        detailInner.innerHTML = '<div class="d-head"><button class="d-back" id="d-back2">← Back to the board</button></div>' +
          '<div class="board-empty" style="margin:20px 0"><div class="plus">📡</div><h3>Couldn\'t load this ride.</h3><p>Try again in a moment.</p></div>';
        var b = document.getElementById('d-back2'); if (b) b.addEventListener('click', closeDetail);
        document.body.classList.add('detail-open'); window.scrollTo({ top: 0, behavior: 'instant' });
        report(e, 'openDetail');
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
    detailInner.innerHTML = '<div class="d-head"><button class="d-back" id="d-back2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg> Back to the board</button></div>' +
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
      // Churn out of the funnel. `broke_threshold` flags the expensive case: a
      // scratch that dropped a van back below the count that makes it run.
      ev('scratch_ride', {
        item_list_id: LIST_ID, item_id: code,
        broke_threshold: !!(data && data.list && data.list.committed < data.list.minSeats)
      });
      toast('Name scratched off', 'No hold, no charge. You can hop back on anytime.');
      if (state.detailId === code && state.byCode[code]) renderDetail(state.byCode[code]);
      if (state.filter.mine) showMine(); else loadBoard();
    }).catch(function (e) {
      if (e.status === 401) toast('Please sign in again');
      else toast("Couldn't scratch that off", 'Try again in a moment.');
      report(e, 'scratch');
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
    clearSheetError();
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

  /* ----- seat picker: one name may cover the people travelling with it ----- */
  function selectedSeats() {
    var b = document.querySelector('#seat-opts .seat-opt.sel');
    return b ? Number(b.getAttribute('data-seats')) : 1;
  }
  // Offer only seats the van can actually take: what's free, plus the ones you already
  // hold (giving them back up is always allowed).
  function populateSeats(L) {
    var held = mySeatsOn(L);
    var most = seatsOnOffer(L);
    var want = Math.min(Math.max(held, 1), most);
    document.querySelectorAll('#seat-opts .seat-opt').forEach(function (b) {
      var n = Number(b.getAttribute('data-seats'));
      b.disabled = n > most;
      b.classList.toggle('sel', n === want);
    });
    var note = document.getElementById('seat-note');
    if (held) note.textContent = 'You have ' + held + (held === 1 ? ' seat' : ' seats') + ' on this ride. Change it here — we only ever charge for what you keep.';
    else if (most < MAX_SEATS) note.textContent = 'Only ' + most + (most === 1 ? ' seat' : ' seats') + ' left on this van.';
    else note.textContent = 'Travelling with someone? Take their seat now — you\'re charged together, or not at all.';
  }
  document.getElementById('seat-opts').addEventListener('click', function (e) {
    var b = e.target.closest('.seat-opt'); if (!b || b.disabled) return;
    document.getElementById('seat-opts').querySelectorAll('.seat-opt').forEach(function (x) { x.classList.toggle('sel', x === b); });
    updateCost();
  });
  // The number the traveller is actually agreeing to — seat price times seats.
  function updateCost() {
    var each = current ? current.cost : (pairCorridor(cFrom.value, cTo.value) || { seat: 21 }).seat;
    var n = selectedSeats();
    var total = seatTotal(each, n);
    // The figure the traveller is agreeing to, and it moves every time they touch the seat
    // stepper. Counting it makes 1→2 seats read as the price climbing rather than a different
    // price replacing the old one — the difference between a stepper and a slot machine.
    setNum(document.getElementById('m-cost'), money(total) + (Number.isInteger(Number(total)) ? '.00' : ''));
    setNum(document.getElementById('m-cost-break'), n > 1 ? ' (' + n + ' seats × ' + money(each) + ')' : '');
  }

  /* ----- create-a-list form (uses transfers-data) ----- */
  // corridorFor, NOT sharedOption: the board pools routes we do not schedule, so it must
  // keep matching every corridor pair even after the scheduled catalogue narrowed.
  var T = window.TRANSFERS || { CORRIDORS: [], byId: {}, corridorFor: function () { return null; } };
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
  cFrom.innerHTML = '<option value="">Choose…</option>'
    + ALL_STOPS.map(function (id) { return '<option value="' + id + '">' + esc(placeName(id)) + '</option>'; }).join('');

  function pairCorridor(a, b) {
    var so = T.corridorFor ? T.corridorFor(a, b) : null;
    // Seat price via boardSeatPrice, which mirrors POST /board exactly (catalogue price on a
    // leg we sell, road-distance price otherwise). The corridor's own flat seat is NOT what
    // the server stores, so quoting it here made the form disagree with the created list.
    if (so) {
      var seat = T.boardSeatPrice ? T.boardSeatPrice(a, b) : null;
      return { id: so.corridorId, seat: seat == null ? so.seat : seat };
    }
    var c = (T.CORRIDORS || []).find(function (c) { return c.stops.indexOf(a) !== -1 && c.stops.indexOf(b) !== -1; });
    return c ? { id: c.id, seat: c.seat } : null;
  }
  // "07:30" → "7:30am", the clock style the rest of the site uses.
  function clock12(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''); if (!m) return hhmm || '';
    var h = Number(m[1]);
    return ((h + 11) % 12 + 1) + ':' + m[2] + (h < 12 ? 'am' : 'pm');
  }
  // "We already run this on Saturdays": shown instead of the Continue button when the chosen
  // route and date belong to the scheduled van. style.display, not `hidden` — .btn's own display
  // rule outranks the [hidden] reset.
  function checkSched() {
    var stop = document.getElementById('sched-stop'), go = document.getElementById('c-continue');
    if (!stop || !go) return;
    var clash = scheduledClash(cFrom.value, cTo.value, cDate.value);
    var whisper = go.parentNode.querySelector('.whisper'), est = go.parentNode.querySelector('.est');
    stop.hidden = !clash;
    go.style.display = clash ? 'none' : '';
    if (whisper) whisper.style.display = clash ? 'none' : '';
    // the board's own terms ("once 3 seats are up") would contradict an offer of a guaranteed seat
    if (est) est.style.display = clash ? 'none' : '';
    if (!clash) { stop.innerHTML = ''; return; }
    var d = new Date(cDate.value + 'T00:00:00');
    var when = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    stop.innerHTML = '<b>We already run this on ' + esc(clash.weekday) + '</b>' +
      '<p>A guaranteed seat leaves ' + esc(when) + (clash.time ? ' at ' + esc(clock12(clash.time)) : '') + ' for ' + money(clash.seat) +
      '. Starting a second van would only split the travellers.</p>' +
      '<a class="btn btn-primary btn-block" href="search.html?from=' + encodeURIComponent(cFrom.value) +
      '&to=' + encodeURIComponent(cTo.value) + '&date=' + encodeURIComponent(cDate.value) + '">Book the guaranteed seat →</a>';
  }
  // Route + date into the start form. The dropdowns hold place IDS and the To list is only built
  // once From is chosen, so: resolve names to ids, set From, rebuild To, THEN set To. (The old
  // prefill wrote place NAMES straight into both before the To list existed — "Start another
  // van" opened on two blank "Choose…" dropdowns.)
  function prefillCreate(prefill) {
    var fid = resolvePlaceId(prefill.from) || prefill.from || '';
    var tid = resolvePlaceId(prefill.to) || prefill.to || '';
    cFrom.value = fid; syncCreate();
    cTo.value = tid; syncCreate();
    if (prefill.date && /^\d{4}-\d{2}-\d{2}$/.test(prefill.date) && (!cDate.min || prefill.date >= cDate.min)) cDate.value = prefill.date;
    checkSched();
    if (dupeTimer) clearTimeout(dupeTimer);
    dupeTimer = setTimeout(checkDupe, 250);
  }
  var dupeTimer = null;
  function syncCreate() {
    var from = cFrom.value;
    // Nothing picked yet: offer no destinations and no price rather than the first corridor's,
    // which would be a number for a route the starter has not chosen.
    if (!from) {
      cTo.innerHTML = '<option value="">Choose…</option>';
      cEst.innerHTML = '&mdash;';
      if (dupeTimer) clearTimeout(dupeTimer);
      return;
    }
    var seen = {};
    (T.CORRIDORS || []).filter(function (c) { return c.stops.indexOf(from) !== -1; })
      .forEach(function (c) { c.stops.forEach(function (id) { if (id !== from) seen[id] = true; }); });
    var dests = Object.keys(seen);
    var prev = cTo.value;
    cTo.innerHTML = '<option value="">Choose…</option>'
      + dests.map(function (id) { return '<option value="' + id + '">' + esc(placeName(id)) + '</option>'; }).join('');
    if (dests.indexOf(prev) !== -1) cTo.value = prev;
    var c = pairCorridor(cFrom.value, cTo.value);
    if (c) {
      cEst.innerHTML = '$' + c.seat + ' <small>/ each</small>';
      updateCost();
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
  // Opens unset (owner, 2026-08-18). It used to land on Ella → Mirissa, which reads as a
  // suggestion rather than a default and quietly biases what people put on the board — and a
  // starter who did not notice would post the wrong route. A placeholder makes the choice
  // explicit; syncCreate() leaves the destination list and the price blank until From is picked.
  syncCreate();
  cFrom.addEventListener('change', syncCreate);
  cTo.addEventListener('change', syncCreate);
  (function () { var d = new Date(Date.now() + 3 * 864e5); cDate.value = d.toISOString().slice(0, 10); cDate.min = new Date(Date.now() + 864e5).toISOString().slice(0, 10); })();
  cDate.addEventListener('change', function () { checkSched(); if (dupeTimer) clearTimeout(dupeTimer); dupeTimer = setTimeout(checkDupe, 250); });
  cFrom.addEventListener('change', checkSched);
  cTo.addEventListener('change', checkSched);
  cTime.addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    cTime.querySelectorAll('.chip').forEach(function (x) { x.classList.toggle('sel', x === b); });
  });
  document.getElementById('c-continue').addEventListener('click', function () {
    var c = pairCorridor(cFrom.value, cTo.value);
    if (!c) { sheetError('Pick two stops on one route'); return; }
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
      // Prefill the dial code from their own profile country — never a hardcoded default,
      // and never stomping a pick they already made. By INDEX, not value: dial codes
      // collide (+1 is a dozen countries) and value-set selects the first match.
      var cc = document.getElementById('pay-cc');
      if (cc && !cc.value && state.me.country && window.PHONE_COUNTRIES) {
        for (var ci = 0; ci < window.PHONE_COUNTRIES.length; ci++) {
          if (window.PHONE_COUNTRIES[ci][0] === state.me.country) { cc.selectedIndex = ci + 1; break; } // +1: option 0 is the placeholder
        }
      }
    }
    populateSeats(current);
    updateCost();
    // A traveller already on the list is changing their seats, not adding their name again.
    document.getElementById('sign-btn-label').textContent = mySeatsOn(current)
      ? 'Update my seats' : 'Continue to PayHere';
    // Threshold is per-list (corridors override the default), so never hard-code it here —
    // when creating, the list doesn't exist yet, so fall back to the policy default.
    document.getElementById('m-min').textContent = current ? current.minSeats : MIN_DEFAULT;
  }

  // A full van is not a dead end: it is the strongest signal that this route has demand, so
  // offer to start the next one on the same route and date rather than leaving the traveller stuck.
  function startAnother(code) {
    var L = state.byCode[code];
    openModal(null, L ? { from: L.from, to: L.to, date: L.date, slot: L.slot } : null);
  }

  function openModal(code, prefill) {
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
    populatePref(current ? current.slot : (prefill && prefill.slot) || 'morning');
    if (!current && prefill) {
      prefillCreate(prefill);
      var mr = document.getElementById('m-route');
      if (mr) mr.textContent = prefill.from + ' → ' + prefill.to + (prefill.fromSearch ? ' · your date' : ' · another van, your date');
    }
    setStep(0);
    // Intent to join (or to start a van). GA4's begin_checkout is the closest
    // recommended name — a board seat really is the start of a purchase.
    ev('begin_checkout', {
      item_list_id: LIST_ID,
      flow: creating ? 'create_list' : 'join_list',
      item_id: current ? current.code : null,
      currency: 'USD',
      value: current ? centsToDollars(current.seatPrice) : null
    });
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeModal() { clearSheetError(); overlay.classList.remove('open'); document.body.style.overflow = ''; creating = false; }
  // The phones-only bar at the bottom of the screen (board.html .start-bar). Same target as
  // the tile at the end of the grid — that one is several screen-heights down on a phone.
  var startBar = document.getElementById('start-bar-btn');
  if (startBar) startBar.addEventListener('click', function () { openModal(null); });

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
        catch (e) { report(e, 'googleInit'); cb(false); return; }
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
      } catch (e) { unavailable.hidden = false; report(e, 'googleButton'); }
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
    if (!/^[A-Za-z]{2,4}$/.test(country)) { sheetError('Enter a 2-letter country code', 'e.g. GB, US, LK'); return; }
    if (!state.pendingCredential) { setStep(panels().indexOf('mstep-1')); sheetError('Please sign in again'); return; }
    var btn = document.getElementById('auth-country-go');
    btn.disabled = true; btn.textContent = 'Signing in…';
    apiPost('/board/login', { credential: state.pendingCredential, country: country }).then(function (data) {
      state.me = (data && data.me) || null;
      state.pendingCredential = null;
      btn.disabled = false; btn.textContent = 'Continue';
      // Sign-in is the biggest drop-off risk in this flow — it sits between
      // wanting a seat and having one, so it gets its own funnel step.
      ev('login', { method: 'google', item_list_id: LIST_ID });
      refreshMineCodes();
      // re-plan the step sequence now that we're signed in, and jump to confirm
      var seq = panels();
      setStep(seq.indexOf('mstep-2'));
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = 'Continue';
      if (e.status === 400) sheetError('Sign-in failed', 'Please try again.');
      else sheetError("Couldn't sign you in", 'Try again in a moment.');
      report(e, 'signIn');
    });
  }

  /* ----- commit (create or join) ----- */
  document.getElementById('sign-btn').addEventListener('click', doCommit);
  // Dial code + number, the shape booking.html has used since it shipped — one field asking for
  // "+44 7700 900123" gets a local number typed into it as often as not, and PayHere needs the
  // country. Populated from the SAME window.PHONE_COUNTRIES the booking form reads, so the two
  // pages can never disagree about a country's code.
  (function populateDialCodes() {
    var sel = document.getElementById('pay-cc');
    var list = window.PHONE_COUNTRIES;
    if (!sel || !list) return;
    // No hardcoded default (it used to preselect Sri Lanka, which read as "we guessed
    // for you" — most travellers' cards aren't Lankan). The signed-in traveller's own
    // profile country prefills it in fillConfirmStep; otherwise they pick.
    sel.innerHTML = '<option value="" disabled selected>Country</option>' + list.map(function (c) {
      return '<option value="' + esc(c[2]) + '">' + esc(c[1]) + ' ' + esc(c[2]) + '</option>';
    }).join('');
  })();

  // Joins the two fields into one E.164-ish string for the API. Borrows the two rules booking.js
  // learned the hard way: a number typed WITH its country code must not have it prefixed twice,
  // and a national leading zero is dropped.
  function joinedPhone() {
    var sel = document.getElementById('pay-cc');
    var raw = (document.getElementById('pay-phone').value || '').trim();
    var digits = raw.replace(/[^\d]/g, '');
    if (/^\s*\+/.test(raw)) return digits ? '+' + digits : '';
    var code = ((sel && sel.value) || '').replace(/[^\d]/g, '');
    if (!code) return ''; // no country picked and no + typed: not a dialable number
    var number = digits.replace(/^0+/, '');
    if (code && number.indexOf(code) === 0 && number.length > code.length) number = number.slice(code.length);
    return number ? '+' + code + number : '';
  }

  function paymentDetails() {
    var sel = document.getElementById('pay-cc');
    var rawPhone = (document.getElementById('pay-phone').value || '').trim();
    var needsCode = !/^\+/.test(rawPhone) && !(sel && sel.value);
    var phone = joinedPhone();
    var city = (document.getElementById('pay-city').value || '').trim();
    var address = (document.getElementById('pay-address').value || '').trim();
    if (!phone || !city || !address) {
      sheetError('Add your billing details', 'PayHere needs these to approve your card securely.');
      var missing = needsCode ? 'pay-cc' : !phone ? 'pay-phone' : !city ? 'pay-city' : 'pay-address';
      document.getElementById(missing).focus();
      return null;
    }
    return { phone: phone, city: city, address: address };
  }

  // The hand-off screen (2026-08-18). Shown BEFORE the request goes out, the way pay.html does
  // it: pressing Continue must land on "Taking you to PayHere…" rather than on a button that
  // merely dims. It hides the sheet's steps rather than joining them — see the comment on
  // #pay-handoff in board.html for why it is not a fifth mstep.
  function showHandoff() {
    var el = document.getElementById('pay-handoff');
    if (!el) return;
    document.getElementById('steps').hidden = true;
    ['mstep-0', 'mstep-1', 'mstep-2', 'mstep-3'].forEach(function (id) {
      var m = document.getElementById(id);
      if (m) { m.dataset.phHidden = m.hidden ? '1' : '0'; m.hidden = true; }
    });
    el.hidden = false;
  }
  // Restores exactly what was on screen before, so a failed request drops the payer back where
  // they were instead of stranding them behind a spinner.
  function hideHandoff() {
    var el = document.getElementById('pay-handoff');
    if (!el || el.hidden) return;
    el.hidden = true;
    document.getElementById('steps').hidden = false;
    ['mstep-0', 'mstep-1', 'mstep-2', 'mstep-3'].forEach(function (id) {
      var m = document.getElementById(id);
      if (m && m.dataset.phHidden !== undefined) { m.hidden = m.dataset.phHidden === '1'; delete m.dataset.phHidden; }
    });
  }

  function handoffToPayHere(payment) {
    if (!payment || !payment.checkoutUrl || !payment.fields) throw new Error('invalid_payment_handoff');
    try { sessionStorage.setItem('ch_ride_payment', payment.orderId || ''); } catch (e) {}
    var form = document.createElement('form');
    form.method = 'POST';
    form.action = payment.checkoutUrl;
    form.style.display = 'none';
    Object.keys(payment.fields).forEach(function (name) {
      var input = document.createElement('input');
      input.type = 'hidden'; input.name = name; input.value = payment.fields[name];
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
  }

  function doCommit() {
    var btn = document.getElementById('sign-btn');
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    var pref = selectedPref();
    var seats = selectedSeats();
    var payment = mySeatsOn(current) ? undefined : paymentDetails();
    if (!mySeatsOn(current) && !payment) { delete btn.dataset.busy; return; }
    // Only when a card approval is actually coming: a member already holding seats re-submits
    // without ever touching PayHere, and showing them a gateway hand-off would be a lie.
    if (payment) showHandoff();
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
        seats: seats,
        payment: payment
      });
    } else {
      req = apiPost('/board/' + encodeURIComponent(current.code) + '/join', {
        preferredTime: pref || undefined, seats: seats, payment: payment
      });
    }
    var wasCreating = creating;
    req.then(function (data) {
      delete btn.dataset.busy;
      if (data && data.status === 'payment_required') {
        // Leave the hand-off screen up — we are about to navigate away to PayHere.
        handoffToPayHere(data.payment);
        return;
      }
      hideHandoff();
      var L = normalizeList(data.list);
      if (data.manageToken) state.manageTokens[L.code] = data.manageToken;
      state.byCode[L.code] = L;
      state.mineCodes.add(L.code);
      current = L;
      updateMyRidesButton();
      // The conversion. NOT 'purchase' — no money moves until the van locks at
      // cutoff; this is an approved card against a seat. `van_runs` is the thing the
      // funnel actually turns on: a name that tipped a van over its threshold.
      ev(wasCreating ? 'create_ride_list' : 'join_ride', {
        item_list_id: LIST_ID, item_id: L.code,
        item_name: (L.from || '') + ' → ' + (L.to || ''),
        currency: 'USD', value: Math.round(centsToDollars(L.seatPrice) * seats * 100) / 100,
        quantity: seats,
        seats_committed: L.committed, seats_needed: L.minSeats,
        van_runs: L.committed >= L.minSeats
      });
      // refresh whatever's on screen
      if (state.detailId === L.code) renderDetail(L);
      if (state.filter.mine) showMine(); else loadBoard();
      showSuccess(L);
    }).catch(function (e) {
      delete btn.dataset.busy;
      // Before any per-status handling: those branches call setStep()/toast() and assume the
      // steps are on screen.
      hideHandoff();
      if (e.status === 401) { state.me = null; setStep(panels().indexOf('mstep-1')); sheetError('Please sign in to continue'); }
      else if (e.status === 409) { closeModal(); toast(e.body && e.body.error === 'full' ? 'That ride just filled up' : 'That list just closed', 'Refreshing the board.'); loadBoard(); }
      else if (e.status === 400 && e.body && e.body.error === 'date_in_past') { setStep(0); sheetError('Pick a future date'); }
      else if (e.status === 400 && e.body && e.body.error === 'unknown_corridor') { setStep(0); sheetError('That route isn\'t served yet'); }
      else if (e.status === 409 && e.body && e.body.error === 'scheduled_day') { setStep(0); checkSched(); sheetError('We already run this one', 'Book the guaranteed seat instead.'); }
      else if (e.status === 400 && e.body && e.body.error === 'payment_details_required') { sheetError('Check your billing details', 'Phone, address and city are required by PayHere.'); }
      else { sheetError("Couldn't add your name", 'Try again in a moment.'); report(e, 'join'); }
    });
  }

  function showSuccess(L) {
    var need = Math.max(0, L.minSeats - L.committed);
    setStep(panels().length - 1);
    // Set the header here, not only in openModal(): the PayHere-return path opens the overlay
    // and lands on this step directly, so it kept the markup's defaults — "Add your name" over
    // a placeholder route — on the one screen a returning payer is guaranteed to see.
    document.getElementById('m-title').textContent = 'You’re on the list';
    document.getElementById('m-route').textContent =
      L.from + ' → ' + L.to + ' · ' + L.whenLabel + ' · ' + slotWindow(L.slot).label;
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
    // This step has one job: get the list shared so the van fills. So the headline IS the ask
    // (how many more), one line says why, and the share buttons follow straight away — it used
    // to open with four blocks of copy and the buttons below the fold (owner, 2026-09-18).
    document.getElementById('done-head').textContent = need === 0
      ? 'Enough seats are pledged.'
      : (creating ? 'Your list is live — ' : 'You’re in — ') + need + ' more and the van runs.';
    document.getElementById('done-sub').textContent = need === 0
      ? 'We will confirm the ride and charge the approved cards at the cutoff — not before.'
      : 'Spread the word to fill the van and lock in your ≈ ' + money(L.cost) + ' seat.';
    var sl = document.getElementById('see-list');
    sl.hidden = !creating;
    sl.onclick = function () { var id = L.code; closeModal(); openDetail(id); };
    prepShare(L, need);
  }

  function prepShare(L, need) {
    var url = shareUrlFor(L.code);
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

  /* ---------------- mobile menu ---------------- */
  // Mirrors the shared header's burger (site.js mountHeader) — board.html hand-rolls its nav,
  // so it needs its own toggle. Same pattern as 404/privacy/terms.
  var burger = document.querySelector('[data-burger]');
  var mobile = document.querySelector('[data-mobile]');
  if (burger && mobile) burger.addEventListener('click', function () { mobile.classList.toggle('open'); });
  var mmRides = document.getElementById('mm-rides');
  if (mmRides) mmRides.addEventListener('click', function (e) {
    e.preventDefault();
    if (mobile) mobile.classList.remove('open');
    showMine();
  });

  /* ---------------- misc ---------------- */
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(function () {});
    try { var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); document.body.removeChild(t); } catch (e) {}
    return Promise.resolve();
  }
  /* Handled-failure reporting. The head beacon only catches UNHANDLED errors, so
     everything this page catches and turns into a toast used to vanish. Now it
     also reaches Sentry through the same /errors/client endpoint, capped per page
     the same way (5) so a failing loop can't flood the ingest.

     `ctx` names the call site so Sentry groups by operation, not by message.
     Callers pass it; a bare report(e) still works and reports as 'unknown'. */
  /* ---------------- analytics ----------------
     The board was fully wired to GTM but fired exactly one event ('exception'),
     so its conversion funnel was invisible. `ev` is the same never-throw shape
     the rest of the site uses; GA4 recommended names where one fits, snake_case
     custom names where none does. Consent Mode gates delivery, not this call. */
  var LIST_ID = 'ride_board';
  function ev(name, params) {
    try { if (window.chTrack) window.chTrack(name, params || {}); } catch (x) {}
  }

  var _reported = 0, REPORT_CAP = 5;
  function report(e, ctx) {
    try { if (window.chTrack) window.chTrack('exception', { description: (e && e.message) || 'board_error' }); } catch (x) {}
    if (!RideBoard.shouldReport(e)) return;
    try { console.error('[ride-board]', ctx || '', e); } catch (x) {}
    if (_reported >= REPORT_CAP) return;
    _reported++;
    try {
      var p = RideBoard.errorPayload(ctx, e);
      var body = JSON.stringify({
        message: p.message, stack: p.stack,
        url: location.href.slice(0, 300), ua: navigator.userAgent.slice(0, 300)
      });
      var sent = navigator.sendBeacon &&
        navigator.sendBeacon(API_BASE + '/errors/client', new Blob([body], { type: 'application/json' }));
      if (!sent) {
        fetch(API_BASE + '/errors/client', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: body, keepalive: true
        }).catch(function () {});
      }
    } catch (x) {}
  }

  /* deep link: landing on a shared list URL (#/CODE) opens its page directly */
  function openFromHash() {
    var code = location.hash.replace(/^#\//, '');
    if (code && state.detailId !== code) openDetail(code);
    else if (!code && document.body.classList.contains('detail-open')) closeDetail();
  }

  function clearPaymentQuery() {
    try {
      var url = new URL(location.href);
      url.searchParams.delete('ridePayment');
      url.searchParams.delete('cancelled');
      history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
    } catch (e) {}
  }

  // PayHere's browser return carries no payment result. The signed server callback updates the
  // API, and this page polls that state before showing a success message.
  function resumePaymentFromReturn() {
    var params;
    try { params = new URLSearchParams(location.search); } catch (e) { return Promise.resolve(); }
    var orderId = params.get('ridePayment');
    if (!orderId) {
      try { orderId = sessionStorage.getItem('ch_ride_payment'); } catch (e) {}
    }
    if (!orderId) return Promise.resolve();
    if (params.get('cancelled') === '1') {
      var cancelRequest = apiPost('/board/payments/' + encodeURIComponent(orderId) + '/cancel', null)
        .catch(function (e) { report(e, 'payhereCancel'); });
      clearPaymentQuery();
      try { sessionStorage.removeItem('ch_ride_payment'); } catch (e) {}
      toast('Card approval cancelled', 'Your name was not added. You can try again anytime.');
      return cancelRequest;
    }
    toast('Confirming your card with PayHere…', 'This normally takes a few seconds.');
    function poll(left) {
      return apiGet('/board/payments/' + encodeURIComponent(orderId)).then(function (data) {
        if (data.status === 'pending' && left > 0) {
          return new Promise(function (resolve) { setTimeout(resolve, 1000); }).then(function () { return poll(left - 1); });
        }
        if (data.status !== 'succeeded' || !data.list) {
          if (data.status === 'pending') toast('PayHere is still confirming', 'Refresh this page in a moment — your seat appears only after approval.');
          else toast('Card approval did not complete', 'Your name was not added. Please try again.');
          return;
        }
        var L = normalizeList(data.list);
        state.byCode[L.code] = L;
        state.mineCodes.add(L.code);
        if (data.manageToken) state.manageTokens[L.code] = data.manageToken;
        current = L;
        creating = L.members.some(function (m) { return m.isYou && m.isStarter; });
        overlay.classList.add('open');
        document.body.style.overflow = 'hidden';
        showSuccess(L);
        updateMyRidesButton();
        loadBoard();
        clearPaymentQuery();
        try { sessionStorage.removeItem('ch_ride_payment'); } catch (e) {}
      }).catch(function (e) {
        if (e.status === 401) toast('Sign in again to finish joining your ride');
        else toast("Couldn't confirm PayHere yet", 'Refresh this page in a moment.');
        report(e, 'payhereReturn');
      });
    }
    return poll(12);
  }

  /* live countdown ticker */
  function startTicker() {
    setInterval(function () {
      document.querySelectorAll('.countdown[data-cut]').forEach(function (el) {
        var ms = +el.getAttribute('data-cut');
        var t = el.querySelector('.cd');
        if (t) t.textContent = 'closes in ' + fmtCountdown(remaining(ms));
        var c = cdClass(ms);
        el.classList.toggle('soon', c === 'soon');
        el.classList.toggle('urgent', c === 'urgent');
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
  // board.html?from=&to=&date=&start=1 — search sends a traveller whose date is not a Wed/Sat
  // here to start their own ride. from/to already filter the board; `start` opens the form on
  // top of it, filled in. Consumed once, so a reload lands on the plain filtered board. A ride
  // sheet or a PayHere return takes precedence — the traveller came back for THAT.
  function openFromStartLink() {
    var q;
    try { q = new URLSearchParams(location.search); } catch (e) { return; }
    if (q.get('start') !== '1') return;
    var from = q.get('from'), to = q.get('to'), date = q.get('date');
    q.delete('start');
    var rest = q.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
    if (document.body.classList.contains('detail-open') || overlay.classList.contains('open') || !from || !to) return;
    openModal(null, { from: from, to: to, date: date, fromSearch: true });
  }

  function boot() {
    var ta = document.getElementById('intro-ta');
    if (ta) ta.innerHTML = taBadge(taCaption('Rated 5.0 by ', 'travellers'));

    // The rides are what people came for, so /board must not queue behind anything.
    // These two used to be chained, which meant /board didn't even start until
    // /board/me had come back — two full round trips before the first card, and on a
    // cold Render instance the second one waits out the whole wake-up as well.
    // They are independent: render() reads state.me only to mark "(you)" on a member,
    // and /board/mine re-renders once it lands anyway.
    showSkeleton();
    var me = apiGet('/board/me')
      .then(function (data) { state.me = (data && data.me) || null; })
      .catch(function () { state.me = null; });
    var board = loadBoard();

    // /board/mine needs the identity, and its render() reads state.lists — so it waits
    // for both rather than racing the first paint and flashing the empty state.
    var mine = Promise.all([me, board]).then(function () {
      if (state.me) return refreshMineCodes();
    });

    Promise.all([me, board, mine]).then(function () {
      return resumePaymentFromReturn();
    }).then(function () {
      openFromHash();
      openFromStartLink();
      window.addEventListener('hashchange', openFromHash);
      startTicker();
    });
  }
  boot();
})();
