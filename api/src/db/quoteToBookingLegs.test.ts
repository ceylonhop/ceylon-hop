import { describe, expect, it } from 'vitest';
import { legRowsForBooking } from './postgresBookingRepo';
import { quoteToBooking, type BookingDetails } from '../quote/quoteToBooking';
import type { SavedQuote } from './quoteRepo';
import type { NewBooking } from './bookingRepo';

// Was postgresQuoteConversionRepo.legs.test.ts, but it never called quoteToBooking or the
// conversion repo — it hand-wrote fixtures shaped like quoteToBooking's output and asserted
// against legRowsForBooking directly, so a real drift between the two would not have been
// caught. This file runs the actual pay-link path — quoteToBooking(...) → legRowsForBooking(...)
// — so "quote-born bookings derive the same legs a website booking would" is genuinely tested.
const bookingId = '00000000-0000-4000-8000-000000000002';

const CUST = { firstName: 'A', lastName: 'B', email: 'a@b.com', whatsapp: '+94123456', country: 'LK' };

// Minimal SavedQuote for mapping — only request.engine matters to quoteToBooking.
function q(engine: unknown): SavedQuote {
  return {
    id: 'q1',
    reference: 'Q-1',
    channel: 'ops',
    status: 'sent',
    totalCents: 21900,
    currency: 'USD',
    request: { engine },
    result: {},
    convertedBookingId: null,
  } as unknown as SavedQuote;
}

// Wrap a mapped booking (as quotePay.ts does) into a full NewBooking for legRowsForBooking.
function toNewBooking(mapped: ReturnType<typeof quoteToBooking>): NewBooking {
  return mapped.mode === 'single'
    ? { mode: 'single', input: mapped.input, total: 21900, amountDueNow: 21900, currency: 'USD' }
    : { mode: 'trip', input: mapped.input, total: 21900, amountDueNow: 21900, currency: 'USD' };
}

describe('quote-born bookings derive the same legs (via the real quoteToBooking mapping)', () => {
  it('single transfer with no date or time still gets its leg', () => {
    const details: BookingDetails = { customer: CUST, vehicleType: 'car', pax: 2, bags: 1 };
    const mapped = quoteToBooking(
      q({ product: 'private', vehicle: 'car', pax: 2, bags: 1, legs: [{ from: 'Hiriketiya Beach', to: 'Negombo', distanceKm: 100 }] }),
      details,
    );
    const rows = legRowsForBooking(bookingId, toNewBooking(mapped));
    expect(rows).toHaveLength(1);
    expect(rows[0].travelDate).toBeNull();
    expect(rows[0].pickupTime).toBeNull();
  });

  it('a chauffeur trip with a gap keeps the connector out of the travel days', () => {
    const details: BookingDetails = { customer: CUST, vehicleType: 'van', pax: 2, bags: 1 };
    const mapped = quoteToBooking(
      q({
        product: 'chauffeur',
        vehicle: 'van',
        firstDate: '2026-08-22',
        lastDate: '2026-08-25',
        travelDays: [
          { date: '2026-08-22', from: 'Colombo', to: 'Kandy', distanceKm: 120 },
          { date: '2026-08-25', from: 'Galle', to: 'Mirissa', distanceKm: 40 },
        ],
      }),
      details,
    );
    const rows = legRowsForBooking(bookingId, toNewBooking(mapped));
    expect(rows.map((r) => r.kind)).toEqual(['day', 'gap', 'day']);
  });
});
