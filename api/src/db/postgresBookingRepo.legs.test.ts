import { describe, expect, it } from 'vitest';
import { legRowsForBooking } from './postgresBookingRepo';

describe('legRowsForBooking', () => {
  const bookingId = '00000000-0000-4000-8000-000000000001';

  it('maps a single transfer to one leg row carrying its date and time', () => {
    const rows = legRowsForBooking(bookingId, {
      mode: 'single',
      input: { from: 'Hiriketiya Beach', to: 'Negombo', date: '2026-08-22', time: '08:00' },
    });
    expect(rows).toEqual([
      {
        bookingId,
        seq: 1,
        kind: 'leg',
        fromPlace: 'Hiriketiya Beach',
        toPlace: 'Negombo',
        viaStops: [],
        travelDate: '2026-08-22',
        pickupTime: '08:00',
      },
    ]);
  });

  it('maps a private trip to one row per consecutive pair', () => {
    const rows = legRowsForBooking(bookingId, {
      mode: 'trip',
      input: {
        stops: ['Galle', 'Ella', 'Kandy'],
        dates: ['2026-08-22', '2026-08-25'],
        serviceType: 'private',
      },
    });
    expect(rows.map((r) => [r.seq, r.kind, r.fromPlace, r.toPlace])).toEqual([
      [1, 'leg', 'Galle', 'Ella'],
      [2, 'leg', 'Ella', 'Kandy'],
    ]);
  });

  it('maps a chauffeur trip by travel day', () => {
    const rows = legRowsForBooking(bookingId, {
      mode: 'trip',
      input: {
        stops: ['Colombo', 'Pinnawala', 'Kandy'],
        dates: ['2026-08-22', '2026-08-22'],
        serviceType: 'chauffeur',
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('day');
    expect(rows[0].viaStops).toEqual(['Pinnawala']);
  });

  it('produces no rows for a shared seat — a corridor is not a journey with editable ends', () => {
    expect(
      legRowsForBooking(bookingId, {
        mode: 'shared',
        input: { corridorId: 'south-coast', date: '2026-08-22', time: '07:30', seats: 2 },
      }),
    ).toEqual([]);
  });
});
