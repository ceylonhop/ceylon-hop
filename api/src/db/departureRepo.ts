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

// Shared corridors — these MIRROR the frozen front-end (transfers-data.js `CORRIDORS`).
// `stops` are place NAMES exactly as the site sends them (booking.js posts the place
// name for from/to). A shared seat exists between ANY two stops on one corridor, at the
// corridor's flat seat price — same rule as the front-end's `sharedOption`.
const SHARED_CAPACITY = 12;
interface CorridorRoute {
  id: string;
  stops: string[];
  seat: number; // whole USD per seat (front-end value)
}
const CORRIDOR_ROUTES: CorridorRoute[] = [
  { id: 'airport-cultural', stops: ['Colombo Airport (CMB)', 'Colombo city', 'Negombo', 'Sigiriya / Dambulla', 'Kandy'], seat: 19 },
  { id: 'hill-line', stops: ['Kandy', 'Nuwara Eliya', 'Ella'], seat: 21 },
  { id: 'ella-east', stops: ['Ella', 'Yala', 'Arugam Bay'], seat: 23 },
  { id: 'south-coast', stops: ['Galle', 'Hikkaduwa', 'Bentota', 'Weligama', 'Mirissa'], seat: 14 },
  { id: 'yala-south', stops: ['Yala', 'Mirissa', 'Weligama', 'Galle'], seat: 16 },
  { id: 'ella-south', stops: ['Ella', 'Mirissa', 'Weligama'], seat: 24 },
];

export const DEFAULT_CORRIDORS: Corridor[] = CORRIDOR_ROUTES.map((c) => ({
  id: c.id,
  fromPlace: c.stops[0],
  toPlace: c.stops[c.stops.length - 1],
  seatPrice: c.seat * 100, // minor units
  seatCapacity: SHARED_CAPACITY,
}));

// Resolve which corridor carries both endpoints (any direction), first match wins —
// mirrors the front-end iteration order. Used when no corridorId is supplied.
export function corridorIdForRoute(from: string, to: string): string | null {
  const f = from.trim().toLowerCase();
  const t = to.trim().toLowerCase();
  for (const c of CORRIDOR_ROUTES) {
    const names = c.stops.map((s) => s.toLowerCase());
    if (names.includes(f) && names.includes(t)) return c.id;
  }
  return null;
}

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
    const id = corridorIdForRoute(from, to);
    return id ? this.getCorridor(id) : null;
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
