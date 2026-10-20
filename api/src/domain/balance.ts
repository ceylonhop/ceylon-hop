// Deposits (spec docs/superpowers/specs/2026-10-07-deposits-ops-first-design.md §4). The ONE place
// "how much is still owed" is worked out. Nothing stores a balance: it is the booking total minus
// the succeeded payments, so a balance can never disagree with the money actually held.

type PaymentLike = { status: string; amount: number; purpose: string };
type BookingLike = { status: string; total: number; amountDueNow?: number | null };

// A trip that is going ahead. A deposit moves a booking to `paid` exactly like a full payment, and
// the balance can land after ops has confirmed the driver or the trip has started.
export const SECURED_STATUSES: ReadonlySet<string> = new Set(['paid', 'confirmed', 'in_progress']);
const CLOSED_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'refunded', 'no_show', 'completed']);

export function paidCents(payments: PaymentLike[]): number {
  return payments.filter((p) => p.status === 'succeeded').reduce((sum, p) => sum + p.amount, 0);
}

export function balanceDueCents(booking: BookingLike, payments: PaymentLike[]): number {
  if (CLOSED_STATUSES.has(booking.status)) return 0;
  const paid = paidCents(payments);
  // From the ledger once money is in. A secured booking with NO recorded payment (a legacy or
  // repaired row) falls through to the planned split rather than claiming the whole total is owed.
  if (SECURED_STATUSES.has(booking.status) && paid > 0) return Math.max(0, booking.total - paid);
  return Math.max(0, booking.total - (booking.amountDueNow ?? booking.total));
}

export function isBalanceOpen(booking: BookingLike, payments: PaymentLike[]): boolean {
  return (
    SECURED_STATUSES.has(booking.status) &&
    payments.some((p) => p.purpose === 'deposit' && p.status === 'succeeded') &&
    balanceDueCents(booking, payments) > 0
  );
}
