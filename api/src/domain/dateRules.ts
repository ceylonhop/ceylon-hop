// "No past dates" rule. Trip dates are booked/quoted in Sri Lanka, so "today" is judged in
// Asia/Colombo (the engine otherwise stays timezone-agnostic). Kept as pure string helpers with
// an injectable `today` so route validation is deterministic in tests.

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Today's calendar date as YYYY-MM-DD in the given IANA timezone. */
export function isoToday(tz = 'Asia/Colombo', now: Date = new Date()): string {
  // en-CA renders as YYYY-MM-DD; timeZone shifts the instant to that zone's local day.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
}

/** True only when `value` is a valid ISO calendar date strictly before `today`.
 *  Absent, empty, or non-ISO strings (e.g. 'to confirm', flexible) are NOT past. */
export function isPastIsoDate(value: string | null | undefined, today: string): boolean {
  if (!value || !ISO.test(value)) return false;
  return value < today; // lexicographic compare is correct for zero-padded YYYY-MM-DD
}

/** The first past date in the list, or null if none. */
export function firstPastDate(values: Array<string | null | undefined>, today: string): string | null {
  for (const v of values) {
    if (isPastIsoDate(v, today)) return v as string;
  }
  return null;
}
