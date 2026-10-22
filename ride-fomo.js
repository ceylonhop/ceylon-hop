/* ride-fomo.js — what makes a traveller ride worth joining NOW: the seats it still needs, when
   names close, what the same trip costs in a private car, and the words a traveller sends a
   friend (plan docs/superpowers/plans/2026-10-19-ride-board-fomo.md).

   Pure on purpose, like shared-day.js: "now" is an ARGUMENT and nothing here reads the clock or
   the DOM, so the board rows, the ride page and the home strip all say the same thing and all
   of it is unit-testable. Every figure comes from the ride itself (GET /board) or the generated
   price catalogue (transfers-data.js) — nothing here invents urgency. */
(function () {
  var HOUR = 3600000, DAY = 24 * HOUR;
  var LIVE_MS = 3 * DAY;              // under this, a running clock instead of a date
  var URGENT_MS = DAY;                // under this, the clock turns red
  var COLOMBO_OFFSET_MS = 5.5 * HOUR; // UTC+05:30, no daylight saving

  function pad(n) { return String(n).padStart(2, '0'); }

  // Remaining milliseconds → "2d 3h" / "9h 12m" / "12m 05s". Clamps at zero.
  function countdown(ms) {
    var s = Math.max(0, Math.floor(Number(ms) || 0));
    var h = Math.floor(s / HOUR), m = Math.floor((s % HOUR) / 60000), sec = Math.floor((s % 60000) / 1000);
    if (h >= 24) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
    if (h >= 1) return h + 'h ' + pad(m) + 'm';
    return m + 'm ' + pad(sec) + 's';
  }

  // An instant → its Sri Lanka calendar date, "Fri 6 Nov".
  function colomboDay(ms) {
    return new Date(ms + COLOMBO_OFFSET_MS).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  // How many more seats this ride needs before it runs; null once it has its minimum or is
  // confirmed — a ride with nothing left to fill has no "seats to go".
  function seatsToGo(list) {
    if (!list || list.confirmed) return null;
    var need = Math.max(0, (list.minSeats || 0) - (list.committed || 0));
    if (need === 0) return null;
    return { need: need, text: need === 1 ? '1 seat to go' : need + ' seats to go', hot: need === 1 };
  }

  // When names close: a running clock inside three days (red inside one), a Sri Lanka date
  // further out. null with no cutoff to go on.
  function closesText(cutoffMs, nowMs) {
    if (!isFinite(cutoffMs)) return null;
    var left = cutoffMs - nowMs;
    if (left <= 0) return { text: 'Names closed', live: false, urgent: false };
    if (left < LIVE_MS) return { text: 'Names close in ' + countdown(left), live: true, urgent: left < URGENT_MS };
    return { text: 'Names close ' + colomboDay(cutoffMs), live: false, urgent: false };
  }

  // The same trip in a private car, from the generated catalogue — the figure the search and
  // trip pages quote. null when the pair can't be priced, or when the car would not cost more
  // than one seat (then the comparison says nothing worth saying).
  function privateCarFare(fromId, toId, seat) {
    var T = typeof window !== 'undefined' && window.TRANSFERS;
    // Both ends must be catalogue places: privateQuote never throws for an unknown id — it
    // prices 0 km at the $29 floor, which would "beat" every seat on the board.
    if (!T || !T.privateQuote || !T.place || !fromId || !toId || !T.place(fromId) || !T.place(toId)) return null;
    var q;
    try { q = T.privateQuote(fromId, toId); } catch (e) { return null; }
    var car = q && Number(q.car);
    if (!isFinite(car) || car <= 0 || !(car > (Number(seat) || 0))) return null;
    return car;
  }

  // The words a traveller sends: the seats still needed, the fare and the private car it beats,
  // and when names close. Strings in, string out — the caller formats money and dates, so this
  // never disagrees with the row the traveller just read. Only someone ON the ride says "I'm
  // taking"; anyone else shares it plainly. The link travels separately (navigator.share's url).
  function shareMessage(r) {
    var parts = [(r.mine ? "I'm taking a shared taxi " : 'Shared taxi ') + r.route + ' on ' + r.when + '.'];
    var fare = r.fare + ' each' + (r.priv ? ' instead of ' + r.priv + ' for a private car' : '');
    parts.push(r.need > 0
      ? (r.need === 1 ? '1 seat left' : r.need + ' seats left') + ' to make it run — ' + fare + ', nothing to pay unless it runs.'
      : "It's running and there are seats left — " + fare + '.');
    if (r.closes) parts.push(r.closes + '.');
    parts.push(r.mine ? 'Join me:' : 'Add your name:');
    return parts.join(' ');
  }

  // The line at the top of the board: real counts off the open rides, never padded.
  function momentum(lists, nowMs) {
    var out = { travellers: 0, closingThisWeek: 0, oneToGo: 0 };
    (lists || []).forEach(function (L) {
      if (!L || L.sched || L.confirmed || L.cancelled) return;
      if (isFinite(L.cutoffMs) && L.cutoffMs <= nowMs) return;
      out.travellers += L.committed || 0;
      if (isFinite(L.cutoffMs) && L.cutoffMs - nowMs < 7 * DAY) out.closingThisWeek++;
      var g = seatsToGo(L);
      if (g && g.hot) out.oneToGo++;
    });
    return out;
  }

  function momentumText(m) {
    if (!m || m.travellers < 1) return null;
    var sub = [];
    if (m.closingThisWeek) sub.push(m.closingThisWeek + (m.closingThisWeek === 1 ? ' ride closes' : ' rides close') + ' this week');
    if (m.oneToGo) sub.push(m.oneToGo + (m.oneToGo === 1 ? ' needs' : ' need') + ' just one more');
    return { head: m.travellers + (m.travellers === 1 ? ' traveller' : ' travellers') + ' on the board right now', sub: sub.join(' · ') };
  }

  window.CHRideFomo = {
    seatsToGo: seatsToGo,
    closesText: closesText,
    privateCarFare: privateCarFare,
    shareMessage: shareMessage,
    momentum: momentum,
    momentumText: momentumText
  };
})();
