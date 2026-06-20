import { describe, it, expect } from 'vitest';
import { InMemoryDepartureRepo, type Corridor } from './departureRepo';

describe('InMemoryDepartureRepo', () => {
  it('exposes seeded corridors', async () => {
    const repo = new InMemoryDepartureRepo();
    expect((await repo.getCorridor('hill-line'))?.toPlace).toBe('Ella');
    expect(await repo.getCorridor('nope')).toBeNull();
  });

  it('holds seats and reflects the running total', async () => {
    const repo = new InMemoryDepartureRepo();
    const a = await repo.holdSeats({ corridorId: 'hill-line', date: '2026-07-20', time: '08:00', seats: 2 });
    expect(a?.seatsBooked).toBe(2);
    const b = await repo.holdSeats({ corridorId: 'hill-line', date: '2026-07-20', time: '08:00', seats: 3 });
    expect(b?.seatsBooked).toBe(5);
  });

  it('refuses to oversell a departure (returns null)', async () => {
    const small: Corridor = { id: 'small', fromPlace: 'A', toPlace: 'B', seatPrice: 1000, seatCapacity: 3 };
    const repo = new InMemoryDepartureRepo([small]);
    expect(await repo.holdSeats({ corridorId: 'small', date: 'd', time: 't', seats: 3 })).not.toBeNull();
    expect(await repo.holdSeats({ corridorId: 'small', date: 'd', time: 't', seats: 1 })).toBeNull();
  });

  it('never oversells under concurrent holds (no oversell invariant)', async () => {
    const small: Corridor = { id: 'small', fromPlace: 'A', toPlace: 'B', seatPrice: 1000, seatCapacity: 5 };
    const repo = new InMemoryDepartureRepo([small]);
    const attempts = Array.from({ length: 20 }, () =>
      repo.holdSeats({ corridorId: 'small', date: 'd', time: 't', seats: 1 }),
    );
    const results = await Promise.all(attempts);
    const held = results.filter((r) => r !== null);
    expect(held).toHaveLength(5); // exactly capacity succeed
    expect(Math.max(...held.map((r) => r!.seatsBooked))).toBe(5); // never exceeds total
  });
});
