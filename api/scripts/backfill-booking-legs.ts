// Gives existing bookings — including ones already paid for — their legs.
//
// Deliberately a script, not a migration step. Migrations auto-apply on Render boot and fail
// closed, so a single malformed historical row inside one would keep the API down. Run this
// against staging first, read the report, then run it against prod.
//
// Idempotent: (booking_id, seq) is unique, and inserts are ON CONFLICT DO NOTHING, so a partial
// run completes rather than duplicates.
import { config as loadEnv } from 'dotenv';
import { eq, isNull } from 'drizzle-orm';
import { createDb } from '../src/db/client';
import { bookings, bookingLegs, transferRequests, tripRequests } from '../src/db/schema';
import { deriveSingleLegs, deriveTripLegs } from '../src/domain/bookingLegs';
import type { NewLegRow } from '../src/db/postgresBookingRepo';

loadEnv({ path: '.env', quiet: true });

// DELIBERATELY NOT process.env.DATABASE_URL. The api/.env in this repo points at PRODUCTION
// Supabase, so an implicit read would backfill prod from a laptop by accident. The operator must
// name the target every time.
function targetUrl(): string {
  const url = process.env.BACKFILL_DATABASE_URL;
  if (!url) {
    throw new Error(
      'Set BACKFILL_DATABASE_URL to the database you mean to write to. ' +
        'DATABASE_URL is not used here on purpose — api/.env points at production.',
    );
  }
  return url;
}

export interface BackfillRow {
  bookingId: string;
  mode: string;
  transfer?: {
    fromPlace: string;
    toPlace: string;
    travelDate: string | null;
    travelTime: string | null;
  };
  trip?: { stops: string[]; dates: string[] | null; serviceType: string };
}

export interface SkipReport {
  bookingId: string;
  reason: 'missing_request' | 'no_journey';
}

/** The pure half: what this run WOULD write. Exported for test. */
export function planBackfill(rows: BackfillRow[]): { legs: NewLegRow[]; skipped: SkipReport[] } {
  const legs: NewLegRow[] = [];
  const skipped: SkipReport[] = [];
  for (const row of rows) {
    // A shared seat has no journey with editable ends. Not a problem — just not our business.
    if (row.mode === 'shared') continue;
    if (row.mode === 'single') {
      if (!row.transfer) {
        skipped.push({ bookingId: row.bookingId, reason: 'missing_request' });
        continue;
      }
      const derived = deriveSingleLegs({
        from: row.transfer.fromPlace,
        to: row.transfer.toPlace,
        date: row.transfer.travelDate,
        time: row.transfer.travelTime,
      });
      legs.push(...derived.map((l) => ({ ...l, bookingId: row.bookingId })));
      continue;
    }
    if (row.mode === 'trip') {
      if (!row.trip) {
        skipped.push({ bookingId: row.bookingId, reason: 'missing_request' });
        continue;
      }
      const derived = deriveTripLegs({
        stops: row.trip.stops ?? [],
        dates: row.trip.dates,
        serviceType: row.trip.serviceType === 'chauffeur' ? 'chauffeur' : 'private',
      });
      if (!derived.length) {
        skipped.push({ bookingId: row.bookingId, reason: 'no_journey' });
        continue;
      }
      legs.push(...derived.map((l) => ({ ...l, bookingId: row.bookingId })));
    }
  }
  return { legs, skipped };
}

async function main(): Promise<void> {
  const { sql, db } = createDb(targetUrl());
  const rows: BackfillRow[] = [];
  const all = await db
    .select({ id: bookings.id, mode: bookings.mode })
    .from(bookings)
    .leftJoin(bookingLegs, eq(bookingLegs.bookingId, bookings.id))
    .where(isNull(bookingLegs.id));

  for (const b of all) {
    if (b.mode === 'single') {
      const [t] = await db
        .select()
        .from(transferRequests)
        .where(eq(transferRequests.bookingId, b.id));
      rows.push({
        bookingId: b.id,
        mode: b.mode,
        transfer: t
          ? {
              fromPlace: t.fromPlace,
              toPlace: t.toPlace,
              travelDate: t.travelDate,
              travelTime: t.travelTime,
            }
          : undefined,
      });
    } else if (b.mode === 'trip') {
      const [t] = await db.select().from(tripRequests).where(eq(tripRequests.bookingId, b.id));
      rows.push({
        bookingId: b.id,
        mode: b.mode,
        trip: t ? { stops: t.stops, dates: t.dates, serviceType: t.serviceType } : undefined,
      });
    } else {
      rows.push({ bookingId: b.id, mode: b.mode });
    }
  }

  const { legs, skipped } = planBackfill(rows);
  if (legs.length) await db.insert(bookingLegs).values(legs).onConflictDoNothing();

  // Skips are REPORTED, never silent: a booking with no legs shows no card in Phase 2 and would
  // otherwise be invisible.
  console.log(`bookings examined : ${rows.length}`);
  console.log(`legs written      : ${legs.length}`);
  console.log(`skipped           : ${skipped.length}`);
  for (const report of skipped) console.log(`  ${report.bookingId} — ${report.reason}`);
  await sql.end();
}

if (process.argv[1]?.endsWith('backfill-booking-legs.ts')) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
