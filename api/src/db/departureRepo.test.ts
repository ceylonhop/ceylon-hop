import { describe, it, expect } from 'vitest';
import { InMemoryDepartureRepo, inventoryTimeFor, serviceDaysForCorridor, sharedRouteLabel, SHARED_PRODUCTS, type Corridor } from './departureRepo';

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

// ── CH-6HE3V (2026-09-21) ──────────────────────────────────────────────────
// A shared booking used to store only its corridorId, so every label rebuilt the
// route from the corridor's end stops and told a CMB → Sigiriya customer they
// were going to Kandy. A corridor is the ROAD, not the offer: since the directed
// catalogue (2026-08-16) one corridor carries several legs at their own prices,
// so its endpoints describe no customer's journey.
describe('sharedRouteLabel', () => {
  it('names the leg the booking recorded', () => {
    expect(
      sharedRouteLabel({
        corridorId: 'airport-cultural',
        fromPlace: 'Colombo Airport (CMB)',
        toPlace: 'Sigiriya / Dambulla',
      }),
    ).toEqual({ kind: 'leg', from: 'Colombo Airport (CMB)', to: 'Sigiriya / Dambulla' });
  });

  // Corridor ends stay useful context for ops, but they are the SERVICE. Callers
  // get a different `kind` so they cannot render them as a traveller's route.
  it('marks corridor ends as the service when no leg was recorded', () => {
    expect(sharedRouteLabel({ corridorId: 'airport-cultural' })).toEqual({
      kind: 'service',
      from: 'Colombo Airport (CMB)',
      to: 'Kandy',
    });
  });

  it('will not guess from half a leg', () => {
    expect(sharedRouteLabel({ corridorId: 'airport-cultural', fromPlace: 'Negombo', toPlace: null })?.kind).toBe('service');
  });

  it('is null for a corridor outside the catalogue, so callers keep their own wording', () => {
    expect(sharedRouteLabel({ corridorId: 'cmb-galle' })).toBeNull();
  });
});

// Seat inventory is the VAN, not the stop. A leg's `inventoryTime` names the load it rides, so
// two pickups on one van share a pool of 12 and a genuinely later load keeps its own.
describe('inventoryTimeFor', () => {
  it('sends both pickups of one load to the same pool', () => {
    // CMB 07:00 → Negombo 07:30: one van, still filling up.
    expect(inventoryTimeFor('airport-cultural', '07:00')).toBe('07:00');
    expect(inventoryTimeFor('airport-cultural', '07:30')).toBe('07:00');
    // Mirissa 14:45 → Weligama 15:00: the southbound twin.
    expect(inventoryTimeFor('south-airport', '14:45')).toBe('14:45');
    expect(inventoryTimeFor('south-airport', '15:00')).toBe('14:45');
  });

  it('leaves a later load on its own pool', () => {
    // Sigiriya boards at 11:30 on the van that left CMB at 07:00 — the morning lot have got
    // out, so merging these would refuse seats we can actually sell.
    expect(inventoryTimeFor('airport-cultural', '11:30')).toBe('11:30');
  });

  it('resolves a booking’s stored time, padding and all', () => {
    expect(inventoryTimeFor('airport-cultural', '07:30 ')).toBe('07:00');
  });

  it('gives an unpublished time its own pool rather than someone else’s van', () => {
    expect(inventoryTimeFor('airport-cultural', '21:15')).toBe('21:15');
    expect(inventoryTimeFor('made-up', '07:30')).toBe('07:30');
  });

  // The release paths resolve a pool from (corridor, stored time) alone, so that pair has to
  // land on ONE answer — otherwise a cancel could hand seats back to the wrong van.
  it('the catalogue cannot make a (corridor, time) pair ambiguous', () => {
    const seen = new Map<string, string>();
    for (const p of SHARED_PRODUCTS) {
      const key = `${p.corridorId}|${p.time}`;
      const prior = seen.get(key);
      if (prior !== undefined) expect(prior).toBe(p.inventoryTime);
      seen.set(key, p.inventoryTime);
    }
  });

  // A load is named by the time it STARTS boarding, so every inventoryTime is itself a
  // published boarding time on that corridor, and never later than the leg that rides it.
  it('every leg rides a load that exists and has already started boarding', () => {
    for (const p of SHARED_PRODUCTS) {
      const load = SHARED_PRODUCTS.find(
        (q) => q.corridorId === p.corridorId && q.time === p.inventoryTime,
      );
      expect(load, `${p.corridorId} ${p.fromPlace} → no load at ${p.inventoryTime}`).toBeDefined();
      expect(p.inventoryTime <= p.time).toBe(true);
    }
  });
});
