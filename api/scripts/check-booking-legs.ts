// Phase 1's gate. Prints one line per discrepancy between what a booking says its route is and
// what its legs say. Read-only — it writes nothing.
//
// The comparison itself lives in ../src/db/checkBookingLegs.ts as a pure, tested function; this
// file is only the I/O half — query, call it, print.
import { config as loadEnv } from 'dotenv';
import { asc, eq } from 'drizzle-orm';
import { createDb } from '../src/db/client';
import { bookings, bookingLegs, transferRequests, tripRequests } from '../src/db/schema';
import { reconcileBooking, type Problem } from '../src/db/checkBookingLegs';

loadEnv({ path: '.env', quiet: true });

// DELIBERATELY NOT process.env.DATABASE_URL. The api/.env in this repo points at PRODUCTION
// Supabase, so an implicit read would check prod from a laptop by accident. The operator must
// name the target every time. Same rule, same reasoning as the backfill script.
function targetUrl(): string {
  const url = process.env.BACKFILL_DATABASE_URL;
  if (!url) {
    throw new Error(
      'Set BACKFILL_DATABASE_URL to the database you mean to read. ' +
        'DATABASE_URL is not used here on purpose — api/.env points at production.',
    );
  }
  return url;
}

async function main(): Promise<void> {
  const { sql, db } = createDb(targetUrl());

  const all = await db
    .select({ id: bookings.id, mode: bookings.mode, ref: bookings.reference })
    .from(bookings);

  let ok = 0;
  const problems: Problem[] = [];

  for (const b of all) {
    const legs = await db
      .select({
        seq: bookingLegs.seq,
        fromPlace: bookingLegs.fromPlace,
        toPlace: bookingLegs.toPlace,
      })
      .from(bookingLegs)
      .where(eq(bookingLegs.bookingId, b.id))
      .orderBy(asc(bookingLegs.seq));

    let transfer: { fromPlace: string; toPlace: string } | undefined;
    let trip: { stops: string[] } | undefined;

    if (b.mode === 'single') {
      const [t] = await db.select().from(transferRequests).where(eq(transferRequests.bookingId, b.id));
      transfer = t ? { fromPlace: t.fromPlace, toPlace: t.toPlace } : undefined;
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
  for (const p of problems) console.log(`  ${p.ref}: ${p.message}`);

  await sql.end();
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1]?.endsWith('check-booking-legs.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
