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

/** The next ISO date on `weekday` (0=Sun … 6=Sat — the UTC convention domain/dateRules.isoWeekday
 *  uses) at least `minDaysAhead` days out. For tests where the weekday is load-bearing: shared
 *  corridors only run on certain days (Wed & Sat). */
export function nextIsoWeekday(weekday: number, minDaysAhead = 14): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + minDaysAhead);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
