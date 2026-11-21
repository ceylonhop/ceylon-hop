// Add-ons after booking (spec 2026-11-14 §4): which bookings and legs can take one, when a request
// can still be paid, and what a request is shown as. Pure rules, so every date here is passed in.
import { describe, it, expect } from 'vitest';
import {
  addOnCatalogue,
  addOnIdempotencyKey,
  addOnLineLabel,
  addOnOrderId,
  addOnRequestState,
  bookingAddOnEligibility,
  isAddOnRequestPayable,
  isPrivateBooking,
  legAddOnEligibility,
  type AddOnRequestState,
  type AddOnRequestStatus,
} from './addOns';
import type { StoredLeg } from '../db/addOnRepo';
import { RATE_CARD } from '../quote/rateCard';

const TODAY = '2026-12-10';
const YESTERDAY = '2026-12-09';
const TOMORROW = '2026-12-11';

const leg = (over: Partial<StoredLeg> = {}): StoredLeg => ({
  id: 'leg-1', seq: 1, kind: 'leg', from: 'Kandy', to: 'Ella', viaStops: [], travelDate: TOMORROW, ...over,
});
const single = (over: Record<string, unknown> = {}) => ({ mode: 'single', status: 'paid', ...over });
const request = (status: AddOnRequestStatus, legIds: string[] = ['leg-1'], totalCents = 1000) => ({
  status, totalCents, lines: legIds.map((legId) => ({ legId })),
});

describe('isPrivateBooking', () => {
  it('accepts a single transfer', () => {
    expect(isPrivateBooking({ mode: 'single' })).toBe(true);
  });
  it('accepts a private multi-stop trip', () => {
    expect(isPrivateBooking({ mode: 'trip', serviceType: 'private' })).toBe(true);
  });
  it('refuses a chauffeur trip, a trip with no service type, and a shared seat', () => {
    expect(isPrivateBooking({ mode: 'trip', serviceType: 'chauffeur' })).toBe(false);
    expect(isPrivateBooking({ mode: 'trip' })).toBe(false);
    expect(isPrivateBooking({ mode: 'trip', serviceType: null })).toBe(false);
    expect(isPrivateBooking({ mode: 'shared' })).toBe(false);
  });
});

describe('bookingAddOnEligibility (§4.1)', () => {
  it('accepts a private single and a private trip that is paid, confirmed or in progress', () => {
    for (const status of ['paid', 'confirmed', 'in_progress']) {
      expect(bookingAddOnEligibility(single({ status }), [leg()])).toBeNull();
      expect(bookingAddOnEligibility({ mode: 'trip', serviceType: 'private', status }, [leg()])).toBeNull();
    }
  });
  it('refuses shared and chauffeur as not_private', () => {
    expect(bookingAddOnEligibility({ mode: 'shared', status: 'paid' }, [leg()])).toBe('not_private');
    expect(bookingAddOnEligibility({ mode: 'trip', serviceType: 'chauffeur', status: 'paid' }, [leg()])).toBe('not_private');
  });
  it('refuses a booking that is not secured', () => {
    for (const status of ['draft', 'payment_pending', 'completed', 'cancelled', 'refunded', 'no_show']) {
      expect(bookingAddOnEligibility(single({ status }), [leg()])).toBe('booking_not_eligible');
    }
  });
  it('refuses a booking still awaiting its price', () => {
    expect(bookingAddOnEligibility(single({ needsPricing: true }), [leg()])).toBe('awaiting_price');
    expect(bookingAddOnEligibility(single({ needsPricing: false }), [leg()])).toBeNull();
    expect(bookingAddOnEligibility(single({ needsPricing: null }), [leg()])).toBeNull();
  });
  it('refuses a booking with no stored legs', () => {
    expect(bookingAddOnEligibility(single(), [])).toBe('legs_missing');
  });
  it('names the first reason when several apply', () => {
    expect(bookingAddOnEligibility({ mode: 'shared', status: 'draft', needsPricing: true }, [])).toBe('not_private');
    expect(bookingAddOnEligibility(single({ status: 'draft', needsPricing: true }), [])).toBe('booking_not_eligible');
    expect(bookingAddOnEligibility(single({ needsPricing: true }), [])).toBe('awaiting_price');
  });
});

