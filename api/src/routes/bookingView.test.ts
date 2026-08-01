import { describe, it, expect } from 'vitest';
import { projectBooking } from './bookings.js';
import type { Booking } from '../db/bookingRepo.js';

/* The customer card (manage.html) could only ever say "first → last": projectBooking collapsed a
   trip's stops[] to from/to and its dates[] to the first one, and threw the rest away. So a
   four-stop tour rendered exactly like a direct transfer, and there was no end date to show.
   The chain and the per-leg dates are now surfaced; from/to/date stay for back-compat. */

const customer = { firstName: 'Roshen', lastName: 'W', email: 'r@example.test', phone: '+94770000000', country: 'LK' };
const base = { id: 'b1', reference: 'CH-TEST1', status: 'payment_pending', currency: 'USD', total: 22900, amountDueNow: 22900 };

const tripBooking = {
  ...base,
  mode: 'trip',
  input: {
    customer,
    stops: ['Colombo Airport (CMB)', 'Sigiriya', 'Kandy', 'Batticaloa'],
    dates: ['2026-07-22', '2026-07-24', '2026-07-26'],
    pax: 2, vehicleType: 'car',
  },
} as unknown as Booking;

const singleBooking = {
  ...base,
  mode: 'single',
  input: { customer, from: 'Colombo Airport (CMB)', to: 'Batticaloa', date: '2026-07-22', time: '09:00', adults: 2, children: 0, bags: 1, vehicleType: 'car' },
} as unknown as Booking;

describe('projectBooking surfaces the whole journey', () => {
  it('keeps every stop on a trip, not just the endpoints', () => {
    const v = projectBooking(tripBooking);
    expect(v.stops).toEqual(['Colombo Airport (CMB)', 'Sigiriya', 'Kandy', 'Batticaloa']);
    // from/to still answer the old contract.
    expect(v.from).toBe('Colombo Airport (CMB)');
    expect(v.to).toBe('Batticaloa');
  });

  it('exposes one date per leg, and the trip start and end', () => {
    const v = projectBooking(tripBooking);
    expect(v.legDates).toEqual(['2026-07-22', '2026-07-24', '2026-07-26']); // stops.length - 1
    expect(v.date).toBe('2026-07-22');    // start (unchanged contract)
    expect(v.endDate).toBe('2026-07-26'); // last leg — this is what the card had no way to show
  });

  it('pads legDates when a trip is only partly dated', () => {
    const partly = { ...tripBooking, input: { ...(tripBooking as never as { input: Record<string, unknown> }).input, dates: ['2026-07-22'] } } as unknown as Booking;
    const v = projectBooking(partly);
    expect(v.legDates).toEqual(['2026-07-22', null, null]);
    expect(v.endDate).toBe('2026-07-22'); // the last date we actually know
  });

  it('treats a direct transfer as a two-stop journey so the card can count stops uniformly', () => {
    const v = projectBooking(singleBooking);
    expect(v.stops).toEqual(['Colombo Airport (CMB)', 'Batticaloa']);
    expect(v.legDates).toEqual(['2026-07-22']);
    expect(v.endDate).toBe('2026-07-22');
  });

  it('never leaves the card without a chain to count', () => {
    for (const b of [tripBooking, singleBooking]) {
      const v = projectBooking(b);
      expect(v.stops.length).toBeGreaterThanOrEqual(2);
      expect(v.legDates).toHaveLength(v.stops.length - 1);
    }
  });
});
