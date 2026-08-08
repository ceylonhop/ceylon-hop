import { describe, expect, it } from 'vitest';
import { deriveLegsForMode, deriveSingleLegs, deriveTripLegs, isUsablePlace } from './bookingLegs';

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

  // No dates anywhere means the "blank = chainStops() connector" convention doesn't apply — see
  // the comment on chauffeurDays(). Every segment must still be an askable journey, so this falls
  // back to one `day` row per segment rather than reading every segment as a gap.
  it('falls back to one askable day per segment when a chauffeur trip has no dates at all', () => {
    const legs = deriveTripLegs({ stops: ['A', 'B', 'C'], serviceType: 'chauffeur' });
    expect(legs.map((l) => [l.kind, l.fromPlace, l.toPlace, l.travelDate])).toEqual([
      ['day', 'A', 'B', null],
      ['day', 'B', 'C', null],
    ]);
  });

  // Finding 4: the "does this trip have any dates at all" guard used to test the WHOLE dates
  // array, including entries past the last real segment (a 3-stop trip has only 2 segments, so
  // dates[2] is never a segment's date). A trailing date there made the guard think the trip was
  // dated, so the empty segment dates fell through to "blank = gap" instead of the no-dates
  // fallback — two gaps, zero journeys, for a trip that in fact has no per-segment dates at all.
  it('falls back to askable days when only a trailing, out-of-range date entry is present', () => {
    const legs = deriveTripLegs({
      stops: ['A', 'B', 'C'],
      dates: ['', '', '2026-08-22'],
      serviceType: 'chauffeur',
    });
    expect(legs.map((l) => [l.kind, l.fromPlace, l.toPlace, l.travelDate])).toEqual([
      ['day', 'A', 'B', null],
      ['day', 'B', 'C', null],
    ]);
  });

  // Mixed case is unchanged: as soon as the trip has a date anywhere, a blank date on another
  // segment still reads as chainStops()'s connector, not as "no dates yet".
  it('still treats a blank date as a gap when some other segment IS dated', () => {
    const legs = deriveTripLegs({
      stops: ['A', 'B', 'C'],
      dates: ['', '2026-08-23'],
      serviceType: 'chauffeur',
    });
    expect(legs.map((l) => [l.kind, l.fromPlace, l.toPlace, l.travelDate])).toEqual([
      ['gap', 'A', 'B', null],
      ['day', 'B', 'C', '2026-08-23'],
    ]);
  });
});

// Finding 2: legRowsForBooking (postgresBookingRepo.ts) and planBackfill
// (backfill-booking-legs.ts) both used to independently decide what 'single'/'trip'/'shared'
// mean. This is the one dispatch both now call.
describe('deriveLegsForMode', () => {
  it('derives a single leg for mode "single" when the single input is present', () => {
    const legs = deriveLegsForMode('single', { single: { from: 'Ella', to: 'Kandy' } });
    expect(legs).toHaveLength(1);
    expect(legs?.[0].fromPlace).toBe('Ella');
  });

  it('returns no legs for mode "single" with no single input, rather than throwing', () => {
    expect(deriveLegsForMode('single', {})).toEqual([]);
  });

  it('derives trip legs for mode "trip" when the trip input is present', () => {
    const legs = deriveLegsForMode('trip', {
      trip: { stops: ['A', 'B', 'C'], serviceType: 'private' },
    });
    expect(legs).toHaveLength(2);
  });

  it('returns no legs for mode "trip" with no trip input, rather than throwing', () => {
    expect(deriveLegsForMode('trip', {})).toEqual([]);
  });

  it('returns no legs for mode "shared" — a corridor is not a journey with editable ends', () => {
    expect(deriveLegsForMode('shared', {})).toEqual([]);
  });

  it('returns undefined for any mode that is not single/trip/shared, so the caller can report it', () => {
    expect(deriveLegsForMode('gift-card', {})).toBeUndefined();
  });
});

