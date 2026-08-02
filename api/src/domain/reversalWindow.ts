import { can, type OpsRole } from '../lib/opsAuth';
import type { Booking } from '../db/bookingRepo';

// Owner rule, 2026-08-02: an ops agent may cancel or refund a booking up to 24 hours before the
// trip starts, and must give a reason. Inside that last day the driver is committed and the
// money is real, so only a founder may reverse. A founder is never time-limited.
//
// This RELAXES the founder-only `payments:reverse` rule set earlier the same day: the capability
// stays founder-only (it is read elsewhere, and widening it would grant ops reversal everywhere),
// and the time-bounded grant lives here, at the four reversal routes, where it can be read.

export const REVERSAL_WINDOW_HOURS = 24;

// Bookings frequently arrive INSIDE 24 hours of travel (owner, 2026-08-02). With only the
// trip-proximity rule, ops could never reverse exactly those — the most time-critical intake —
// and every same-day cancellation would escalate. So a booking is also reversible by ops while
// it is still fresh: they may undo work they just took, whatever the travel date, but they may
// not reverse a long-standing booking on the eve of its trip. One constant, deliberately equal
// to the window above so the rule states in one breath: "more than 24h before the trip, or
// within 24h of taking the booking".
export const FRESH_BOOKING_GRACE_HOURS = 24;

// Sri Lanka is a fixed UTC+05:30 with no DST, so a literal offset is exact and keeps this a pure
// string→instant computation. Same approach as domain/rideList.ts cutoffAt().
const SLK_OFFSET = '+05:30';

const instant = (date: string, time?: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const hhmm = time && /^\d{2}:\d{2}$/.test(time) ? time : '00:00';
  const d = new Date(`${date}T${hhmm}:00${SLK_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * When the trip actually begins, or null when nobody has said.
 *
 * A date with no time counts from the START of that day: the cutoff must protect the earliest
 * moment the trip could begin, not the most convenient one.
 * A multi-day trip counts from its EARLIEST date, for the same reason.
 */
export function tripStartAt(booking: Booking): Date | null {
  const input = booking.input as { date?: unknown; time?: unknown; dates?: unknown };
  if (booking.mode === 'trip') {
    const dates = (Array.isArray(input.dates) ? input.dates : []).filter(
      (d): d is string => typeof d === 'string' && d.length > 0,
    );
    if (!dates.length) return null;
    const starts = dates.map((d) => instant(d)).filter((d): d is Date => d !== null);
    if (!starts.length) return null;
    return new Date(Math.min(...starts.map((d) => d.getTime())));
  }
  if (typeof input.date !== 'string' || !input.date) return null;
  return instant(input.date, typeof input.time === 'string' ? input.time : undefined);
}

export type ReversalVerdict =
  | { ok: true }
  | { ok: false; code: 'within_24h_founder_only' | 'trip_start_unknown' | 'reverse_forbidden'; message: string };

/** May this role reverse (cancel / refund) this booking right now? */
export function mayReverse(role: OpsRole, booking: Booking, now: Date = new Date()): ReversalVerdict {
  // Founder: the capability itself, unconditional.
  if (can(role, 'payments:reverse')) return { ok: true };

  // Everyone else needs the time-bounded grant, and only the roles that actually run bookings
  // get it. Finance is deliberately untouched by this rule: it records money, it does not undo it.
  if (!can(role, 'bookings:operate')) {
    return { ok: false, code: 'reverse_forbidden', message: 'Cancelling and refunding is not part of this role.' };
  }

  // Fresh intake: ops may undo what they just took, whatever the travel date. This is what
  // makes same-day bookings workable, and it is why an unknown trip date is not automatically
  // a dead end for a booking taken minutes ago.
  if (withinGrace(booking, now)) return { ok: true };

  const start = tripStartAt(booking);
  // Fail closed. An unknown start cannot be shown to be OUTSIDE the window, and the whole point
  // of the rule is that the last day before a trip is protected.
  if (!start) {
    return {
      ok: false,
      code: 'trip_start_unknown',
      message: 'This booking has no trip date, so the 24-hour rule cannot be checked. A founder can still cancel or refund it.',
    };
  }

  const cutoff = start.getTime() - REVERSAL_WINDOW_HOURS * 3600_000;
  // Strictly before the cutoff: the boundary instant itself belongs to the founder.
  if (now.getTime() < cutoff) return { ok: true };

  return {
    ok: false,
    code: 'within_24h_founder_only',
    message: `The trip starts in under ${REVERSAL_WINDOW_HOURS} hours — only a founder can cancel or refund from here.`,
  };
}

/** Is this booking still fresh enough for whoever took it to undo it? */
function withinGrace(booking: Booking, now: Date): boolean {
  const created = Date.parse(booking.createdAt ?? '');
  if (!Number.isFinite(created)) return false; // unknown age → no grace, same fail-closed stance
  const age = now.getTime() - created;
  // A NEGATIVE age means the row claims to have been created in the future — clock skew or bad
  // data. Without this it would satisfy "< 24 hours old" forever, making the booking permanently
  // reversible by ops. Nonsense data must not be the most permissive case.
  if (age < 0) return false;
  return age < FRESH_BOOKING_GRACE_HOURS * 3600_000;
}
