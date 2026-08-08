// Phase 1's gate. Prints one line per discrepancy between what a booking says its route is and
// what its legs say. Read-only — it writes nothing.
//
// The comparison itself lives in ../src/db/checkBookingLegs.ts as a pure, tested function; this
// file is only the I/O half — query, call it, print.
import { config as loadEnv } from 'dotenv';
import { asc, eq } from 'drizzle-orm';
import { createDb } from '../src/db/client';
import { bookings, bookingLegs, transferRequests, tripRequests } from '../src/db/schema';
import { reconcileBooking, type LegEndpoints, type Problem, type ProblemReason } from '../src/db/checkBookingLegs';
import type { BookingLegKind } from '../src/domain/bookingLegs';
import { requireConnectionUrl, redactConnectionString } from './lib/targetUrl';

loadEnv({ path: '.env', quiet: true });

// DELIBERATELY NOT process.env.DATABASE_URL. The api/.env in this repo points at PRODUCTION
// Supabase, so an implicit read would check prod from a laptop by accident. The operator must
// name the target every time. Same rule, same reasoning as the backfill script.
function targetUrl(): string {
  return requireConnectionUrl('BACKFILL_DATABASE_URL', 'read');
}

async function main(): Promise<void> {
  const url = targetUrl();
  const { sql, db } = createDb(url);

  // Everything below touches the driver, directly or via drizzle. A well-formed URL with a wrong
  // password (or a dropped connection mid-run) can still produce a driver error, and nothing
  // guarantees that error's message won't quote the connection string back — so any driver error
  // here gets sanitised before it's shown or rethrown. This does not swallow the failure: the
  // operator still sees that the connection failed and why, just not the credential.
  try {
    const all = await db
      .select({ id: bookings.id, mode: bookings.mode, ref: bookings.reference })
      .from(bookings);

    let ok = 0;
    const problems: Problem[] = [];

    for (const b of all) {
      const rawLegs = await db
        .select({
          seq: bookingLegs.seq,
          kind: bookingLegs.kind,
          fromPlace: bookingLegs.fromPlace,
          toPlace: bookingLegs.toPlace,
          viaStops: bookingLegs.viaStops,
          pickupTime: bookingLegs.pickupTime,
        })
        .from(bookingLegs)
        .where(eq(bookingLegs.bookingId, b.id))
        .orderBy(asc(bookingLegs.seq));
      // bookingLegs.kind is a plain text column (no DB-level enum) — cast to the derivation's
      // BookingLegKind, same as row.status is cast to BookingStatus elsewhere in this codebase.
      const legs: LegEndpoints[] = rawLegs.map((l) => ({ ...l, kind: l.kind as BookingLegKind }));

      let transfer: { fromPlace: string; toPlace: string; travelTime?: string | null } | undefined;
      let trip: { stops: string[] } | undefined;

      if (b.mode === 'single') {
        const [t] = await db.select().from(transferRequests).where(eq(transferRequests.bookingId, b.id));
        transfer = t ? { fromPlace: t.fromPlace, toPlace: t.toPlace, travelTime: t.travelTime } : undefined;
      } else if (b.mode !== 'shared') {
        const [t] = await db.select().from(tripRequests).where(eq(tripRequests.bookingId, b.id));
        trip = t ? { stops: t.stops } : undefined;
      }

      const rowProblems = reconcileBooking({ ref: b.ref, mode: b.mode }, { transfer, trip }, legs);
      if (rowProblems.length) problems.push(...rowProblems);
      else ok += 1;
    }

    console.log(`reconciled : ${ok}`);
    console.log(`problems   : ${problems.length}`);

    // Grouped by reason with counts, not a flat list: production can hold a historically
    // malformed row that is known and accepted, and a flat list makes that indistinguishable
    // from a fresh regression. Grouping doesn't change the gate (still a non-zero exit on any
    // problem) — it just makes what's already known readable at a glance instead of requiring
    // the owner to eyeball every ref.
    const byReason = new Map<ProblemReason, Problem[]>();
    for (const p of problems) {
      const bucket = byReason.get(p.reason);
      if (bucket) bucket.push(p);
      else byReason.set(p.reason, [p]);
    }
    for (const [reason, group] of byReason) {
      console.log(`  ${reason} (${group.length}):`);
      for (const p of group) console.log(`    ${p.ref}: ${p.message}`);
    }

    await sql.end();
    process.exit(problems.length ? 1 : 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Database operation failed: ${redactConnectionString(message, url)}`);
  }
}

if (process.argv[1]?.endsWith('check-booking-legs.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
