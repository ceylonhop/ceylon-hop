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

// The add-ons the customer chose reach the manage card as the booking carries them (booking.addOns,
// read off its quote). Only when there are some: no empty row on a booking without add-ons.
describe('projectBooking names the add-ons the customer chose', () => {
  it('passes the booking add-ons through, on a trip and a transfer', () => {
    const trip = { ...tripBooking, addOns: ['Waiting fee — Sigiriya → Kandy'] } as unknown as Booking;
    const single = { ...singleBooking, addOns: ['Sightseeing stops (up to 3h)'] } as unknown as Booking;
    expect(projectBooking(trip).addOns).toEqual(['Waiting fee — Sigiriya → Kandy']);
    expect(projectBooking(single).addOns).toEqual(['Sightseeing stops (up to 3h)']);
  });

  it('leaves the field out when nothing was chosen', () => {
    expect(projectBooking(singleBooking)).not.toHaveProperty('addOns');
    expect(projectBooking(tripBooking)).not.toHaveProperty('addOns');
  });
});

// The road the customer paid for, when it isn't the expressway (route choice, spec §4.3). The
// manage card is where a paying customer lands, and it was the one customer view that never said
// which road they bought. Same words as the emails (roadRow). Only when there is one: every
// existing booking's view keeps exactly the keys it had.
describe('projectBooking names the local road the customer chose', () => {
  it('a transfer on the local road says so, with its drive time', () => {
    const b = { ...singleBooking, durationMin: 374, input: { ...(singleBooking as never as { input: Record<string, unknown> }).input, routeVariant: 'no_tolls' } } as unknown as Booking;
    expect(projectBooking(b).road).toBe('Local road, no expressway · about 6h 14m');
  });

  it('a trip names the legs that take the local road', () => {
    const b = { ...tripBooking, input: { ...(tripBooking as never as { input: Record<string, unknown> }).input, routeVariants: ['fastest', 'no_tolls', 'fastest'] } } as unknown as Booking;
    expect(projectBooking(b).road).toBe('Local road for Sigiriya → Kandy');
  });

  it('leaves the field out on the expressway — the view keeps exactly its old keys', () => {
    const fastest = { ...singleBooking, input: { ...(singleBooking as never as { input: Record<string, unknown> }).input, routeVariant: 'fastest' } } as unknown as Booking;
    for (const b of [singleBooking, tripBooking, fastest]) expect(projectBooking(b)).not.toHaveProperty('road');
    expect(Object.keys(projectBooking(singleBooking))).toEqual([
      'reference', 'status', 'mode', 'firstName', 'currency', 'totalCents', 'amountDueNowCents', 'balanceDueCents',
      'paidCents', 'balancePayable', 'needsPricing',
      'from', 'to', 'date', 'time', 'stops', 'legDates', 'endDate', 'travellers', 'bags', 'vehicleType',
    ]);
    expect(JSON.stringify(projectBooking(fastest))).toBe(JSON.stringify(projectBooking(singleBooking)));
  });
});

// A booking made with a promo code shows the code and what it took off (manage card: a Promo row
// above Total). Only then: every other booking's view keeps exactly the keys it had.
describe('projectBooking names the promo code the customer used', () => {
  it('passes the code and the discount through', () => {
    const b = { ...singleBooking, total: 20610, amountDueNow: 20610, promoCodeId: 'pc1', promoCode: 'SUMMER-15', discountTotal: 2290 } as unknown as Booking;
    const v = projectBooking(b);
    expect(v.promoCode).toBe('SUMMER-15');
    expect(v.discountCents).toBe(2290);
    expect(v.totalCents).toBe(20610);
  });

  it('leaves both out without a code', () => {
    for (const b of [singleBooking, tripBooking]) {
      expect(projectBooking(b)).not.toHaveProperty('promoCode');
      expect(projectBooking(b)).not.toHaveProperty('discountCents');
    }
  });
});

// A booking the engine couldn't price carries a flat placeholder total that checkout refuses. The
// manage card showed that placeholder with an enabled Pay button, and pressing it said "already
// paid or closed". The view now says the booking is awaiting a hand price, so the card can say so.
describe('projectBooking says when the price is still being confirmed by hand', () => {
  it('is true on an unpriced booking, on a transfer and a trip', () => {
    for (const b of [singleBooking, tripBooking]) {
      expect(projectBooking({ ...b, needsPricing: true } as unknown as Booking).needsPricing).toBe(true);
    }
  });

  it('is false on a priced booking, including one that predates the column', () => {
    expect(projectBooking({ ...singleBooking, needsPricing: false } as unknown as Booking).needsPricing).toBe(false);
    expect(projectBooking(singleBooking).needsPricing).toBe(false); // needsPricing absent
  });
});

// Customers could not tell where the shared taxi picks them up or sets them down: the manage card
// named the towns only (owner, 2026-10-29). A recorded leg now carries its published points.
describe('projectBooking names a shared leg\'s pick-up and drop-off points', () => {
  const seat = {
    mode: 'shared', id: 'id-s', reference: 'CH-SEAT1', status: 'paid', createdAt: '2026-10-01T00:00:00.000Z',
    total: 1999, currency: 'USD', channel: 'website',
    input: { corridorId: 'airport-cultural', fromPlace: 'Sigiriya / Dambulla', toPlace: 'Kandy', date: '2026-11-04', time: '11:30', seats: 1,
      customer: { firstName: 'Maya', lastName: 'S', email: 'm@x.com', whatsapp: '+34600000000', country: 'Spain' } },
  } as unknown as Booking;

  it('carries both points on a recorded leg', () => {
    const v = projectBooking(seat);
    expect(v.pickupPoint).toBe('Barista Cafe, Sigiriya');
    expect(v.dropoffPoint).toBe('Kandy City Centre');
  });

  it('leaves them out where it cannot know the leg, and off non-shared bookings', () => {
    const legacy = { ...seat, input: { ...(seat as any).input, fromPlace: undefined, toPlace: undefined } } as unknown as Booking;
    for (const b of [legacy, singleBooking, tripBooking]) {
      expect(projectBooking(b)).not.toHaveProperty('pickupPoint');
      expect(projectBooking(b)).not.toHaveProperty('dropoffPoint');
    }
  });
});
