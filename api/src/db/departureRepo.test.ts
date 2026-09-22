import { describe, it, expect } from 'vitest';
import {
  InMemoryDepartureRepo,
  serviceDaysForCorridor,
  sharedRouteLabel,
  departureKeyFor,
  SHARED_PRODUCTS,
  type Corridor,
} from './departureRepo';

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

// ── CH-SEATS (2026-09-22) ──────────────────────────────────────────────────
// Seat inventory keys on (corridor, date, time), and a leg's `time` is when it BOARDS —
// which is not the same thing as which van it rides. CMB -> Sigiriya boards 07:00 and
// Negombo -> Sigiriya boards 07:30, but they are aboard TOGETHER between Negombo and
// Sigiriya, so each opening its own full 12-seat pool sold that one van twice over.
//
// Legs pool when the stretches of road they occupy overlap. Sigiriya -> Kandy boards at
// 11:30, after the northbound passengers have got out, so it shares no road with them and
// correctly keeps its own seats — that separation is deliberate and must stay.
describe('departureKeyFor', () => {
  it('pools the two legs that ride the airport run together', () => {
    expect(departureKeyFor('airport-cultural', '07:30')).toBe(
      departureKeyFor('airport-cultural', '07:00'),
    );
  });

  it('keeps Sigiriya -> Kandy on its own pool — the van emptied at Sigiriya', () => {
    expect(departureKeyFor('airport-cultural', '11:30')).not.toBe(
      departureKeyFor('airport-cultural', '07:00'),
    );
  });

  it('pools Mirissa and Weligama onto the one southbound airport van', () => {
    expect(departureKeyFor('south-airport', '15:00')).toBe(
      departureKeyFor('south-airport', '14:45'),
    );
  });

  // Different corridors are different vehicles on different roads: Ella -> Yala and
  // Ella -> Ahangama both board Ella at 09:00 and must NOT share seats. The key is a pool
  // name WITHIN a corridor — both are called '09:00' — so assert the seats, not the name.
  it('never pools across corridors, even at the same place and time', async () => {
    const repo = new InMemoryDepartureRepo();
    const east = await repo.holdSeats({ corridorId: 'ella-east', date: '2026-07-22', time: '09:00', seats: 12 });
    expect(east?.seatsBooked).toBe(12); // that van is full
    const south = await repo.holdSeats({ corridorId: 'ella-south', date: '2026-07-22', time: '09:00', seats: 12 });
    expect(south?.seatsBooked).toBe(12); // a different van, with all its seats
  });

  it('trims, so a padded time resolves to the same pool', () => {
    expect(departureKeyFor('airport-cultural', ' 07:30 ')).toBe(
      departureKeyFor('airport-cultural', '07:30'),
    );
  });

  // Corridors with no catalogue product (and direct repo callers) keep per-time inventory.
  it('passes an uncatalogued time straight through', () => {
    expect(departureKeyFor('hill-line', '08:00')).toBe('08:00');
    expect(departureKeyFor('made-up', 't')).toBe('t');
  });

  // The pool key is derived from stop order, so adding a leg cannot silently miss it. This
  // guards the one shape that derivation cannot resolve: one boarding time on a corridor
  // that would belong to two different pools.
  it('gives every catalogue leg exactly one pool for its boarding time', () => {
    const seen = new Map<string, string>();
    for (const p of SHARED_PRODUCTS) {
      const k = `${p.corridorId}|${p.time}`;
      const pool = departureKeyFor(p.corridorId, p.time);
      const prev = seen.get(k);
      if (prev !== undefined) expect(pool).toBe(prev);
      seen.set(k, pool);
    }
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
