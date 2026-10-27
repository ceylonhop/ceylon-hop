// Gives trips booked from an ops quote BEFORE trip_request.gaps existed (0076_trip_request_gaps)
// their self-arranged stretches, so the drawer and the itinerary email stop showing the customer's
// own train as a leg we drive (docs/known-bugs.md 2026-07-30 / 2026-08-04).
//
// Only ops-quoted trips can be recovered: their source quote still lists the rides we drive, and a
// stop pair the booking has that no SOLD ride covers is exactly the connector chainStops() inserted.
// Website trips' gaps were never stored anywhere, so they are left as they are.
//
// Deliberately a script, not a migration step (same reason as backfill-booking-legs.ts: one odd
// historical row must never keep the API down). Previews by default; --apply writes.
// Idempotent: only rows whose trip_request.gaps is still null are touched.
import { config as loadEnv } from 'dotenv';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb } from '../src/db/client';
import { bookingLegs, bookings, quotes, tripRequests } from '../src/db/schema';
import { normalizeRide, type PrivateLeg, type Ride } from '../src/quote/types';
import { legSelectionOf } from '../src/quote/paySelection';
import { requireConnectionUrl, describeDbError } from './lib/targetUrl';

loadEnv({ path: '.env', quiet: true });

export interface GapCandidate {
  bookingId: string;
  stops: string[];
  /** Every ride in the source quote's engine.legs, as stop lists. */
  rides: string[][];
  /** The quote's partial pay-link selection, when it has one (indexes into `rides`). */
  soldRides?: number[];
}

export interface GapSkip {
  bookingId: string;
  reason: 'quote_does_not_match';
}

/** The pure half: which trips get which gaps. Exported for test. */
export function planTripGaps(rows: GapCandidate[]): {
  updates: { bookingId: string; gaps: number[] }[];
  skipped: GapSkip[];
} {
  const updates: { bookingId: string; gaps: number[] }[] = [];
  const skipped: GapSkip[] = [];
  for (const row of rows) {
    const sold = row.soldRides ? row.rides.filter((_, i) => row.soldRides!.includes(i)) : row.rides;
    const driven = new Set(sold.flatMap((s) => s.slice(1).map((to, i) => `${s[i]}\u0000${to}`)));
    const wires = row.stops.length - 1;
    const gaps: number[] = [];
    for (let i = 0; i < wires; i++) {
      if (!driven.has(`${row.stops[i]}\u0000${row.stops[i + 1]}`)) gaps.push(i);
    }
    if (!gaps.length) continue;
    // Every pair a gap means the quote and the booking aren't the same trip. Never guess.
    if (gaps.length >= wires) {
      skipped.push({ bookingId: row.bookingId, reason: 'quote_does_not_match' });
      continue;
    }
    updates.push({ bookingId: row.bookingId, gaps });
  }
  return { updates, skipped };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  // DELIBERATELY NOT process.env.DATABASE_URL — api/.env points at PRODUCTION. Name the target.
  const url = requireConnectionUrl('BACKFILL_DATABASE_URL', 'write to');
  const { sql, db } = createDb(url);
  try {
    const found = await db
      .select({ bookingId: bookings.id, reference: bookings.reference, stops: tripRequests.stops, request: quotes.requestJson, selection: quotes.payLinkSelection })
      .from(bookings)
      .innerJoin(tripRequests, eq(tripRequests.bookingId, bookings.id))
      .innerJoin(quotes, and(eq(quotes.convertedBookingId, bookings.id), isNull(quotes.deletedAt)))
      .where(and(eq(bookings.mode, 'trip'), eq(tripRequests.serviceType, 'private'), isNull(tripRequests.gaps)));

    const refs = new Map(found.map((f) => [f.bookingId, f.reference]));
    const rows: GapCandidate[] = found.map((f) => {
      const legs = ((f.request as { engine?: { legs?: (PrivateLeg | Ride)[] } } | null)?.engine?.legs ?? []);
      const sel = legSelectionOf(f.selection as Parameters<typeof legSelectionOf>[0]);
      return {
        bookingId: f.bookingId,
        stops: f.stops,
        rides: legs.map((l) => normalizeRide(l).stops),
        ...(sel ? { soldRides: sel.legIndexes } : {}),
      };
    });
    const { updates, skipped } = planTripGaps(rows);

    console.log(apply ? 'APPLYING.' : 'PREVIEW — nothing will be written. Re-run with --apply to write.');
    console.log(`ops-quoted private trips examined : ${rows.length}`);
    console.log(`trips that get gaps               : ${updates.length}`);
    for (const u of updates) {
      const r = rows.find((x) => x.bookingId === u.bookingId)!;
      console.log(`  ${refs.get(u.bookingId)} — ${u.gaps.map((g) => `${r.stops[g]} → ${r.stops[g + 1]}`).join('; ')}`);
    }
    console.log(`skipped                           : ${skipped.length}`);
    for (const s of skipped) console.log(`  ${refs.get(s.bookingId)} — ${s.reason}`);

    if (apply) {
      for (const u of updates) {
        const { stops } = rows.find((x) => x.bookingId === u.bookingId)!;
        // One transaction per booking: its trip row and its leg rows agree, or neither changes.
        await db.transaction(async (tx) => {
          await tx.update(tripRequests).set({ gaps: u.gaps })
            .where(and(eq(tripRequests.bookingId, u.bookingId), isNull(tripRequests.gaps)));
          // Matched by the stop pair, not seq: a malformed stop may have shifted seq at insert
          // (filterUsableLegs), and a gap pair is by definition never also a pair we drive.
          for (const g of u.gaps) {
            await tx.update(bookingLegs).set({ kind: 'gap' })
              .where(and(
                eq(bookingLegs.bookingId, u.bookingId),
                eq(bookingLegs.fromPlace, stops[g]),
                eq(bookingLegs.toPlace, stops[g + 1]),
                eq(bookingLegs.kind, 'leg'),
              ));
          }
        });
      }
      console.log(`written: ${updates.length}`);
    }
    await sql.end();
  } catch (err) {
    throw new Error(`Database operation failed: ${describeDbError(err, url)}`);
  }
}

if (process.argv[1]?.endsWith('backfill-trip-gaps.ts')) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
