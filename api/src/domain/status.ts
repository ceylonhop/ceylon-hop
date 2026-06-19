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

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return ALLOWED[from].includes(to);
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

export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
