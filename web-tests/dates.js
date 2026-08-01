// Test-only date helpers for the web suite — the front-end twin of api/src/testSupport/dates.ts.
//
// Booking and ops both reject past dates (domain/dateRules.ts server-side, legDateFloor and the
// datepicker's min client-side), so a hard-coded calendar date is a time bomb: the suite is green
// until the wall clock passes it, then the SAME commit goes red with no change to the code. The
// api suite was migrated to these helpers; web-tests never was, and its literals were due to start
// failing ~2026-08-08.
//
// Anchor every test date to "now" instead. Keep the ARITHMETIC visible at the call site
// (futureIsoDate(30) / futureIsoDate(40)) so a reader can still see that leg 2 is ten days after
// leg 1 — that ordering is usually what the test is really about.

/** An ISO (YYYY-MM-DD) calendar date `daysAhead` days from today, in UTC. Kept comfortably in the
 *  future so it stays valid regardless of the Asia/Colombo vs UTC day boundary. */
export function futureIsoDate(daysAhead = 30) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

/** The next ISO date on `weekday` (0=Sun … 6=Sat, the UTC convention domain/dateRules.isoWeekday
 *  uses) at least `minDaysAhead` days out. For tests where the weekday is LOAD-BEARING: shared
 *  corridors only run Wed & Sat, so a shared-ride date must land on one of those. */
export function nextIsoWeekday(weekday, minDaysAhead = 14) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + minDaysAhead);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Split an ISO date into the (year, monthIndex, day) triple the page's `window.pickDate` takes.
 *  monthIndex is 0-based, matching the Date constructor. */
export function isoParts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { year: y, monthIndex: m - 1, day: d };
}

/** The way the booking summary renders a date: "18 Aug 2026". Derived from the ISO string so a
 *  display assertion can't drift from the date the test actually picked. */
export function isoToSummary(iso) {
  const { year, monthIndex, day } = isoParts(iso);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day} ${MONTHS[monthIndex]} ${year}`;
}