describe('legAddOnEligibility (§4.1)', () => {
  it('refuses a leg that is not one of the booking’s stored legs', () => {
    expect(legAddOnEligibility(undefined, TODAY)).toBe('leg_not_found');
  });
  it('refuses a gap and a chauffeur day: neither is a leg we drive as one', () => {
    expect(legAddOnEligibility(leg({ kind: 'gap' }), TODAY)).toBe('leg_not_driven');
    expect(legAddOnEligibility(leg({ kind: 'day' }), TODAY)).toBe('leg_not_driven');
  });
  it('refuses a leg whose day has passed', () => {
    expect(legAddOnEligibility(leg({ travelDate: YESTERDAY }), TODAY)).toBe('leg_passed');
  });
  it('accepts a leg dated today, a later one, and one with no date', () => {
    expect(legAddOnEligibility(leg({ travelDate: TODAY }), TODAY)).toBeNull();
    expect(legAddOnEligibility(leg({ travelDate: TOMORROW }), TODAY)).toBeNull();
    expect(legAddOnEligibility(leg({ travelDate: null }), TODAY)).toBeNull();
  });
});

describe('isAddOnRequestPayable (§4.4)', () => {
  const payable = (status: AddOnRequestStatus, bookingStatus: string, travelDate: string | null) =>
    isAddOnRequestPayable(request(status), { status: bookingStatus }, [leg({ travelDate })], TODAY);

  it('an open request on a going-ahead booking is payable up to the end of the leg’s day', () => {
    for (const bookingStatus of ['paid', 'confirmed', 'in_progress']) {
      expect(payable('open', bookingStatus, TOMORROW)).toBe(true);
      expect(payable('open', bookingStatus, TODAY)).toBe(true);
      expect(payable('open', bookingStatus, null)).toBe(true);
      expect(payable('open', bookingStatus, YESTERDAY)).toBe(false);
    }
  });
  it('a completed booking: a leg dated today is still payable, an undated leg is not', () => {
    expect(payable('open', 'completed', TODAY)).toBe(true);
    expect(payable('open', 'completed', TOMORROW)).toBe(true);
    expect(payable('open', 'completed', null)).toBe(false);
    expect(payable('open', 'completed', YESTERDAY)).toBe(false);
  });
  it('is never payable on a booking that is unpaid or closed', () => {
    for (const bookingStatus of ['draft', 'payment_pending', 'cancelled', 'refunded', 'no_show']) {
      expect(payable('open', bookingStatus, TOMORROW)).toBe(false);
    }
  });
  it('a paid or cancelled request is not payable', () => {
    expect(payable('paid', 'confirmed', TOMORROW)).toBe(false);
    expect(payable('cancelled', 'confirmed', TOMORROW)).toBe(false);
  });
  it('every line’s leg must still be in time: one passed leg closes the whole request', () => {
    const legs = [leg({ id: 'leg-1', travelDate: YESTERDAY }), leg({ id: 'leg-2', seq: 2, travelDate: TOMORROW })];
    expect(isAddOnRequestPayable(request('open', ['leg-1', 'leg-2']), { status: 'in_progress' }, legs, TODAY)).toBe(false);
    expect(isAddOnRequestPayable(request('open', ['leg-2']), { status: 'in_progress' }, legs, TODAY)).toBe(true);
  });
  it('is not payable when a line’s leg is no longer among the stored legs', () => {
    expect(isAddOnRequestPayable(request('open', ['leg-gone']), { status: 'confirmed' }, [leg()], TODAY)).toBe(false);
  });
  it('follows the leg when ops moves its date', () => {
    const req = request('open');
    expect(isAddOnRequestPayable(req, { status: 'confirmed' }, [leg({ travelDate: YESTERDAY })], TODAY)).toBe(false);
    expect(isAddOnRequestPayable(req, { status: 'confirmed' }, [leg({ travelDate: TOMORROW })], TODAY)).toBe(true);
  });
});

