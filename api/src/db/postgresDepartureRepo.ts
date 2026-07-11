import type { Sql } from './client';
import {
  type DepartureRepo,
  type Corridor,
  type SharedDeparture,
  DEFAULT_CORRIDORS,
  corridorIdForRoute,
  serviceDaysForCorridor,
} from './departureRepo';

// Idempotently upsert the corridor catalogue (run at server start + in tests).
export async function seedCorridors(sql: Sql): Promise<void> {
  for (const c of DEFAULT_CORRIDORS) {
    await sql`
      insert into corridor (id, from_place, to_place, seat_price, seat_capacity)
      values (${c.id}, ${c.fromPlace}, ${c.toPlace}, ${c.seatPrice}, ${c.seatCapacity})
      on conflict (id) do update set
        from_place = excluded.from_place,
        to_place = excluded.to_place,
        seat_price = excluded.seat_price,
        seat_capacity = excluded.seat_capacity`;
  }
}

export class PostgresDepartureRepo implements DepartureRepo {
  constructor(private readonly sql: Sql) {}

  async getCorridor(id: string): Promise<Corridor | null> {
    const rows = await this.sql<
      { id: string; from_place: string; to_place: string; seat_price: number; seat_capacity: number }[]
    >`select id, from_place, to_place, seat_price, seat_capacity from corridor where id = ${id}`;
    const r = rows[0];
    // `service_days` isn't a DB column — the schedule lives in the code catalogue, like the
    // corridor's intermediate stops. Merge it in by id so callers get a complete Corridor.
    return r
      ? {
          id: r.id,
          fromPlace: r.from_place,
          toPlace: r.to_place,
          seatPrice: r.seat_price,
          seatCapacity: r.seat_capacity,
          serviceDays: serviceDaysForCorridor(r.id),
        }
      : null;
  }

  async findCorridorByRoute(from: string, to: string): Promise<Corridor | null> {
    // The corridor catalogue (with intermediate stops) lives in code; the DB only stores
    // each corridor's endpoints. Resolve the corridor id from the stops, then read its row.
    const id = corridorIdForRoute(from, to);
    return id ? this.getCorridor(id) : null;
  }

  async holdSeats(args: {
    corridorId: string;
    date: string;
    time: string;
    seats: number;
  }): Promise<SharedDeparture | null> {
    const corridor = await this.getCorridor(args.corridorId);
    if (!corridor) return null;

    // Ensure the departure row exists (no-op if a concurrent caller created it).
    await this.sql`
      insert into shared_departure (corridor_id, date, time, seats_total, seats_booked)
      values (${args.corridorId}, ${args.date}, ${args.time}, ${corridor.seatCapacity}, 0)
      on conflict (corridor_id, date, time) do nothing`;

    // Atomic hold: the WHERE guard + row lock means concurrent holds can never oversell.
    const rows = await this.sql<
      { id: string; corridor_id: string; date: string; time: string; seats_total: number; seats_booked: number }[]
    >`
      update shared_departure
      set seats_booked = seats_booked + ${args.seats}
      where corridor_id = ${args.corridorId} and date = ${args.date} and time = ${args.time}
        and seats_booked + ${args.seats} <= seats_total
      returning id, corridor_id, date, time, seats_total, seats_booked`;
    const r = rows[0];
    return r
      ? {
          id: r.id,
          corridorId: r.corridor_id,
          date: r.date,
          time: r.time,
          seatsTotal: r.seats_total,
          seatsBooked: r.seats_booked,
        }
      : null;
  }

  async releaseSeats(args: {
    corridorId: string;
    date: string;
    time: string;
    seats: number;
  }): Promise<void> {
    // Same row-targeting as holdSeats; greatest() floors at 0 so a stray double release
    // can never drive the count negative. No row (never held) is a harmless no-op.
    await this.sql`
      update shared_departure
      set seats_booked = greatest(seats_booked - ${args.seats}, 0)
      where corridor_id = ${args.corridorId} and date = ${args.date} and time = ${args.time}`;
  }
}
