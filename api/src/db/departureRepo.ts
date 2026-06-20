import { randomUUID } from 'node:crypto';

export interface Corridor {
  id: string;
  fromPlace: string;
  toPlace: string;
  seatPrice: number; // minor units, per seat
  seatCapacity: number; // default capacity per departure
}

export interface SharedDeparture {
  id: string;
  corridorId: string;
  date: string;
  time: string;
  seatsTotal: number;
  seatsBooked: number;
}

export interface DepartureRepo {
  getCorridor(id: string): Promise<Corridor | null>;
  findCorridorByRoute(from: string, to: string): Promise<Corridor | null>;
  // Find-or-create the departure for (corridor, date, time) and atomically hold `seats`.
  // Returns the updated departure, or null if there aren't enough seats (no oversell).
  holdSeats(args: {
    corridorId: string;
    date: string;
    time: string;
    seats: number;
  }): Promise<SharedDeparture | null>;
}

export const DEFAULT_CORRIDORS: Corridor[] = [
  { id: 'cmb-ella', fromPlace: 'Colombo Airport', toPlace: 'Ella', seatPrice: 3500, seatCapacity: 12 },
  { id: 'cmb-galle', fromPlace: 'Colombo Airport', toPlace: 'Galle', seatPrice: 3000, seatCapacity: 12 },
];

export class InMemoryDepartureRepo implements DepartureRepo {
  private corridors = new Map<string, Corridor>();
  private departures = new Map<string, SharedDeparture>();

  constructor(corridors: Corridor[] = DEFAULT_CORRIDORS) {
    for (const c of corridors) this.corridors.set(c.id, c);
  }

  async getCorridor(id: string): Promise<Corridor | null> {
    return this.corridors.get(id) ?? null;
  }

  async findCorridorByRoute(from: string, to: string): Promise<Corridor | null> {
    const f = from.trim().toLowerCase();
    const t = to.trim().toLowerCase();
    for (const c of this.corridors.values()) {
      if (c.fromPlace.toLowerCase() === f && c.toPlace.toLowerCase() === t) return c;
    }
    return null;
  }

  async holdSeats(args: {
    corridorId: string;
    date: string;
    time: string;
    seats: number;
  }): Promise<SharedDeparture | null> {
    const corridor = this.corridors.get(args.corridorId);
    if (!corridor) return null;
    const key = `${args.corridorId}|${args.date}|${args.time}`;
    let dep = this.departures.get(key);
    if (!dep) {
      dep = {
        id: randomUUID(),
        corridorId: args.corridorId,
        date: args.date,
        time: args.time,
        seatsTotal: corridor.seatCapacity,
        seatsBooked: 0,
      };
      this.departures.set(key, dep);
    }
    // check-and-increment is atomic on the single-threaded event loop (no await between)
    if (dep.seatsBooked + args.seats > dep.seatsTotal) return null;
    dep.seatsBooked += args.seats;
    return { ...dep };
  }
}
