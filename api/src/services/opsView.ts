import type { Booking } from '../db/bookingRepo';
import type { RideOps } from '../db/rideOpsRepo';
import type { RideStatus } from '../domain/rideStatus';

// 'gathering' belongs to the ride board, not the booking machine: a van that is
// still collecting names has no booking, no payment and nothing for ops to
// advance. It rides in this union so one queue can show both kinds of row.
// 'cancelled'/'refunded' come from the BOOKING lifecycle rather than ride_ops — a booking
// closed on the money side has no fulfilment stage to report, and before these existed it
// simply dropped out of the queue with no way to find it again.
export type OpsStage = 'awaiting_payment' | 'gathering' | 'cancelled' | 'refunded' | RideStatus;

/** Where a queue row came from. Ride-board rows are read-only projections. */
export type OpsRowSource = 'booking' | 'ride_board';

/** The ride-board-only half of a queue row (absent on real bookings). */
export interface OpsBoardDetail {
  code: string;
  listStatus: string;
  seatsCommitted: number;
  minSeats: number;
  capacity: number;
  seatPrice: number; // minor units, per seat
  cutoffAt: string; // ISO
  /** Live manifest — first name + country only, never email or subject. */
  members: Array<{ position: number; firstName: string; country: string; seats: number; status: string }>;
}

export interface OpsBookingRow {
  id: string;
  reference: string;
  mode: string;
  channel: 'website' | 'whatsapp';
  bookingStatus: string;
  stage: OpsStage;
  paymentStatus: 'paid' | 'unpaid';
  amount: number; // minor units
  currency: string;
  customerFirstName: string;
  customerName: string;
  route: string;
  travelDate: string | null;
  travelTime: string | null;
  pax: number;
  vehiclePhotoReceived: boolean;
  customerUpdated: boolean;
  opsNotes: string | null;
  source: OpsRowSource;
  board?: OpsBoardDetail;
}

function route(b: Booking): string {
  if (b.mode === 'trip') return b.input.stops.join(' → ');
  if (b.mode === 'shared') return `Shared · ${b.input.corridorId}`;
  return `${b.input.from} → ${b.input.to}`;
}
function pax(b: Booking): number {
  if (b.mode === 'trip') return b.input.pax;
  if (b.mode === 'shared') return b.input.seats;
  return b.input.adults + b.input.children;
}
function travel(b: Booking): { date: string | null; time: string | null } {
  if (b.mode === 'trip') return { date: b.input.dates?.find(Boolean) ?? null, time: null };
  if (b.mode === 'shared') return { date: b.input.date, time: b.input.time };
  return { date: b.input.date ?? null, time: b.input.time ?? null };
}

function stageFor(b: Booking, rideOps: RideOps | null | undefined): OpsStage {
  // A closed booking outranks whatever the fulfilment row last said: a refund on a ride ops
  // had already marked 'on_trip' is still a refund, and showing it mid-pipeline would invite
  // someone to keep advancing it.
  if (b.status === 'cancelled') return 'cancelled';
  if (b.status === 'refunded') return 'refunded';
  if (b.status === 'payment_pending') return 'awaiting_payment';
  return rideOps?.fulfilmentStatus ?? 'paid';
}

export function toOpsRow(b: Booking, opts: { rideOps?: RideOps | null; paid: boolean }): OpsBookingRow {
  const t = travel(b);
  const c = b.input.customer;
  return {
    id: b.id, reference: b.reference, mode: b.mode, channel: b.channel,
    bookingStatus: b.status, stage: stageFor(b, opts.rideOps),
    paymentStatus: opts.paid ? 'paid' : 'unpaid', amount: b.total, currency: b.currency,
    customerFirstName: c.firstName, customerName: `${c.firstName} ${c.lastName}`.trim(),
    route: route(b), travelDate: t.date, travelTime: t.time, pax: pax(b),
    vehiclePhotoReceived: opts.rideOps?.vehiclePhotoReceived ?? false,
    customerUpdated: opts.rideOps?.customerUpdated ?? false,
    opsNotes: opts.rideOps?.opsNotes ?? null,
    source: 'booking',
  };
}
