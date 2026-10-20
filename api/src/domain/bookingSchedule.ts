import { isoToday, isTooSoonPrivate } from './dateRules';

// What a pickup date/time set AFTER booking must satisfy (spec 2026-10-17 §4) — the same limits
// the booking page applies: 12 h notice (isTooSoonPrivate), at most 12 months out (booking.js
// maxBookDate), all on the Colombo calendar. One list, so the ops sheet can name every refusal.
export const SCHEDULE_PROBLEMS = ['bad_date', 'bad_time', 'past', 'too_soon', 'too_far'] as const;
export type ScheduleProblem = (typeof SCHEDULE_PROBLEMS)[number];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// "2026-02-30" passes the regex but not the calendar: Date rolls it into March.
function isRealDate(v: string): boolean {
  if (!ISO.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// `allowShortNotice`: ops, fixing a pickup on the phone, may set one inside the 12 h window — the
// notice rule protects us from a customer booking what we can't staff, not from our own staff.
export function scheduleProblem(
  date: string,
  time: string | null,
  now: Date = new Date(),
  opts: { allowShortNotice?: boolean } = {},
): ScheduleProblem | null {
  if (!isRealDate(date)) return 'bad_date';
  if (time !== null && !HHMM.test(time)) return 'bad_time';
  const today = isoToday('Asia/Colombo', now);
  if (date < today) return 'past';
  if (!opts.allowShortNotice && isTooSoonPrivate(date, time, now)) return 'too_soon';
  // Same calendar day next year; ISO strings compare correctly as text.
  const lastBookable = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
  if (date > lastBookable) return 'too_far';
  return null;
}