describe('isUsablePlace', () => {
  it('accepts a non-empty string and rejects null, undefined and empty string', () => {
    expect(isUsablePlace('Kandy')).toBe(true);
    expect(isUsablePlace(null)).toBe(false);
    expect(isUsablePlace(undefined)).toBe(false);
    expect(isUsablePlace('')).toBe(false);
  });
});

// Findings 1 & 2: legRowsForBooking (postgresBookingRepo.ts) used to filter malformed
// fromPlace/toPlace itself, and nothing filtered viaStops at all — a null MIDDLE stop on a
// chauffeur day whose neighbouring segments share a date passed straight through, endpoints
// intact, and drizzle serialised the null element as the literal string "NULL". planBackfill
// never filtered anything, so the same malformed trip produced partial legs at booking time and
// zero legs (an insert_failed skip) at backfill — contradicting the header comment above, which
// claims the two "can never disagree". Filtering now lives here, in deriveLegsForMode, the one
// dispatch both legRowsForBooking and planBackfill call, so both get identical behaviour.
describe('deriveLegsForMode — usable-place filtering', () => {
  it('drops a leg whose place is null, and one whose place is empty, without throwing', () => {
    const stops = ['Galle', null as unknown as string, 'Kandy', ''] as string[];
    expect(() =>
      deriveLegsForMode('trip', { trip: { stops, serviceType: 'private' } }),
    ).not.toThrow();
    const legs = deriveLegsForMode('trip', { trip: { stops, serviceType: 'private' } });
    // Galle→null, null→Kandy, and Kandy→'' are all malformed and must not become rows.
    expect(legs).toEqual([]);
  });

  it('keeps the well-formed legs either side of a malformed stop', () => {
    // A B-C-D-E trip where C is null: A→B is fine, B→C and C→D are dropped, D→E is fine.
    const stops = ['A', 'B', null as unknown as string, 'D', 'E'] as string[];
    const legs = deriveLegsForMode('trip', { trip: { stops, serviceType: 'private' } });
    expect(legs?.map((l) => [l.fromPlace, l.toPlace])).toEqual([
      ['A', 'B'],
      ['D', 'E'],
    ]);
  });

  // Finding 1's central case: a chauffeur trip whose MIDDLE stop is null, with the neighbouring
  // segments sharing a date, collapses into one `day` row whose endpoints are both fine — the
  // endpoint filter alone would let it through carrying viaStops: [null], which drizzle would
  // serialise as the literal string "NULL". A null middle stop must never reach viaStops.
  it('strips a null middle stop from viaStops without dropping the day row', () => {
    const stops = ['Colombo', null as unknown as string, 'Kandy'];
    const legs = deriveLegsForMode('trip', {
      trip: { stops, dates: ['2026-08-22', '2026-08-22'], serviceType: 'chauffeur' },
    });
    expect(legs).toHaveLength(1);
    expect(legs?.[0]).toMatchObject({ fromPlace: 'Colombo', toPlace: 'Kandy', kind: 'day' });
    expect(legs?.[0].viaStops).toEqual([]);
  });

  it('strips an empty-string middle stop from viaStops the same way', () => {
    const stops = ['Colombo', 'Pinnawala', '', 'Kandy'];
    const legs = deriveLegsForMode('trip', {
      trip: { stops, dates: ['2026-08-22', '2026-08-22', '2026-08-22'], serviceType: 'chauffeur' },
    });
    expect(legs).toHaveLength(1);
    expect(legs?.[0].viaStops).toEqual(['Pinnawala']);
  });

  it('filters a single leg with a malformed endpoint', () => {
    expect(deriveLegsForMode('single', { single: { from: '', to: 'Kandy' } })).toEqual([]);
    expect(
      deriveLegsForMode('single', { single: { from: null as unknown as string, to: 'Kandy' } }),
    ).toEqual([]);
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
