import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Booking STATUS describes the trip; MONEY facts come from the payments ledger. Since pay on the
// day (0077) a booking can be confirmed, in progress or completed with no payment at all, so
// "status is paid / paid-or-later" no longer means "we took money". This guard fails CI when new
// production code compares a status to 'paid', or builds a status list that mixes 'paid' with
// other booking statuses, unless the hit is allowlisted below with a reason.

const SRC = join(process.cwd(), 'src');

function productionTypescript(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return productionTypescript(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

// Booking statuses that, listed beside 'paid', mark a list as a booking-status set. Payment-row
// ('succeeded', 'failed'), ride-board and quote statuses are deliberately absent.
const OTHER_BOOKING_STATUSES = ['confirmed', 'in_progress', 'completed', 'payment_pending', 'no_show', 'refunded'];

// (a) a status compared with 'paid', either side: `status === 'paid'`, `b.toStatus !== 'paid'`,
//     `(x.status ?? y.status) === 'paid'`, `'paid' === booking.status`.
const STATUS_EQ_PAID = /[sS]tatus\b\)?\s*[!=]==?\s*'paid'/;
const PAID_EQ_STATUS = /'paid'\s*[!=]==?\s*[\w.?]*[sS]tatus\b/;
// (b) an array literal (incl. `new Set([...])`, `z.enum([...])`) or a parenthesised SQL `in (...)`
//     list of quoted words, possibly spanning lines. Array bodies exclude parentheses so a schema
//     callback `(t) => [ check(sql`... in (...)`) ]` yields its SQL lists, not one giant array.
const LIST_LITERAL = /\[([^[\]()]*)\]|\(\s*('[a-z_]+'(?:\s*,\s*'[a-z_]+')+)\s*,?\s*\)/g;

type Hit = { file: string; line: number; text: string };

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function scan(): Hit[] {
  return productionTypescript(SRC).flatMap((path) => {
    const file = relative(SRC, path);
    const source = readFileSync(path, 'utf8');
    const lines = source.split('\n');
    const hitLines = new Set<number>();
    lines.forEach((text, i) => {
      if (STATUS_EQ_PAID.test(text) || PAID_EQ_STATUS.test(text)) hitLines.add(i + 1);
    });
    for (const m of source.matchAll(LIST_LITERAL)) {
      const body = m[1] ?? m[2] ?? '';
      if (!/'paid'/.test(body)) continue;
      if (!OTHER_BOOKING_STATUSES.some((s) => body.includes(`'${s}'`))) continue;
      // Report the line that opens the list: it carries the constant's name.
      hitLines.add(lineAt(source, m.index ?? 0));
    }
    return [...hitLines].sort((a, b) => a - b).map((line) => ({ file, line, text: lines[line - 1]!.trim() }));
  });
}

type Allowed = { file: string; match: string; why: string };

const ALLOWLIST: Allowed[] = [
  // The state machine and the status CHECK lists: they enumerate statuses, they answer nothing.
  { file: 'domain/status.ts', match: 'export const BOOKING_STATUSES = [', why: 'The state machine itself: every booking status.' },
  { file: 'domain/status.ts', match: "awaiting_details: ['payment_pending', 'paid', 'cancelled']", why: 'The state machine itself: legal transitions out of awaiting_details.' },
  { file: 'db/schema.ts', match: "${t.status} in ('draft'", why: 'bookings.status CHECK constraint: the full status list, not a money question.' },
  { file: 'db/schema.ts', match: "${t.fromStatus} in ('draft'", why: 'booking_status_events.from_status CHECK constraint: the full status list.' },
  { file: 'db/schema.ts', match: "${t.toStatus} in ('draft'", why: 'booking_status_events.to_status CHECK constraint: the full status list.' },

  // Trip / lifecycle decisions: whether the trip is going ahead, not whether money was taken.
  { file: 'db/bookingRepo.ts', match: 'export const SCHEDULE_EDITABLE_STATUSES', why: 'Lifecycle: when the customer may set the pickup date/time; not money.' },
  { file: 'db/bookingRepo.ts', match: 'export const STAFF_SCHEDULE_EDITABLE_STATUSES', why: 'Lifecycle: when ops may set the pickup date/time; not money.' },
  { file: 'db/bookingRepo.ts', match: 'export const SEAT_SOLD_STATUSES', why: 'Inventory: seats a going-ahead booking occupies on the ride board ("N booked"); a pay-on-the-day seat is sold too.' },
  { file: 'db/experienceInterestRepo.ts', match: 'export const PAID_BOOKING_STATUSES', why: 'Lifecycle: an experience interest is worked only once its booking left checkout; no amount is read from it.' },
  { file: 'routes/ops.ts', match: 'const QUEUE_STATUSES = [', why: 'Ops queue filter: every post-checkout status is listed; not a money question.' },
  { file: 'services/scheduler.ts', match: "const TRAVELLED_STATUSES = ['paid'", why: 'Review request: the trip went ahead (or is due); not money.' },
  { file: 'services/scheduler.ts', match: "active: b.status === 'paid' || b.status === 'confirmed'", why: 'Details reminder: booking still going ahead; payment time comes from the ledger (paidAt).' },
  { file: 'services/scheduler.ts', match: "if ((b.status === 'paid' || b.status === 'confirmed') && untilStart > 0", why: 'Pre-trip reminder: booking still going ahead; not money.' },
  { file: 'services/digest.ts', match: "(b.status === 'paid' || b.status === 'confirmed')", why: 'Daily digest chase list: going-ahead bookings still missing pickup details; not money.' },
  { file: 'services/analytics/business.ts', match: "b.status === 'paid' && (!b.fulfilmentStatus || b.fulfilmentStatus === 'paid')", why: 'Needs-attention "Vehicle not confirmed": a fulfilment stage check, not a money claim.' },
  { file: 'db/postgresRefundRepo.ts', match: "if (!['paid', 'confirmed', 'cancelled'].includes(booking.status))", why: 'Full refund decided from the ledger (refunded === captured); this only checks the state machine allows → refunded.' },
  { file: 'domain/balance.ts', match: 'export const SECURED_STATUSES', why: 'Trip going ahead: gates whether a balance can be open/settled; the amount owed is total minus paidCents.' },

  // Runs only after money has moved, or checks status AGAINST the ledger.
  { file: 'routes/admin.ts', match: "if (recorded && (booking.status === 'paid' || arrangedLater))", why: "Mark-paid repair short-circuit: only after the ledger row is succeeded (`recorded`); its own status move." },
  { file: 'services/bookingTracking.ts', match: "event.toStatus === 'paid' &&", why: 'Reconciliation: each captured ledger payment must have its → paid transition; money read from the ledger.' },
  { file: 'domain/paymentCase.ts', match: 'const PAID_STATUSES = new Set(', why: 'Payment lookup discrepancy check: status vs ledger (moneyIn); pay-on-the-day branched out first.' },
  { file: 'routes/bookings.ts', match: "outcome: status === 'paid' ? 'settled' : status", why: 'Local `status` is the return-page answer computed from succeeded ledger rows, not booking status.' },

  // Not booking statuses: ride fulfilment stages and experience-interest statuses.
  { file: 'domain/rideStatus.ts', match: 'export const RIDE_STATUSES = [', why: "Ride fulfilment stages (ride_ops); 'paid' is a stage label, not a booking status." },
  { file: 'domain/rideStatus.ts', match: "vehicle_confirmed: ['pickup_confirmed', 'paid', 'no_show']", why: 'Ride fulfilment state machine; not booking status.' },
  { file: 'routes/ops.ts', match: "ride.fulfilmentStatus !== 'paid'", why: 'Ride fulfilment stage: has the Ceylon Hop team been assigned the job yet; not money.' },
  { file: 'db/experienceInterestRepo.ts', match: "r.status === 'paid' && !r.confirmationSentAt", why: "Experience-interest status (its own 'paid' requires a payment ref); not a booking status." },
  { file: 'db/experienceInterestRepo.ts', match: "if (r.status === 'paid') {", why: "Experience-interest status with its own recorded amount; not a booking status." },
  { file: 'db/experienceInterestRepo.ts', match: "next.status === 'paid' && next.paymentRef == null", why: 'Experience-interest CHECK mirror: paid requires a payment ref; not a booking status.' },
  { file: 'routes/opsExperiences.ts', match: "current.status) === 'paid' && !ref", why: 'Experience-interest status: paid requires a payment ref; not a booking status.' },
  { file: 'routes/opsExperiences.ts', match: "if (lead.status !== 'paid')", why: 'Experience-interest status; not a booking status.' },

  // Money answered from booking status. Out of scope for this guard's task: surfaced, not fixed.
  { file: 'domain/promoCode.ts', match: 'export const PROMO_PAID_STATUSES = [', why: "KNOWN GAP: a promo use counts as 'paid' from status (confirmed/in_progress/completed/no_show/refunded) with no succeeded payment, so a pay-on-the-day booking (incl. a no-show that never paid) consumes a use as paid; SQL twin in postgresBookingRepo.countUses." },
  { file: 'services/watchdog.ts', match: 'const PAID_OR_LATER = [', why: 'KNOWN GAP: "money in once it reaches any of these" — a newer confirmed pay-on-the-day booking with no payment makes the stuck-pending alert say "the customer paid on <ref>" and suppresses the recovery email.' },
];

const covers = (a: Allowed, h: Hit) => a.file === h.file && h.text.includes(a.match);

describe('money-from-status architecture', () => {
  const hits = scan();

  it('reads money from the ledger, not from booking status', () => {
    const unexplained = hits
      .filter((h) => !ALLOWLIST.some((a) => covers(a, h)))
      .map((h) => `${h.file}:${h.line}  ${h.text}`);
    expect(
      unexplained,
      'Booking status describes the trip, not the money. Read "was money taken / what is owed" from the ' +
        'payments ledger (paidCents / balanceDueCents in domain/balance.ts), or, if this is not a money ' +
        'question, add an ALLOWLIST entry in moneyFromStatusArchitecture.test.ts with a one-line reason.',
    ).toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    const stale = ALLOWLIST.filter((a) => !hits.some((h) => covers(a, h))).map((a) => `${a.file}: ${a.match}`);
    expect(stale, 'These allowlist entries no longer match any code; delete them.').toEqual([]);
  });

  it('has a reason for every allowlist entry', () => {
    expect(ALLOWLIST.filter((a) => a.why.trim().length < 10)).toEqual([]);
  });
});
