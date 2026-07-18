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

  it('shared or engine-less quote is not bookable', () => {
    expect(() => quoteToBooking(q({ product: 'shared', legs: [] }), DETAILS)).toThrow(QuoteNotBookableError);
    expect(() => quoteToBooking(q(undefined), DETAILS)).toThrow(QuoteNotBookableError);
  });
});
