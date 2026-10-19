
// "We still need your pickup date/time" reminders (spec 2026-10-17 §5, Phase 2). A paid single
// transfer booked with "Decide later" gets at most two, then ops chases on WhatsApp (owner
// 2026-10-18: the booking stays open, no auto refund or cancel). Pure: the scheduler gathers the
// facts, this decides.
export const DETAILS_REMINDER_KINDS = ['details_reminder_1', 'details_reminder_2'] as const;
export type DetailsReminderKind = (typeof DETAILS_REMINDER_KINDS)[number];

// Payments settled before this never get a reminder, so the release does not email the
// backlog that was already sitting in "No date yet". UTC midnight of the release PR's day.
export const DETAILS_REMINDER_EPOCH = new Date('2026-10-18T00:00:00Z');

const DAY_MS = 24 * 3600_000;
const FIRST_AFTER_MS = 2 * DAY_MS;
const SECOND_AFTER_MS = 7 * DAY_MS;
// The second never follows the first closely, even when a tick outage makes both look due.
const MIN_GAP_MS = 3 * DAY_MS;

export interface DetailsReminderFacts {
  missing: boolean; // needsDetails(): no date or no time
  active: boolean; // status paid or confirmed
  datePassed: boolean; // a date is set and is before today in Colombo — nothing left to ask
  paused: boolean; // ops ticked "Customer contacted · pickup confirmed"
  paidAt: Date | null; // earliest succeeded payment's settledAt
  firstSentAt: Date | null;
  secondSentAt: Date | null;
}

export function detailsReminderDue(
  f: DetailsReminderFacts,
  now: Date,
  epoch: Date = DETAILS_REMINDER_EPOCH,
): DetailsReminderKind | null {
  if (!f.missing || !f.active || f.datePassed || f.paused || !f.paidAt) return null;
  if (f.paidAt.getTime() < epoch.getTime()) return null;
  const sincePaid = now.getTime() - f.paidAt.getTime();
  if (!f.firstSentAt) return sincePaid >= FIRST_AFTER_MS ? 'details_reminder_1' : null;
  if (f.secondSentAt || sincePaid < SECOND_AFTER_MS) return null;
  return now.getTime() - f.firstSentAt.getTime() >= MIN_GAP_MS ? 'details_reminder_2' : null;
}
