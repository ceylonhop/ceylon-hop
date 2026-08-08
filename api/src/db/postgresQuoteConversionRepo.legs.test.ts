import { describe, expect, it } from 'vitest';
import { legRowsForBooking } from './postgresBookingRepo';

// The pay-link path is the one this whole feature exists for: a quote-born booking has no exact
// spot and no time. It must produce the same legs a website booking of the same shape would.
describe('quote-born bookings derive the same legs', () => {
  const bookingId = '00000000-0000-4000-8000-000000000002';

  it('single transfer with no date or time still gets its leg', () => {
    const rows = legRowsForBooking(bookingId, {
      mode: 'single',
      input: { from: 'Hiriketiya Beach', to: 'Negombo' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].travelDate).toBeNull();
    expect(rows[0].pickupTime).toBeNull();
  });

  it('a chauffeur trip with a gap keeps the connector out of the travel days', () => {
    const rows = legRowsForBooking(bookingId, {
      mode: 'trip',
      input: {
        stops: ['Colombo', 'Kandy', 'Galle', 'Mirissa'],
        dates: ['2026-08-22', '', '2026-08-25'],
        serviceType: 'chauffeur',
      },
    });
    expect(rows.map((r) => r.kind)).toEqual(['day', 'gap', 'day']);
  });
});
