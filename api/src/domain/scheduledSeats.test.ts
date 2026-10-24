import { describe, it, expect } from 'vitest';
import { scheduledSeatCounts, type ScheduledSeatCount, type SharedSeatCount } from './scheduledSeats';

// One paid booking as the repo reads it. Names default so the pooling tests stay about seats.
const row = (corridorId: string, date: string, time: string, seats: number, firstName = 'Maya', country = 'Spain'): SharedSeatCount =>
  ({ corridorId, date, time, seats, firstName, country });
// The seat counts alone, for the tests about pooling.
const counts = (xs: ScheduledSeatCount[]) => xs.map(({ corridorId, date, time, booked }) => ({ corridorId, date, time, booked }));

describe('scheduledSeatCounts — paid seats per van, keyed by each leg it boards', () => {
  it('pools legs that ride one van: CMB 07:00 and Negombo 07:30 both show the van total', () => {
    const out = scheduledSeatCounts([
      row('airport-cultural', '2099-08-12', '07:00', 3),
      row('airport-cultural', '2099-08-12', '07:30', 2),
    ]);
    expect(counts(out)).toEqual([
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:00', booked: 5 },
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:30', booked: 5 },
    ]);
  });
  it('keeps Sigiriya → Kandy on its own van', () => {
    const out = scheduledSeatCounts([
      row('airport-cultural', '2099-08-12', '07:00', 3),
      row('airport-cultural', '2099-08-12', '11:30', 1),
    ]);
    expect(counts(out)).toContainEqual({ corridorId: 'airport-cultural', date: '2099-08-12', time: '07:00', booked: 3 });
    expect(counts(out)).toContainEqual({ corridorId: 'airport-cultural', date: '2099-08-12', time: '11:30', booked: 1 });
  });
  it('gives two legs boarding at the same time one entry', () => {
    expect(counts(scheduledSeatCounts([row('ella-south', '2099-08-15', '09:00', 4)])))
      .toEqual([{ corridorId: 'ella-south', date: '2099-08-15', time: '09:00', booked: 4 }]);
  });
  it('keeps dates apart', () => {
    expect(counts(scheduledSeatCounts([
      row('ella-east', '2099-08-12', '09:00', 2),
      row('ella-east', '2099-08-15', '09:00', 3),
    ]))).toEqual([
      { corridorId: 'ella-east', date: '2099-08-12', time: '09:00', booked: 2 },
      { corridorId: 'ella-east', date: '2099-08-15', time: '09:00', booked: 3 },
    ]);
  });
});

// The faces on a scheduled row (owner 2026-10-23): who booked the van, as the board's open rides
// show their members — two letters and a flag. Never a full name: the endpoint is public.
describe('scheduledSeatCounts — the people on each van', () => {
  it('lists one face per booking, in booking order, as two capital letters and a country', () => {
    const out = scheduledSeatCounts([
      row('south-airport', '2099-08-12', '14:45', 1, 'maya', 'Spain'),
      row('south-airport', '2099-08-12', '15:00', 2, 'Oliver', 'United Kingdom'),
    ]);
    const people = [{ ini: 'MA', country: 'Spain' }, { ini: 'OL', country: 'United Kingdom' }];
    expect(out).toEqual([
      { corridorId: 'south-airport', date: '2099-08-12', time: '14:45', booked: 3, people },
      { corridorId: 'south-airport', date: '2099-08-12', time: '15:00', booked: 3, people },
    ]);
  });
  it('never carries more of the name than two letters, and survives a blank one', () => {
    const [d] = scheduledSeatCounts([
      row('ella-east', '2099-08-12', '09:00', 1, '  Éloïse Marie ', 'France'),
      row('ella-east', '2099-08-12', '09:00', 1, '   ', 'Germany'),
    ]);
    expect(d.people).toEqual([{ ini: 'ÉL', country: 'France' }, { ini: '', country: 'Germany' }]);
    expect(JSON.stringify(d)).not.toContain('Marie');
  });
});
