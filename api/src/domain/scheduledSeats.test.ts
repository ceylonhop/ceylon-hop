import { describe, it, expect } from 'vitest';
import { scheduledSeatCounts } from './scheduledSeats';

describe('scheduledSeatCounts — paid seats per van, keyed by each leg it boards', () => {
  it('pools legs that ride one van: CMB 07:00 and Negombo 07:30 both show the van total', () => {
    expect(scheduledSeatCounts([
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:00', seats: 3 },
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:30', seats: 2 },
    ])).toEqual([
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:00', booked: 5 },
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:30', booked: 5 },
    ]);
  });
  it('keeps Sigiriya → Kandy on its own van', () => {
    const out = scheduledSeatCounts([
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:00', seats: 3 },
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '11:30', seats: 1 },
    ]);
    expect(out).toContainEqual({ corridorId: 'airport-cultural', date: '2099-08-12', time: '07:00', booked: 3 });
    expect(out).toContainEqual({ corridorId: 'airport-cultural', date: '2099-08-12', time: '11:30', booked: 1 });
  });
  it('gives two legs boarding at the same time one entry', () => {
    expect(scheduledSeatCounts([{ corridorId: 'ella-south', date: '2099-08-15', time: '09:00', seats: 4 }]))
      .toEqual([{ corridorId: 'ella-south', date: '2099-08-15', time: '09:00', booked: 4 }]);
  });
  it('keeps dates apart', () => {
    expect(scheduledSeatCounts([
      { corridorId: 'ella-east', date: '2099-08-12', time: '09:00', seats: 2 },
      { corridorId: 'ella-east', date: '2099-08-15', time: '09:00', seats: 3 },
    ])).toEqual([
      { corridorId: 'ella-east', date: '2099-08-12', time: '09:00', booked: 2 },
      { corridorId: 'ella-east', date: '2099-08-15', time: '09:00', booked: 3 },
    ]);
  });
});
