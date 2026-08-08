import { describe, expect, it } from 'vitest';
import { deriveSingleLegs, deriveTripLegs } from './bookingLegs';

describe('deriveSingleLegs', () => {
  it('produces exactly one leg carrying the date and time', () => {
    expect(
      deriveSingleLegs({ from: 'Hiriketiya Beach', to: 'Negombo', date: '2026-08-22', time: '08:00' }),
    ).toEqual([
      {
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

  it('leaves date and time null when the customer chose "decide later"', () => {
    const [leg] = deriveSingleLegs({ from: 'Ella', to: 'Kandy' });
    expect(leg.travelDate).toBeNull();
    expect(leg.pickupTime).toBeNull();
  });
});

describe('deriveTripLegs — private', () => {
  it('makes one leg per consecutive pair, dates aligned by index', () => {
    const legs = deriveTripLegs({
      stops: ['Hiriketiya Beach', 'Ella', 'Kandy', 'Negombo'],
      dates: ['2026-08-22', '2026-08-25', '2026-08-27'],
      serviceType: 'private',
    });
    expect(legs.map((l) => [l.seq, l.kind, l.fromPlace, l.toPlace, l.travelDate])).toEqual([
      [1, 'leg', 'Hiriketiya Beach', 'Ella', '2026-08-22'],
      [2, 'leg', 'Ella', 'Kandy', '2026-08-25'],
      [3, 'leg', 'Kandy', 'Negombo', '2026-08-27'],
    ]);
    expect(legs.every((l) => l.viaStops.length === 0)).toBe(true);
  });

  it('keeps the legs when the trip has no dates yet', () => {
    const legs = deriveTripLegs({ stops: ['Galle', 'Mirissa', 'Ella'], serviceType: 'private' });
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.travelDate === null)).toBe(true);
  });
});

describe('deriveTripLegs — chauffeur', () => {
  // quoteToBooking.ts:170 stores ONE DATE PER SEGMENT, so consecutive segments sharing a date
  // are one travel day. A day with three stops owns two segments.
  it('groups consecutive segments that share a date into one travel day', () => {
    const legs = deriveTripLegs({
      stops: ['Colombo', 'Pinnawala', 'Kandy', 'Ella'],
      dates: ['2026-08-22', '2026-08-22', '2026-08-23'],
      serviceType: 'chauffeur',
    });
    expect(legs).toEqual([
      {
        seq: 1,
        kind: 'day',
        fromPlace: 'Colombo',
        toPlace: 'Kandy',
        viaStops: ['Pinnawala'],
        travelDate: '2026-08-22',
        pickupTime: null,
      },
      {
        seq: 2,
        kind: 'day',
        fromPlace: 'Kandy',
        toPlace: 'Ella',
        viaStops: [],
        travelDate: '2026-08-23',
        pickupTime: null,
      },
    ]);
  });

  // chainStops (quoteToBooking.ts:46) pushes a stop we do NOT drive to as a gap; its date is ''.
  it('marks a blank-dated connector as a gap and never merges it into a day', () => {
    const legs = deriveTripLegs({
      stops: ['Colombo', 'Kandy', 'Galle', 'Mirissa'],
      dates: ['2026-08-22', '', '2026-08-25'],
      serviceType: 'chauffeur',
    });
    expect(legs.map((l) => [l.kind, l.fromPlace, l.toPlace, l.travelDate])).toEqual([
      ['day', 'Colombo', 'Kandy', '2026-08-22'],
      ['gap', 'Kandy', 'Galle', null],
      ['day', 'Galle', 'Mirissa', '2026-08-25'],
    ]);
  });

  it('does not merge two separate days that happen to be adjacent', () => {
    const legs = deriveTripLegs({
      stops: ['A', 'B', 'C'],
      dates: ['2026-08-22', '2026-08-23'],
      serviceType: 'chauffeur',
    });
    expect(legs).toHaveLength(2);
    expect(legs.map((l) => l.travelDate)).toEqual(['2026-08-22', '2026-08-23']);
  });

  it('falls back to one row per segment when a chauffeur trip has no dates at all', () => {
    const legs = deriveTripLegs({ stops: ['A', 'B', 'C'], serviceType: 'chauffeur' });
    expect(legs.map((l) => l.kind)).toEqual(['gap', 'gap']);
  });
});

describe('deriveTripLegs — defensive', () => {
  it('returns no legs for a stops array too short to contain a journey', () => {
    expect(deriveTripLegs({ stops: ['Ella'], serviceType: 'private' })).toEqual([]);
    expect(deriveTripLegs({ stops: [], serviceType: 'private' })).toEqual([]);
  });

  it('tolerates a dates array shorter than the segment count', () => {
    const legs = deriveTripLegs({
      stops: ['A', 'B', 'C'],
      dates: ['2026-08-22'],
      serviceType: 'private',
    });
    expect(legs.map((l) => l.travelDate)).toEqual(['2026-08-22', null]);
  });
});
