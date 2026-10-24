import { SHARED_PRODUCTS, departureKeyFor } from '../db/departureRepo';

// Paid seats on the scheduled shared taxis, for the ride board's "7 booked"
// (plan docs/superpowers/plans/2026-10-19-ride-board-fomo.md, PR 3), and since 2026-10-23 the
// faces of who booked: two letters and a country per booking, as the board's open rides show
// their members. Never a full name, surname or contact detail — the endpoint is public.

/** One paid booking as stored: the departure it holds, its seats, and who booked it. */
export interface SharedSeatCount { corridorId: string; date: string; time: string; seats: number; firstName: string; country: string }
/** A booker as the board draws them: the first two letters of their first name, and their country. */
export interface ScheduledSeatPerson { ini: string; country: string }
/** What the board reads: the van's paid seats and bookers, once per boarding time that rides it. */
export interface ScheduledSeatCount { corridorId: string; date: string; time: string; booked: number; people: ScheduledSeatPerson[] }

/** First two letters of a first name, capitalised — what board.js's avatar() draws for a member. */
function initials(firstName: string): string {
  return Array.from(firstName.trim()).slice(0, 2).join('').toUpperCase();
}

/**
 * Legs that ride one van share its seats (departureKeyFor — the inventory's own pooling), so
 * CMB 07:00 and Negombo 07:30 both report the van's total and the same faces. Two legs boarding
 * at the same time (Ella 09:00 → Weligama / → Ahangama) are one entry. A time no product
 * publishes has no row on the board, so it is dropped here. People keep the rows' order.
 */
export function scheduledSeatCounts(rows: SharedSeatCount[]): ScheduledSeatCount[] {
  const pools = new Map<string, { booked: number; people: ScheduledSeatPerson[] }>(); // corridor|date|pool
  for (const r of rows) {
    const k = `${r.corridorId}|${r.date}|${departureKeyFor(r.corridorId, r.time)}`;
    const pool = pools.get(k) ?? { booked: 0, people: [] };
    pool.booked += r.seats;
    pool.people.push({ ini: initials(r.firstName), country: r.country });
    pools.set(k, pool);
  }
  const out: ScheduledSeatCount[] = [];
  const seen = new Set<string>();
  for (const [k, { booked, people }] of pools) {
    const [corridorId, date, pool] = k.split('|');
    for (const p of SHARED_PRODUCTS) {
      if (p.corridorId !== corridorId || departureKeyFor(corridorId, p.time) !== pool) continue;
      const key = `${corridorId}|${date}|${p.time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ corridorId, date, time: p.time, booked, people });
    }
  }
  return out;
}
