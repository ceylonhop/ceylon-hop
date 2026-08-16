// Test-only date helpers. Booking routes reject past dates (see domain/dateRules.ts), so tests
// must not hardcode calendar dates: once such a date slips into the past (e.g. after a midnight
// UTC rollover) a green suite flips red on the next run of the same commit. These anchor test
// dates to "now" instead, so the suite is stable over time.

/** An ISO (YYYY-MM-DD) calendar date `daysAhead` days from today, in UTC. Kept comfortably in the
 *  future so it stays valid regardless of the Asia/Colombo vs UTC day boundary used by isoToday. */
export function futureIsoDate(daysAhead = 30): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

/** The Asia/Colombo wall-clock date and time `hoursAhead` from now. For the minimum-notice rule
 *  (domain/dateRules.isTooSoonPrivate), which measures HOURS to the pickup instant and so cannot
 *  be expressed as a calendar date. Sri Lanka is a fixed UTC+05:30 with no DST, so shifting the
 *  instant by the offset and reading its UTC fields gives the Colombo wall clock exactly. */
export function colomboDateTimeIn(hoursAhead: number): { date: string; time: string } {
  const at = new Date(Date.now() + hoursAhead * 3600_000 + 5.5 * 3600_000);
  const iso = at.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** The next ISO date on `weekday` (0=Sun … 6=Sat — the UTC convention domain/dateRules.isoWeekday
 *  uses) at least `minDaysAhead` days out. For tests where the weekday is load-bearing: shared
 *  corridors only run on certain days (Wed & Sat). */
export function nextIsoWeekday(weekday: number, minDaysAhead = 14): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + minDaysAhead);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
