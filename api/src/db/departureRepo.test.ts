import { describe, it, expect } from 'vitest';
import { InMemoryDepartureRepo, serviceDaysForCorridor, type Corridor } from './departureRepo';

describe('InMemoryDepartureRepo', () => {
  it('exposes seeded corridors', async () => {
    const repo = new InMemoryDepartureRepo();
    expect((await repo.getCorridor('hill-line'))?.toPlace).toBe('Ella');
    expect(await repo.getCorridor('nope')).toBeNull();
  });

  it('seeded corridors carry the shared service weekdays (Wed & Sat)', async () => {
    const repo = new InMemoryDepartureRepo();
    const c = await repo.getCorridor('hill-line');
    expect(c?.serviceDays).toEqual([3, 6]);
    // every corridor currently runs the same fixed weekly schedule
    for (const id of ['airport-cultural', 'ella-east', 'south-coast', 'yala-south', 'ella-south']) {
      expect((await repo.getCorridor(id))?.serviceDays).toEqual([3, 6]);
    }
  });

  it('holds seats and reflects the running total', async () => {
    const repo = new InMemoryDepartureRepo();
    const a = await repo.holdSeats({ corridorId: 'hill-line', date: '2026-07-20', time: '08:00', seats: 2 });
    expect(a?.seatsBooked).toBe(2);
    const b = await repo.holdSeats({ corridorId: 'hill-line', date: '2026-07-20', time: '08:00', seats: 3 });
    expect(b?.seatsBooked).toBe(5);
  });

  it('refuses to oversell a departure (returns null)', async () => {
    const small: Corridor = { id: 'small', fromPlace: 'A', toPlace: 'B', seatPrice: 1000, seatCapacity: 3, serviceDays: [3, 6] };
    const repo = new InMemoryDepartureRepo([small]);
    expect(await repo.holdSeats({ corridorId: 'small', date: 'd', time: 't', seats: 3 })).not.toBeNull();
    expect(await repo.holdSeats({ corridorId: 'small', date: 'd', time: 't', seats: 1 })).toBeNull();
  });

  it('never oversells under concurrent holds (no oversell invariant)', async () => {
    const small: Corridor = { id: 'small', fromPlace: 'A', toPlace: 'B', seatPrice: 1000, seatCapacity: 5, serviceDays: [3, 6] };
    const repo = new InMemoryDepartureRepo([small]);
    const attempts = Array.from({ length: 20 }, () =>
      repo.holdSeats({ corridorId: 'small', date: 'd', time: 't', seats: 1 }),
    );
    const results = await Promise.all(attempts);
    const held = results.filter((r) => r !== null);
    expect(held).toHaveLength(5); // exactly capacity succeed
    expect(Math.max(...held.map((r) => r!.seatsBooked))).toBe(5); // never exceeds total
  });

  it('releases held seats so they can be booked again (GL-3)', async () => {
    const repo = new InMemoryDepartureRepo();
    await repo.holdSeats({ corridorId: 'hill-line', date: '2026-07-20', time: '08:00', seats: 5 });
    await repo.releaseSeats({ corridorId: 'hill-line', date: '2026-07-20', time: '08:00', seats: 2 });
    const next = await repo.holdSeats({ corridorId: 'hill-line', date: '2026-07-20', time: '08:00', seats: 1 });
    expect(next?.seatsBooked).toBe(4); // 5 − 2 released + 1
  });

  it('floors a release at zero and ignores an unknown departure', async () => {
    const repo = new InMemoryDepartureRepo();
    await repo.holdSeats({ corridorId: 'hill-line', date: '2026-07-20', time: '08:00', seats: 3 });
    await repo.releaseSeats({ corridorId: 'hill-line', date: '2026-07-20', time: '08:00', seats: 10 });
    const next = await repo.holdSeats({ corridorId: 'hill-line', date: '2026-07-20', time: '08:00', seats: 1 });
    expect(next?.seatsBooked).toBe(1); // floored at 0, not negative
    // releasing on a departure that was never held must be a harmless no-op
    await expect(
      repo.releaseSeats({ corridorId: 'hill-line', date: '2099-01-01', time: '08:00', seats: 1 }),
    ).resolves.toBeUndefined();
  });
});

describe('serviceDaysForCorridor', () => {
  it('returns a corridor’s service weekdays from the catalogue', () => {
    expect(serviceDaysForCorridor('hill-line')).toEqual([3, 6]);
  });
  it('falls back to the standard shared schedule for an unknown corridor', () => {
    expect(serviceDaysForCorridor('made-up')).toEqual([3, 6]);
  });
});
