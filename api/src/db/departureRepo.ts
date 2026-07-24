import { randomUUID } from 'node:crypto';

export interface Corridor {
  id: string;
  fromPlace: string;
  toPlace: string;
  seatPrice: number; // minor units, per seat
  seatCapacity: number; // default capacity per departure
  serviceDays: number[]; // weekdays the shared service runs, 0=Sun … 6=Sat (mirrors the front-end `days`)
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
  // Give held seats back (GL-3: cancelled/refunded/stale shared bookings). Floors at 0;
  // a departure that was never held is a harmless no-op.
  releaseSeats(args: {
    corridorId: string;
    date: string;
    time: string;
    seats: number;
  }): Promise<void>;
}

// Shared corridors — these MIRROR the front-end (transfers-data.js `CORRIDORS`).
// `stops` are place NAMES exactly as the site sends them (booking.js posts the place
// name for from/to). A shared seat exists between ANY two stops on one corridor, at the
// corridor's flat seat price — same rule as the front-end's `sharedOption`.
// Shared seats run a fixed WEEKLY schedule, not a daily one: `days` are the weekdays the
// service departs (0=Sun … 6=Sat), mirroring the front-end's `SHARED_DAYS`.
const SHARED_CAPACITY = 12;
const SHARED_SERVICE_DAYS = [3, 6]; // Wed & Sat — mirrors transfers-data.js `SHARED_DAYS`
interface CorridorRoute {
  id: string;
  stops: string[];
  seat: number; // whole USD per seat (front-end value)
  days: number[]; // service weekdays, 0=Sun … 6=Sat (mirrors the front-end `days`)
}
const CORRIDOR_ROUTES: CorridorRoute[] = [
  { id: 'airport-cultural', stops: ['Colombo Airport (CMB)', 'Colombo city', 'Negombo', 'Sigiriya / Dambulla', 'Kandy'], seat: 19, days: SHARED_SERVICE_DAYS },
  { id: 'hill-line', stops: ['Kandy', 'Nuwara Eliya', 'Ella'], seat: 21, days: SHARED_SERVICE_DAYS },
  { id: 'ella-east', stops: ['Ella', 'Yala', 'Arugam Bay'], seat: 23, days: SHARED_SERVICE_DAYS },
  { id: 'south-coast', stops: ['Galle', 'Hikkaduwa', 'Bentota', 'Weligama', 'Mirissa'], seat: 14, days: SHARED_SERVICE_DAYS },
  { id: 'yala-south', stops: ['Yala', 'Mirissa', 'Weligama', 'Galle'], seat: 16, days: SHARED_SERVICE_DAYS },
  { id: 'ella-south', stops: ['Ella', 'Mirissa', 'Weligama'], seat: 24, days: SHARED_SERVICE_DAYS },
];

export const DEFAULT_CORRIDORS: Corridor[] = CORRIDOR_ROUTES.map((c) => ({
  id: c.id,
  fromPlace: c.stops[0],
  toPlace: c.stops[c.stops.length - 1],
  seatPrice: c.seat * 100, // minor units
  seatCapacity: SHARED_CAPACITY,
  serviceDays: c.days,
}));

// The corridor catalogue (stops + service days) lives in code; the DB `corridor` table
// stores only endpoints/price/capacity. Resolve a corridor's service weekdays by id, with
// the standard Wed & Sat schedule as the fallback for any corridor not in the catalogue.
export function serviceDaysForCorridor(id: string): number[] {
  const route = CORRIDOR_ROUTES.find((c) => c.id === id);
  return route ? route.days : SHARED_SERVICE_DAYS;
}

// A corridor's route endpoints by id, for customer-facing copy (emails). Non-directional —
// a seat can run either way along the corridor, so callers must not render an arrow.
// Null (not a fallback name) for ids outside the catalogue, so callers keep their own
// neutral wording.
export function corridorRouteEnds(id: string): { from: string; to: string } | null {
  const route = CORRIDOR_ROUTES.find((c) => c.id === id);
  return route ? { from: route.stops[0], to: route.stops[route.stops.length - 1] } : null;
}

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

  async releaseSeats(args: {
    corridorId: string;
    date: string;
    time: string;
    seats: number;
  }): Promise<void> {
    const dep = this.departures.get(`${args.corridorId}|${args.date}|${args.time}`);
    if (!dep) return; // never held → nothing to give back
    dep.seatsBooked = Math.max(0, dep.seatsBooked - args.seats);
  }
}
