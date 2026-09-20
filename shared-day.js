/* shared-day.js — which day does the scheduled shared van run?

   The date maths behind the search card's "No shared ride on Thu 24 Sep — it runs Wed & Sat"
   (docs/superpowers/specs/2026-09-19-shared-ride-by-day-design.md). Pure on purpose: ISO dates
   and weekday numbers in, answers out, and "today" is an ARGUMENT — nothing here reads the
   clock, so it is unit-testable and nothing can rot. Weekdays come off the calendar date itself
   (…T00:00:00Z + getUTCDay), so there is no time zone to get wrong. */
(function () {
  var ISO = /^\d{4}-\d{2}-\d{2}$/;
  function at(iso) { return new Date(iso + 'T00:00:00Z'); }
  function shift(iso, n) { var d = at(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

  // true | false, or null when there is no date to judge (a search with no date yet).
  function runsOn(iso, days) {
    if (!ISO.test(iso || '') || isNaN(at(iso).getTime())) return null;
    return (days || []).indexOf(at(iso).getUTCDay()) !== -1;
  }

  // The nearest running day either side of an off-day. `before` only if it is still ahead of
  // today — a seat on a van that has left (or leaves today) is not an offer.
  function serviceDatesAround(iso, days, todayIso) {
    var out = { before: null, after: null };
    if (runsOn(iso, days) === null || !(days || []).length) return out;
    for (var i = 1; i <= 7 && !out.after; i++) if (runsOn(shift(iso, i), days)) out.after = shift(iso, i);
    for (var j = 1; j <= 7 && !out.before; j++) {
      var d = shift(iso, -j);
      if (runsOn(d, days)) { out.before = (ISO.test(todayIso || '') && d <= todayIso) ? null : d; break; }
    }
    return out;
  }

  window.CHSharedDay = { runsOn: runsOn, serviceDatesAround: serviceDatesAround };
})();
