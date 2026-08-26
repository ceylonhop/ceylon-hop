// Booking date rules: "no past dates", and the minimum notice a product needs before departure
// (further down). Trip dates are booked/quoted in Sri Lanka, so "today" is judged in
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

// ── Minimum notice (owner rule, 2026-08-16) ─────────────────────────────────────────────────
// A private transfer needs 12 hours so a vehicle and driver can actually be assigned. A
// chauffeur-guide needs 7 days, because it commits one driver and car for the whole journey —
// a booking three days out cannot be staffed without pulling the driver off another trip.
// Both are measured in Asia/Colombo, like the past-date rule above. Shared seats are
// deliberately NOT covered: they run on scheduled departures with their own service-day and
// seat-hold guards, and a same-week seat is exactly what that product is for.

export const PRIVATE_MIN_LEAD_HOURS = 12;
export const CHAUFFEUR_MIN_LEAD_DAYS = 7;

const HHMM = /^\d{2}:\d{2}$/;
// Sri Lanka is a fixed UTC+05:30 with no DST, so a literal offset is exact — same approach as
// domain/reversalWindow.ts, which turns the same two fields into an instant.
const SLK_OFFSET = '+05:30';

/** An ISO calendar date `days` after `date`. */
export function addIsoDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Is this private pickup inside the 12-hour notice window?
 *
 * With a time, the pickup instant must be at least 12 hours away. Without one — the front-end's
 * flexi-time, where ops confirm the hour later — there is no hour to measure, so the rule falls
 * back to the calendar: the date must be after today in Colombo. Absent, non-ISO, or unparseable
 * values are never "too soon"; a flexible booking is a legitimate shape, not a rejection.
 */
export function isTooSoonPrivate(
  date: string | null | undefined,
  time: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!date || !ISO.test(date)) return false;
  if (time && HHMM.test(time)) {
    const at = new Date(`${date}T${time}:00${SLK_OFFSET}`);
    if (Number.isNaN(at.getTime())) return false;
    return at.getTime() - now.getTime() < PRIVATE_MIN_LEAD_HOURS * 3600_000;
  }
  return date <= isoToday('Asia/Colombo', now);
}

/** The earliest date a chauffeur-guide trip may start. */
export function earliestChauffeurDate(now: Date = new Date()): string {
  return addIsoDays(isoToday('Asia/Colombo', now), CHAUFFEUR_MIN_LEAD_DAYS);
}

/** Does this chauffeur trip start inside the 7-day window? Judged on the EARLIEST leg date —
 *  the car is committed from the first day, wherever that date sits in the list. An undated or
 *  wholly flexible trip is not too soon. */
export function isTooSoonChauffeur(
  dates: Array<string | null | undefined>,
  now: Date = new Date(),
): boolean {
  const dated = dates.filter((d): d is string => !!d && ISO.test(d));
  if (!dated.length) return false;
  const earliest = dated.reduce((a, b) => (b < a ? b : a));
  return earliest < earliestChauffeurDate(now);
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Weekday of an ISO calendar date as 0=Sun … 6=Sat (JS `getDay()` convention), or null when
 *  `value` isn't an ISO date. Computed from the calendar fields in UTC so the weekday never
 *  drifts with the server's timezone. */
export function isoWeekday(value: string | null | undefined): number | null {
  if (!value || !ISO.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Human label for a set of service weekdays, e.g. [3, 6] → "Wed & Sat". */
export function serviceDaysLabel(days: number[]): string {
  const names = [...days].sort((a, b) => a - b).map((d) => WEEKDAY_SHORT[d] ?? '?');
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
}
