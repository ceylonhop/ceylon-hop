// Booking lifecycle (spec §7). Forward transitions are explicit; everything else is illegal.
export const BOOKING_STATUSES = [
  'draft',
  'payment_pending',
  'awaiting_details',
  'paid',
  'confirmed',
  'in_progress',
  'completed',
  'cancelled',
  'refunded',
  'no_show',
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

const ALLOWED: Record<BookingStatus, BookingStatus[]> = {
  draft: ['payment_pending', 'awaiting_details', 'cancelled'],
  payment_pending: ['paid', 'awaiting_details', 'cancelled'],
  awaiting_details: ['payment_pending', 'paid', 'cancelled'],
  paid: ['confirmed', 'cancelled', 'refunded'],
  confirmed: ['in_progress', 'cancelled', 'refunded', 'no_show'],
  in_progress: ['completed', 'no_show'],
  completed: [],
  cancelled: ['refunded'],
  refunded: [],
  no_show: [],
};

// Edges that exist only for a booking whose money is arranged for later (pay on the day, 0077):
// the trip is confirmed before any payment. Kept apart from ALLOWED so the ordinary lifecycle is
// exactly as it was — status is the trip, the payments ledger is the money (domain/balance.ts).
const ARRANGED: Partial<Record<BookingStatus, BookingStatus[]>> = {
  payment_pending: ['confirmed'],
};

export interface TransitionContext {
  paymentArrangement?: string | null;
}

export function canTransition(from: BookingStatus, to: BookingStatus, ctx?: TransitionContext): boolean {
  if (ALLOWED[from].includes(to)) return true;
  return !!ctx?.paymentArrangement && (ARRANGED[from] ?? []).includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: BookingStatus,
    public readonly to: BookingStatus,
  ) {
    super(`Illegal booking transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition(from: BookingStatus, to: BookingStatus, ctx?: TransitionContext): void {
  if (!canTransition(from, to, ctx)) throw new IllegalTransitionError(from, to);
}
