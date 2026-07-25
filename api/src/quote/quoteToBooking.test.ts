import { describe, it, expect } from 'vitest';
import { quoteToBooking, QuoteNotBookableError, type BookingDetails } from './quoteToBooking';
import type { SavedQuote } from '../db/quoteRepo';

const CUST = { firstName: 'A', lastName: 'B', email: 'a@b.com', whatsapp: '+94123456', country: 'LK' };
const DETAILS: BookingDetails = { customer: CUST, vehicleType: 'car', pax: 2, bags: 1, date: '2026-08-01', time: '09:00' };

// Minimal SavedQuote for mapping — only request.engine + totals matter here.
function q(engine: unknown): SavedQuote {
  return { id: 'q1', reference: 'Q-1', channel: 'ops', status: 'sent', totalCents: 21900,
    currency: 'USD', request: { engine }, result: {}, convertedBookingId: null } as unknown as SavedQuote;
}

describe('quoteToBooking', () => {
  it('private single leg → single booking', () => {
    const m = quoteToBooking(q({ product: 'private', vehicle: 'car', pax: 2, bags: 1,
      legs: [{ from: 'CMB', to: 'Galle', distanceKm: 120 }] }), DETAILS);
    expect(m.mode).toBe('single');
    if (m.mode === 'single') {
      expect(m.input.from).toBe('CMB');
      expect(m.input.to).toBe('Galle');
      expect(m.input.adults).toBe(2);
      expect(m.input.children).toBe(0);
      expect(m.input.vehicleType).toBe('car');
      expect(m.input.customer.email).toBe('a@b.com');
    }
    expect(m.distanceKm).toBe(120);
  });

  it('private multi-leg → trip with chained stops', () => {
    const m = quoteToBooking(q({ product: 'private', vehicle: 'car', pax: 2, bags: 1, legs: [
      { from: 'CMB', to: 'Sigiriya', distanceKm: 170 },
      { from: 'Sigiriya', to: 'CMB', distanceKm: 170 }] }), DETAILS);
    expect(m.mode).toBe('trip');
    if (m.mode === 'trip') {
      expect(m.input.stops).toEqual(['CMB', 'Sigiriya', 'CMB']);
      expect(m.input.serviceType).toBe('private');
      expect(m.input.pax).toBe(2);
      expect(m.input.nights).toEqual([0, 0]);
    }
    expect(m.distanceKm).toBe(340);
  });

  it('chauffeur → trip with days/driverNights from the date span', () => {
    const m = quoteToBooking(q({ product: 'chauffeur', vehicle: 'van',
      firstDate: '2026-08-01', lastDate: '2026-08-03', travelDays: [
        { date: '2026-08-01', from: 'CMB', to: 'Kandy', distanceKm: 120 },
        { date: '2026-08-03', from: 'Kandy', to: 'CMB', distanceKm: 120 }] }), DETAILS);
    expect(m.mode).toBe('trip');
    if (m.mode === 'trip') {
      expect(m.input.serviceType).toBe('chauffeur');
      expect(m.input.days).toBe(3);
      expect(m.input.driverNights).toBe(2);
      expect(m.input.stops).toEqual(['CMB', 'Kandy', 'CMB']);
    }
  });

  // ── Multi-stop rides (phase 1): stored engine requests may carry Ride-shaped legs/days.
  // quoteToBooking normalizes each, sums distance via rideRawKm, and chains stops as
  // rides[0].stops + each later ride.stops.slice(1) — byte-identical to today for old-shape. ──
  it('private single 2-stop ride → single booking (from/to = the two stops)', () => {
    const m = quoteToBooking(q({ product: 'private', vehicle: 'car', pax: 2, bags: 1,
      legs: [{ stops: ['CMB', 'Galle'], segmentKms: [120] }] }), DETAILS);
    expect(m.mode).toBe('single');
    if (m.mode === 'single') {
      expect(m.input.from).toBe('CMB');
      expect(m.input.to).toBe('Galle');
    }
    expect(m.distanceKm).toBe(120);
  });

  it('private single 3+-stop ride → trip with stops = the ride stops', () => {
    const m = quoteToBooking(q({ product: 'private', vehicle: 'car', pax: 2, bags: 1,
      legs: [{ stops: ['CMB', 'Kandy', 'Ella'], segmentKms: [115, 140] }] }), DETAILS);
    expect(m.mode).toBe('trip');
    if (m.mode === 'trip') {
      expect(m.input.stops).toEqual(['CMB', 'Kandy', 'Ella']);
      expect(m.input.nights).toEqual([0, 0]);
      expect(m.input.serviceType).toBe('private');
    }
    expect(m.distanceKm).toBe(255);
  });

  it('private multi-ride trip: chain = rides[0].stops + each later ride.stops.slice(1)', () => {
    const m = quoteToBooking(q({ product: 'private', vehicle: 'car', pax: 2, bags: 1, legs: [
      { stops: ['CMB', 'Kandy', 'Sigiriya'], segmentKms: [115, 90] }, // 3-stop ride
      { from: 'Sigiriya', to: 'CMB', distanceKm: 175 },              // old-shape chaining leg
    ] }), DETAILS);
    expect(m.mode).toBe('trip');
    if (m.mode === 'trip') expect(m.input.stops).toEqual(['CMB', 'Kandy', 'Sigiriya', 'CMB']);
    expect(m.distanceKm).toBe(380); // 115 + 90 + 175, summed via rideRawKm
  });

  it('pins the pre-existing quirk (GC-13): a non-chaining later leg silently drops its own from', () => {
    const m = quoteToBooking(q({ product: 'private', vehicle: 'car', pax: 2, bags: 1, legs: [
      { from: 'CMB', to: 'Kandy', distanceKm: 115 },
      { from: 'Ella', to: 'Galle', distanceKm: 200 }, // leg 2 does NOT start at Kandy
    ] }), DETAILS);
    expect(m.mode).toBe('trip');
    // today's list = [legs[0].from, ...legs.map(l=>l.to)] = ['CMB','Kandy','Galle'] — 'Ella' is dropped.
    // This is pre-existing behavior we deliberately reproduce (NOT fix).
    if (m.mode === 'trip') expect(m.input.stops).toEqual(['CMB', 'Kandy', 'Galle']);
  });

  it('chauffeur with a multi-stop ride day chains stops + sums distance the same way', () => {
    const m = quoteToBooking(q({ product: 'chauffeur', vehicle: 'van', firstDate: '2026-08-01', lastDate: '2026-08-03',
      travelDays: [
        { date: '2026-08-01', stops: ['CMB', 'Kandy', 'Sigiriya'], segmentKms: [115, 90] },
        { date: '2026-08-03', from: 'Sigiriya', to: 'CMB', distanceKm: 175 },
      ] }), DETAILS);
    expect(m.mode).toBe('trip');
    if (m.mode === 'trip') {
      expect(m.input.stops).toEqual(['CMB', 'Kandy', 'Sigiriya', 'CMB']);
      expect(m.input.days).toBe(3);
      expect(m.input.driverNights).toBe(2);
    }
    expect(m.distanceKm).toBe(380);
  });

  it('shared or engine-less quote is not bookable', () => {
    expect(() => quoteToBooking(q({ product: 'shared', legs: [] }), DETAILS)).toThrow(QuoteNotBookableError);
    expect(() => quoteToBooking(q(undefined), DETAILS)).toThrow(QuoteNotBookableError);
  });
});
