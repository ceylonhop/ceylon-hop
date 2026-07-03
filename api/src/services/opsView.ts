import type { Booking } from '../db/bookingRepo';
import type { RideOps } from '../db/rideOpsRepo';

export interface OpsBookingRow {
  id: string; reference: string; mode: string; bookingStatus: string;
  paymentStatus: 'paid' | 'unpaid' | 'partial'; amount: number; currency: string;
  customerFirstName: string; customerName: string;
  route: string; travelDate: string | null; travelTime: string | null; pax: number;
  coordinatorId: string | null; fulfilmentStatus: string;
  vehiclePhotoReceived: boolean; customerUpdated: boolean;
  channel: 'website' | 'whatsapp';
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

export function toOpsRow(b: Booking, opts: { rideOps?: RideOps | null; paid: boolean }): OpsBookingRow {
  const t = travel(b);
  const c = b.input.customer;
  return {
    id: b.id, reference: b.reference, mode: b.mode, bookingStatus: b.status,
    paymentStatus: opts.paid ? 'paid' : 'unpaid', amount: b.total, currency: b.currency,
    customerFirstName: c.firstName, customerName: `${c.firstName} ${c.lastName}`.trim(),
    route: route(b), travelDate: t.date, travelTime: t.time, pax: pax(b),
    coordinatorId: opts.rideOps?.coordinatorId ?? null,
    fulfilmentStatus: opts.rideOps?.fulfilmentStatus ?? 'unassigned',
    vehiclePhotoReceived: opts.rideOps?.vehiclePhotoReceived ?? false,
    customerUpdated: opts.rideOps?.customerUpdated ?? false,
    channel: b.channel,
  };
}

export function manifestLine(b: Booking): string {
  const t = travel(b);
  const c = b.input.customer;
  return `• ${t.time ?? 'TBC'} — ${route(b)} — ${pax(b)} pax — ${c.firstName} (${b.reference})`;
}