describe('addOnRequestState (§4.4)', () => {
  const state = (
    status: AddOnRequestStatus, bookingStatus: string, travelDate: string | null, refundedCents = 0,
  ): AddOnRequestState =>
    addOnRequestState(request(status), { status: bookingStatus }, [leg({ travelDate })], TODAY, refundedCents);

  it('open and payable is awaiting_payment', () => {
    expect(state('open', 'confirmed', TOMORROW)).toBe('awaiting_payment');
    expect(state('open', 'completed', TODAY)).toBe('awaiting_payment');
  });
  it('open with the leg’s day passed, or the trip finished, is expired', () => {
    expect(state('open', 'confirmed', YESTERDAY)).toBe('expired');
    expect(state('open', 'completed', null)).toBe('expired');
  });
  it('open on a cancelled, refunded or no-show booking is cancelled_with_booking', () => {
    for (const bookingStatus of ['cancelled', 'refunded', 'no_show']) {
      expect(state('open', bookingStatus, TOMORROW)).toBe('cancelled_with_booking');
      // The booking's end outranks the date: it is not "expired" just because the day also passed.
      expect(state('open', bookingStatus, YESTERDAY)).toBe('cancelled_with_booking');
    }
  });
  it('paid with no refund is paid, whatever happened to the booking or the date since', () => {
    expect(state('paid', 'confirmed', TOMORROW)).toBe('paid');
    expect(state('paid', 'completed', YESTERDAY)).toBe('paid');
    expect(state('paid', 'cancelled', YESTERDAY)).toBe('paid');
  });
  it('paid with confirmed refunds below its amount is part_refunded', () => {
    expect(state('paid', 'confirmed', TOMORROW, 1)).toBe('part_refunded');
    expect(state('paid', 'confirmed', TOMORROW, 999)).toBe('part_refunded');
  });
  it('paid with confirmed refunds equal to its amount is refunded', () => {
    expect(state('paid', 'confirmed', TOMORROW, 1000)).toBe('refunded');
  });
  it('cancelled is cancelled', () => {
    expect(state('cancelled', 'confirmed', TOMORROW)).toBe('cancelled');
    expect(state('cancelled', 'cancelled', YESTERDAY)).toBe('cancelled');
  });
});

describe('order id, idempotency key and label', () => {
  it('names the order after the booking reference and the request’s seq', () => {
    expect(addOnOrderId('CH-NQ66B', 1)).toBe('CH-NQ66B-A1');
    expect(addOnOrderId('CH-NQ66B', 12)).toBe('CH-NQ66B-A12');
  });
  it('keys the payment on the booking and the request', () => {
    expect(addOnIdempotencyKey('b-1', 'r-9')).toBe('checkout:b-1:addon:r-9');
  });
  it('labels a line with the add-on and its leg, the shape a per-leg quote extra has', () => {
    expect(addOnLineLabel('waiting', 'Kandy', 'Ella')).toBe('Waiting fee — Kandy → Ella');
    expect(addOnLineLabel('sightseeing', 'Ella', 'Yala')).toBe('Sightseeing stops (up to 3h) — Ella → Yala');
  });
});

describe('addOnCatalogue (§4.2)', () => {
  it('lists every private add-on on the card with its label and price', () => {
    expect(addOnCatalogue(RATE_CARD.extras)).toEqual([
      { code: 'sightseeing', label: 'Sightseeing stops (up to 3h)', priceCents: 1000 },
      { code: 'safari-wait', label: 'Wait for Safari', priceCents: 1900 },
      { code: 'luggage', label: 'Luggage rack', priceCents: 500 },
      { code: 'front', label: 'Child seat', priceCents: 800 },
      { code: 'flex', label: 'Flexi ticket', priceCents: 1200 },
      { code: 'waiting', label: 'Waiting fee', priceCents: 1000 },
    ]);
  });
  it('leaves out the shared-only hotel pick-up and drop-off', () => {
    const codes = addOnCatalogue(RATE_CARD.extras).map((a) => a.code);
    expect(codes).not.toContain('hotel-pickup');
    expect(codes).not.toContain('hotel-dropoff');
  });
  it('prices from the card it is given, so a founder’s revision shows', () => {
    const revised = { ...RATE_CARD.extras, waiting: 1500 };
    expect(addOnCatalogue(revised).find((a) => a.code === 'waiting')?.priceCents).toBe(1500);
  });
  it('leaves out an add-on the card has no price for: a line must cost something', () => {
    const withoutWaiting = Object.fromEntries(Object.entries(RATE_CARD.extras).filter(([code]) => code !== 'waiting'));
    expect(addOnCatalogue(withoutWaiting).map((a) => a.code)).not.toContain('waiting');
    expect(addOnCatalogue({ ...RATE_CARD.extras, flex: 0 }).map((a) => a.code)).not.toContain('flex');
  });
});
