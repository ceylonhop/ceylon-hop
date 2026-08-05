import { describe, it, expect } from 'vitest';
import { quoteToBooking, isQuoteBookable, QuoteNotBookableError, type BookingDetails } from './quoteToBooking';
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

  // Was: "pins the pre-existing quirk (GC-13)". GC-13 dropped a non-chaining leg's own origin,
  // so this booking used to read ['CMB','Kandy','Galle'] — 'Ella' gone and a leg Kandy → Galle
  // that nobody drives invented. That reached the driver's drawer and the customer's email, so
  // the quirk is now fixed and this test asserts the itinerary the operator actually quoted.
  it('a non-chaining later leg keeps its own from, bridging the gap with an extra stop', () => {
    const m = quoteToBooking(q({ product: 'private', vehicle: 'car', pax: 2, bags: 1, legs: [
      { from: 'CMB', to: 'Kandy', distanceKm: 115 },
      { from: 'Ella', to: 'Galle', distanceKm: 200 }, // leg 2 does NOT start at Kandy
    ] }), DETAILS);
    expect(m.mode).toBe('trip');
    if (m.mode === 'trip') {
      expect(m.input.stops).toEqual(['CMB', 'Kandy', 'Ella', 'Galle']);
    }
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

// A quote whose legs don't join up is a legitimate itinerary, not an operator error: the
// customer takes the Ella → Galle train themselves. The booking must therefore say what the
// quote said, gaps included — it is what the ops drawer shows a driver and what the itinerary
// email shows the customer.
describe('a quote whose legs do not connect', () => {
  const privateQuote = (legs: unknown[]) => q({ product: 'private', vehicle: 'car', pax: 2, bags: 1, legs });

  it('keeps every stop across two gaps', () => {
    // CMB→Ella, then the customer makes their own way to Galle, then Galle→Colombo City.
    const m = quoteToBooking(privateQuote([
      { from: 'Colombo Airport (CMB)', to: 'Ella', distanceKm: 213 },
      { from: 'Galle', to: 'Colombo City', distanceKm: 132 },
      { from: 'Kandy', to: 'Batticaloa', distanceKm: 186 },
    ]), DETAILS);

    expect(m.mode).toBe('trip');
    if (m.mode !== 'trip') return;
    expect(m.input.stops).toEqual([
      'Colombo Airport (CMB)', 'Ella', 'Galle', 'Colombo City', 'Kandy', 'Batticaloa',
    ]);
    expect(m.input.nights).toHaveLength(m.input.stops.length - 1);
  });

  it('leaves a fully connected itinerary untouched', () => {
    const m = quoteToBooking(privateQuote([
      { from: 'A', to: 'B', distanceKm: 10 },
      { from: 'B', to: 'C', distanceKm: 20 },
    ]), DETAILS);
    expect(m.mode).toBe('trip');
    if (m.mode !== 'trip') return;
    expect(m.input.stops).toEqual(['A', 'B', 'C']);
  });

  it('a gap inside a multi-stop ride is impossible — its own stops always chain', () => {
    const m = quoteToBooking(privateQuote([
      { stops: ['A', 'B', 'C'], segmentKms: [10, 20] },
      { stops: ['D', 'E'], segmentKms: [30] },
    ]), DETAILS);
    expect(m.mode).toBe('trip');
    if (m.mode !== 'trip') return;
    expect(m.input.stops).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it("keeps a chauffeur trip's dates on the right segments across a gap", () => {
    // Chauffeur days DO carry dates. Inserting a gap stop shifts the segment indices, so each
    // date must still land on the day it belongs to and the gap must carry none.
    const m = quoteToBooking(q({ product: 'chauffeur', vehicle: 'van',
      firstDate: '2026-07-22', lastDate: '2026-07-24', travelDays: [
        { date: '2026-07-22', from: 'A', to: 'B', distanceKm: 10 },
        { date: '2026-07-24', from: 'C', to: 'D', distanceKm: 20 },
      ] }), DETAILS);
    expect(m.mode).toBe('trip');
    if (m.mode !== 'trip') return;
    expect(m.input.dates).toEqual(['2026-07-22', '', '2026-07-24']);
    expect(m.input.dates).toHaveLength(m.input.stops.length - 1);
  });

  it('a chauffeur day with several stops repeats its date across its own segments', () => {
    const m = quoteToBooking(q({ product: 'chauffeur', vehicle: 'van',
      firstDate: '2026-08-01', lastDate: '2026-08-03', travelDays: [
        { date: '2026-08-01', stops: ['CMB', 'Kandy', 'Sigiriya'], segmentKms: [115, 90] },
        { date: '2026-08-03', from: 'Sigiriya', to: 'CMB', distanceKm: 175 },
      ] }), DETAILS);
    expect(m.mode).toBe('trip');
    if (m.mode !== 'trip') return;
    expect(m.input.dates).toEqual(['2026-08-01', '2026-08-01', '2026-08-03']);
  });

  it('a private trip still carries only the modal date, on the first segment', () => {
    // PrivateLeg has no date of its own (the operator's per-leg dates live in the tool payload,
    // not the engine request — its own bug). Only the shape changes: one entry per segment.
    const m = quoteToBooking(privateQuote([
      { from: 'A', to: 'B', distanceKm: 10 },
      { from: 'C', to: 'D', distanceKm: 20 },
    ]), DETAILS);
    expect(m.mode).toBe('trip');
    if (m.mode !== 'trip') return;
    expect(m.input.dates).toEqual(['2026-08-01', '', '']);
    expect(m.input.dates).toHaveLength(m.input.stops.length - 1);
  });

  it('a private trip with no modal date leaves dates absent, as before', () => {
    const m = quoteToBooking(privateQuote([
      { from: 'A', to: 'B', distanceKm: 10 },
      { from: 'B', to: 'C', distanceKm: 20 },
    ]), { ...DETAILS, date: undefined });
    expect(m.mode).toBe('trip');
    if (m.mode !== 'trip') return;
    expect(m.input.dates).toBeUndefined();
  });
});

describe('partial mapping (legIndexes, spec 2026-08-04)', () => {
  const threeLegs = () => q({ product: 'private', vehicle: 'car', pax: 2, bags: 1, legs: [
    { from: 'Colombo', to: 'Kandy', distanceKm: 120 },
    { from: 'Kandy', to: 'Ella', distanceKm: 140 },
    { from: 'Ella', to: 'Galle', distanceKm: 200 }] });

  it('maps only the selected legs and sums only their km', () => {
    const m = quoteToBooking(threeLegs(), DETAILS, { legIndexes: [0, 1] });
    expect(m.mode).toBe('trip');
    if (m.mode === 'trip') expect(m.input.stops).toEqual(['Colombo', 'Kandy', 'Ella']);
    expect(m.distanceKm).toBe(260);
  });

  it('a one-leg subset of a multi-leg quote is a single transfer', () => {
    const m = quoteToBooking(threeLegs(), DETAILS, { legIndexes: [1] });
    expect(m.mode).toBe('single');
    if (m.mode === 'single') {
      expect(m.input.from).toBe('Kandy');
      expect(m.input.to).toBe('Ella');
    }
    expect(m.distanceKm).toBe(140);
  });

  // A dropped middle leg leaves two rides that do not chain — the same gap a disconnected quote
  // produces today. The gap stop is kept, never silently dropped (GC-13).
  it('keeps the gap stop when a middle leg is dropped', () => {
    const m = quoteToBooking(threeLegs(), DETAILS, { legIndexes: [0, 2] });
    expect(m.mode).toBe('trip');
    if (m.mode === 'trip') expect(m.input.stops).toEqual(['Colombo', 'Kandy', 'Ella', 'Galle']);
    expect(m.distanceKm).toBe(320);
  });

  it('is order- and duplicate-insensitive', () => {
    const a = quoteToBooking(threeLegs(), DETAILS, { legIndexes: [1, 0, 1] });
    expect(a.mode).toBe('trip');
    if (a.mode === 'trip') expect(a.input.stops).toEqual(['Colombo', 'Kandy', 'Ella']);
  });

  it('refuses an empty selection', () => {
    expect(() => quoteToBooking(threeLegs(), DETAILS, { legIndexes: [] })).toThrow(QuoteNotBookableError);
  });

  it('leaves every existing caller alone when no option is passed', () => {
    const m = quoteToBooking(threeLegs(), DETAILS);
    if (m.mode === 'trip') expect(m.input.stops).toEqual(['Colombo', 'Kandy', 'Ella', 'Galle']);
    expect(m.distanceKm).toBe(460);
  });

  it('isQuoteBookable answers for the subset', () => {
    expect(isQuoteBookable(threeLegs(), { legIndexes: [2] })).toBe(true);
    expect(isQuoteBookable(threeLegs(), { legIndexes: [] })).toBe(false);
  });
});
