import type { Booking } from '../db/bookingRepo';
import type { RideOps } from '../db/rideOpsRepo';
import type { RideStatus } from '../domain/rideStatus';

export type OpsStage = 'awaiting_payment' | RideStatus;

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
  };
}
