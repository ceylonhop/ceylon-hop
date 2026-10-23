import { SHARED_PRODUCTS, departureKeyFor } from '../db/departureRepo';

// Paid seats on the scheduled shared taxis, for the ride board's "7 booked"
// (plan docs/superpowers/plans/2026-10-19-ride-board-fomo.md, PR 3). A count per van, never who.

/** Paid seats as stored: one row per (corridor, date, boarding time) a booking holds. */
export interface SharedSeatCount { corridorId: string; date: string; time: string; seats: number }
/** What the board reads: the van's paid seats, once per boarding time that rides it. */
export interface ScheduledSeatCount { corridorId: string; date: string; time: string; booked: number }

/**
 * Legs that ride one van share its seats (departureKeyFor — the inventory's own pooling), so
 * CMB 07:00 and Negombo 07:30 both report the van's total. Two legs boarding at the same time
 * (Ella 09:00 → Weligama / → Ahangama) are one entry. A time no product publishes has no row
 * on the board, so it is dropped here.
 */
export function scheduledSeatCounts(rows: SharedSeatCount[]): ScheduledSeatCount[] {
  const pools = new Map<string, number>(); // corridor|date|pool → seats
  for (const r of rows) {
    const k = `${r.corridorId}|${r.date}|${departureKeyFor(r.corridorId, r.time)}`;
    pools.set(k, (pools.get(k) ?? 0) + r.seats);
  }
  const out: ScheduledSeatCount[] = [];
  const seen = new Set<string>();
  for (const [k, booked] of pools) {
    const [corridorId, date, pool] = k.split('|');
    for (const p of SHARED_PRODUCTS) {
      if (p.corridorId !== corridorId || departureKeyFor(corridorId, p.time) !== pool) continue;
      const key = `${corridorId}|${date}|${p.time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ corridorId, date, time: p.time, booked });
    }
  }
  return out;
}
