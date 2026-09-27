import type { AlertAdapter } from '../adapters/alerts';
import type { Booking, BookingRepo } from '../db/bookingRepo';
import type { DepartureRepo } from '../db/departureRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import { IllegalTransitionError } from '../domain/status';
import { routeText, travelWhenText } from './notifications';

// "Same customer, same trip" — one matcher, shared by the watchdog (which stops chasing a stuck
// checkout the customer already paid for on a newer booking, #775) and the settle path (which
// closes that leftover as soon as the other one is paid). Keep them one definition: if the two
// ever disagreed, the watchdog would chase a booking the settle path had decided was a duplicate.

// The person, as the DB keys them: customers.person_key is generated from lower(btrim(email)).
// Every booking inserts its own customers row, so the booking's own email is the join.
export function personKey(b: Booking): string {
  return String(b.input.customer.email ?? '').trim().toLowerCase();
}

const norm = (s: string | undefined | null) => String(s ?? '').trim().toLowerCase();

// Same mode, same travel date, and the same trip: the corridor and departure for a shared seat,
// the endpoints (and pick-up time, when both have one) for a single transfer, every stop for a
// trip. A trip or transfer with no date yet matches nothing — "to confirm" is not a date two
// bookings can share. One time left to confirm still matches: a retry may skip the time.
export function sameTrip(a: Booking, b: Booking): boolean {
  if (a.mode === 'shared' && b.mode === 'shared') {
    return a.input.corridorId === b.input.corridorId && a.input.date === b.input.date && norm(a.input.time) === norm(b.input.time);
  }
  if (a.mode === 'single' && b.mode === 'single') {
    const sameTime = !a.input.time || !b.input.time || norm(a.input.time) === norm(b.input.time);
    return !!a.input.date && a.input.date === b.input.date && norm(a.input.from) === norm(b.input.from) && norm(a.input.to) === norm(b.input.to) && sameTime;
  }
  if (a.mode === 'trip' && b.mode === 'trip') {
    const start = (x: typeof a) => x.input.dates?.find(Boolean);
    return !!start(a) && start(a) === start(b) &&
      a.input.stops.length === b.input.stops.length && a.input.stops.every((s, i) => norm(s) === norm(b.input.stops[i]));
  }
  return false;
}

export const DUPLICATE_CLOSED_BY = 'system:duplicate-close';

// How long a newer unpaid booking must sit untouched (no checkout) before it counts as a leftover.
export const WALKED_AWAY_MS = 30 * 60_000;

export interface DuplicateCloseDeps {
  bookings: Pick<BookingRepo, 'list' | 'setStatus'>;
  departures: Pick<DepartureRepo, 'releaseSeats'>;
  payments: Pick<PaymentRepo, 'findByBookingId'>;
  alerts: AlertAdapter;
}

// Owner-approved 2026-09-25. A customer whose first checkout fails usually just tries again, and
// every retry is a NEW booking. Once one of them is paid, the earlier unpaid ones are leftovers:
// CH-Y5RXW stayed in the ops queue as "Payment not received" after its customer paid on CH-L72HX,
// the watchdog chased her, and the hand-cancel that cleared it emailed her a cancellation for a
// trip she had paid for. So when `paid` settles, close the same person's other draft/pending
// bookings for the same trip — quietly: no customer email, one info alert for ops.
//
// An OLDER one closes at once. A NEWER one closes only once the customer has walked away from it
// (no checkout for WALKED_AWAY_MS): CH-ULS3L was made after CH-Y8LYF, abandoned, and left behind
// when CH-Y8LYF was paid five hours later — but a newer booking the customer is still paying could
// be a real second one (a second car), and cancelling it under an open PayHere page would take
// money for a cancelled booking.
//
// Never touches a booking that has any succeeded payment (whatever its status says). Idempotent:
// a closed booking is no longer draft/pending, and the compare-and-set in setStatus means a
// booking that moved on meanwhile (its own notify landed) is skipped, not cancelled — and its
// seats are only released when this call is the one that cancelled it.
// Returns the bookings it closed. Throws only if the initial lookup does; callers treat the whole
// thing as best-effort.
export async function closeLeftoverDuplicates(paid: Booking, deps: DuplicateCloseDeps, now = new Date()): Promise<Booking[]> {
  const who = personKey(paid);
  if (!who) return [];
  const paidCreatedAt = Date.parse(paid.createdAt);
  const candidates = (await deps.bookings.list({ status: ['draft', 'payment_pending'] })).filter(
    (b) => b.id !== paid.id && personKey(b) === who && sameTrip(b, paid),
  );
  const closed: Booking[] = [];
  for (const b of candidates) {
    try {
      const payments = await deps.payments.findByBookingId(b.id);
      if (payments.some((p) => p.status === 'succeeded')) continue;
      if (Date.parse(b.createdAt) >= paidCreatedAt) {
        const lastUsed = Math.max(Date.parse(b.createdAt), ...payments.map((p) => p.lastAttemptAt?.getTime() ?? 0));
        if (now.getTime() - lastUsed < WALKED_AWAY_MS) continue;
      }
      let cancelled: Booking;
      try {
        cancelled = await deps.bookings.setStatus(b.id, 'cancelled', {
          reason: `duplicate — paid on ${paid.reference}`,
          by: DUPLICATE_CLOSED_BY,
        });
      } catch (err) {
        if (err instanceof IllegalTransitionError) continue; // it moved on; not ours to close
        throw err;
      }
      closed.push(cancelled);
      // Same seat release as the admin cancel path (transitionAndNotify): a draft/pending shared
      // booking holds real seats. Best-effort — the cancel already happened.
      if (cancelled.mode === 'shared') {
        try {
          await deps.departures.releaseSeats({
            corridorId: cancelled.input.corridorId,
            date: cancelled.input.date,
            time: cancelled.input.time,
            seats: cancelled.input.seats,
          });
        } catch (err) {
          console.error(`duplicate close: seat release failed for ${cancelled.reference}:`, err);
        }
      }
    } catch (err) {
      console.error(`duplicate close failed for ${b.reference} (paid on ${paid.reference}):`, err);
    }
  }
  if (closed.length) {
    const refs = closed.map((b) => b.reference).join(', ');
    await deps.alerts.send({
      severity: 'info',
      kind: 'duplicate_closed',
      title: `Closed duplicate ${refs} — customer paid on ${paid.reference}`,
      body: [
        `${paid.input.customer.email} paid for ${routeText(paid)} (travels ${travelWhenText(paid)}) on ${paid.reference}.`,
        `Their other unpaid booking${closed.length > 1 ? 's' : ''} for the same trip ${closed.length > 1 ? 'were' : 'was'} cancelled automatically: ${refs}.`,
        'No email was sent to the customer about this. Nothing to do.',
      ].join('\n'),
      dedupeKey: paid.reference,
    });
  }
  return closed;
}
