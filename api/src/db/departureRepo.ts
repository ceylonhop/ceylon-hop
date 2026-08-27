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
  times: string[]; // published departure times (mirrors the front-end `times`)
}
const CORRIDOR_ROUTES: CorridorRoute[] = [
  { id: 'airport-cultural', stops: ['Colombo Airport (CMB)', 'Colombo city', 'Negombo', 'Sigiriya / Dambulla', 'Kandy'], seat: 19, days: SHARED_SERVICE_DAYS, times: ['07:30'] },
  { id: 'hill-line', stops: ['Kandy', 'Nuwara Eliya', 'Ella'], seat: 21, days: SHARED_SERVICE_DAYS, times: ['08:00'] },
  { id: 'ella-east', stops: ['Ella', 'Yala', 'Arugam Bay'], seat: 23, days: SHARED_SERVICE_DAYS, times: ['09:00'] },
  { id: 'south-coast', stops: ['Galle', 'Hikkaduwa', 'Bentota', 'Weligama', 'Mirissa'], seat: 14, days: SHARED_SERVICE_DAYS, times: ['09:00', '14:00'] },
  { id: 'yala-south', stops: ['Yala', 'Mirissa', 'Weligama', 'Galle'], seat: 16, days: SHARED_SERVICE_DAYS, times: ['08:00'] },
  { id: 'ella-south', stops: ['Ella', 'Mirissa', 'Weligama', 'Ahangama'], seat: 24, days: SHARED_SERVICE_DAYS, times: ['09:00'] },
  // The southbound airport run. Added 2026-08-16 with the catalogue: no existing corridor
  // joined the south coast to CMB, so Mirissa/Weligama -> Airport could not be represented
  // at all. Seeded by seedCorridors() at boot — no migration.
  { id: 'south-airport', stops: ['Mirissa', 'Weligama', 'Colombo city', 'Colombo Airport (CMB)'], seat: 30, days: SHARED_SERVICE_DAYS, times: ['14:45'] },
];

// ────────────────────────────────────────────────────────────────────────────
//  THE SHARED CATALOGUE — what we actually sell (owner-supplied, 2026-08-16,
//  from the live product pages at ceylonhop.com/trip/*).
//
//  A corridor's `stops` describe the ROAD a van travels. They are NOT an offer.
//  Reading adjacency as an offer is what put a shared seat on 32 of 44 trip
//  pages, 16 of them the reverse of the direction the van actually runs.
//
//  Offers come from here and nowhere else: explicit, DIRECTED legs, each with
//  its own price and its own boarding time (a corridor's single departure time
//  is when the van leaves its FIRST stop, which is wrong for every other stop).
// ────────────────────────────────────────────────────────────────────────────
export interface SharedProduct {
  id: string; // marketed product id (several legs may share one)
  corridorId: string;
  fromPlace: string;
  toPlace: string;
  seatPrice: number; // minor units, per adult
  time: string; // boarding time AT `fromPlace`
  pickup: string | null; // named boarding point, as published
}

export const SHARED_PRODUCTS: SharedProduct[] = [
  // Northbound: CMB 07:00 -> Negombo 07:30 -> Sigiriya 11:30 -> Kandy ~14:00
  { id: 'negombo-sigiriya', corridorId: 'airport-cultural', fromPlace: 'Colombo Airport (CMB)', toPlace: 'Sigiriya / Dambulla', seatPrice: 2749, time: '07:00', pickup: 'CMB Airport' },
  { id: 'negombo-sigiriya', corridorId: 'airport-cultural', fromPlace: 'Negombo', toPlace: 'Sigiriya / Dambulla', seatPrice: 2749, time: '07:30', pickup: 'Zen Cafe, Negombo' },
  { id: 'sigiriya-kandy', corridorId: 'airport-cultural', fromPlace: 'Sigiriya / Dambulla', toPlace: 'Kandy', seatPrice: 1999, time: '11:30', pickup: 'Barista Cafe, Sigiriya' },
  // Ella run: Ella 09:00 -> Tissamaharama 11:15 (marketed as "Yala")
  { id: 'ella-yala', corridorId: 'ella-east', fromPlace: 'Ella', toPlace: 'Yala', seatPrice: 2299, time: '09:00', pickup: 'Barn by Starbeans Cafe, Ella' },
  // Ella -> south coast: ONE vehicle out of Ella at 09:00, dropping Mirissa 14:30,
  // Weligama 14:45, Ahangama 15:15 (owner's operating table, 2026-08-27). The seat is $24
  // to every stop, so these three legs differ only in where the traveller gets out.
  { id: 'ella-south-coast', corridorId: 'ella-south', fromPlace: 'Ella', toPlace: 'Mirissa', seatPrice: 2400, time: '09:00', pickup: 'Barn by Starbeans Cafe, Ella' },
  { id: 'ella-south-coast', corridorId: 'ella-south', fromPlace: 'Ella', toPlace: 'Weligama', seatPrice: 2400, time: '09:00', pickup: 'Barn by Starbeans Cafe, Ella' },
  { id: 'ella-south-coast', corridorId: 'ella-south', fromPlace: 'Ella', toPlace: 'Ahangama', seatPrice: 2400, time: '09:00', pickup: 'Barn by Starbeans Cafe, Ella' },
  // Southbound: Mirissa 14:45 -> Weligama 15:00 -> Colombo 18:30 -> CMB 19:00-20:00.
  // Colombo city is NOT sold: no product page has ever carried it and it has never taken a
  // booking. The marketed product on this van is "Mirissa/Weligama to Airport".
  { id: 'south-airport', corridorId: 'south-airport', fromPlace: 'Mirissa', toPlace: 'Colombo Airport (CMB)', seatPrice: 2999, time: '14:45', pickup: 'Barista Cafe, Mirissa' },
  { id: 'south-airport', corridorId: 'south-airport', fromPlace: 'Weligama', toPlace: 'Colombo Airport (CMB)', seatPrice: 2999, time: '15:00', pickup: 'Nomad Cafe, Weligama' },
];

const normPlace = (s: string) => s.trim().toLowerCase();

/** The scheduled product for a DIRECTED leg, or null. Adjacency is not an offer. */
export function sharedProductFor(from: string, to: string): SharedProduct | null {
  const f = normPlace(from), t = normPlace(to);
  return SHARED_PRODUCTS.find((p) => normPlace(p.fromPlace) === f && normPlace(p.toPlace) === t) ?? null;
}

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

// Seat inventory is keyed on (corridor, date, time), and holdSeats find-or-creates that row
// with a full 12 seats. A free-text time therefore mints a brand-new 12-seat van per distinct
// string — '7:30', '07:30 ', '07:31' and 'lunchtime' each opened another one, so one departure
// could be sold many times over. Departures are a published schedule, so only those count.
export function departureTimesForCorridor(id: string): string[] {
  const route = CORRIDOR_ROUTES.find((c) => c.id === id);
  return route ? route.times : [];
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
