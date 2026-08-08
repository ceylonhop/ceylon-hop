// Gives existing bookings — including ones already paid for — their legs.
//
// Deliberately a script, not a migration step. Migrations auto-apply on Render boot and fail
// closed, so a single malformed historical row inside one would keep the API down. Run this
// against staging first, read the report, then run it against prod.
//
// Idempotent: (booking_id, seq) is unique, and inserts are ON CONFLICT DO NOTHING, so a partial
// run completes rather than duplicates.
//
// --dry-run: prints the full report (including the skip list) and writes nothing. Read this
// before running for real against a production target.
import { config as loadEnv } from 'dotenv';
import { eq, isNull } from 'drizzle-orm';
import { createDb } from '../src/db/client';
import { bookings, bookingLegs, transferRequests, tripRequests } from '../src/db/schema';
import { deriveLegsForMode, type NewLegRow } from '../src/domain/bookingLegs';

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
  reason: 'missing_request' | 'no_journey' | 'insert_failed' | 'unknown_mode';
  detail?: string;
}

/**
 * The pure half of row assembly: turns one joined (booking, transfer, trip) triple into the shape
 * planBackfill consumes. `transfer`/`trip` are undefined when the booking's request row is
 * missing — that is not this function's problem, planBackfill reports it as `missing_request`.
 */
export function toBackfillRow(
  booking: { id: string; mode: string },
  transfer: typeof transferRequests.$inferSelect | undefined,
  trip: typeof tripRequests.$inferSelect | undefined,
): BackfillRow {
  if (booking.mode === 'single') {
    return {
      bookingId: booking.id,
      mode: booking.mode,
      transfer: transfer
        ? {
            fromPlace: transfer.fromPlace,
            toPlace: transfer.toPlace,
            travelDate: transfer.travelDate,
            travelTime: transfer.travelTime,
          }
        : undefined,
    };
  }
  if (booking.mode === 'trip') {
    return {
      bookingId: booking.id,
      mode: booking.mode,
      trip: trip ? { stops: trip.stops, dates: trip.dates, serviceType: trip.serviceType } : undefined,
    };
  }
  return { bookingId: booking.id, mode: booking.mode };
}

/**
 * The pure half: what this run WOULD write. Exported for test.
 *
 * Delegates the mode → deriver decision to deriveLegsForMode (domain/bookingLegs.ts) — the same
 * dispatch legRowsForBooking uses at booking-insert time — rather than re-deciding what
 * 'single'/'trip'/'shared' mean here. Unlike legRowsForBooking's `mode`, this one comes straight
 * off the `bookings` table as a bare string, so it CAN be something neither writer has ever
 * produced; that's reported as `unknown_mode`, never dropped silently (skips are counted, not
 * silent — that's the whole point of this report).
 */
export function planBackfill(rows: BackfillRow[]): { legs: NewLegRow[]; skipped: SkipReport[] } {
  const legs: NewLegRow[] = [];
  const skipped: SkipReport[] = [];
  for (const row of rows) {
    if (row.mode === 'single' && !row.transfer) {
      skipped.push({ bookingId: row.bookingId, reason: 'missing_request' });
      continue;
    }
    if (row.mode === 'trip' && !row.trip) {
      skipped.push({ bookingId: row.bookingId, reason: 'missing_request' });
      continue;
    }
    const derived = deriveLegsForMode(row.mode, {
      single: row.transfer
        ? {
            from: row.transfer.fromPlace,
            to: row.transfer.toPlace,
            date: row.transfer.travelDate,
            time: row.transfer.travelTime,
          }
        : undefined,
      trip: row.trip
        ? {
            stops: row.trip.stops ?? [],
            dates: row.trip.dates,
            serviceType: row.trip.serviceType === 'chauffeur' ? 'chauffeur' : 'private',
          }
        : undefined,
    });
    if (derived === undefined) {
      skipped.push({ bookingId: row.bookingId, reason: 'unknown_mode', detail: row.mode });
      continue;
    }
    // A shared seat has no journey with editable ends — [] is expected, not a problem. Any
    // other mode with [] genuinely has no journey to derive (a trip whose stops array is too
    // short, for instance).
    if (row.mode !== 'shared' && !derived.length) {
      skipped.push({ bookingId: row.bookingId, reason: 'no_journey' });
      continue;
    }
    legs.push(...derived.map((l) => ({ ...l, bookingId: row.bookingId })));
  }
  return { legs, skipped };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
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
      rows.push(toBackfillRow(b, t, undefined));
    } else if (b.mode === 'trip') {
      const [t] = await db.select().from(tripRequests).where(eq(tripRequests.bookingId, b.id));
      rows.push(toBackfillRow(b, undefined, t));
    } else {
      rows.push(toBackfillRow(b, undefined, undefined));
    }
  }

  const { legs, skipped } = planBackfill(rows);

  // --dry-run prints the exact same report a real run would, minus the writing — the owner
  // reads the production skip list BEFORE committing to the write, not after. planBackfill has
  // already run against real production data above; only the insert loop below is skipped.
  if (dryRun) {
    console.log('DRY RUN — no rows will be written.');
    console.log(`bookings examined          : ${rows.length}`);
    console.log(`legs that would be written : ${legs.length}`);
    console.log(`skipped                    : ${skipped.length}`);
    for (const report of skipped) {
      const detail = report.detail ? `: ${report.detail}` : '';
      console.log(`  ${report.bookingId} — ${report.reason}${detail}`);
    }
    console.log('DRY RUN — nothing was written. Re-run without --dry-run to write these rows.');
    await sql.end();
    return;
  }

  // Grouped and inserted PER BOOKING, not as one statement for the whole run: a multi-row INSERT
  // is atomic, so a single row tripping a NOT NULL/CHECK constraint would abort every other
  // booking's legs too (onConflictDoNothing only covers unique conflicts), and at ~8 bind
  // params/row a whole-run statement can hit Postgres' 65,535-parameter ceiling past ~8,000 legs.
  // Per-booking keeps "all its legs or none" true without needing an arbitrary chunk size.
  const legsByBooking = new Map<string, NewLegRow[]>();
  for (const leg of legs) {
    const bucket = legsByBooking.get(leg.bookingId);
    if (bucket) bucket.push(leg);
    else legsByBooking.set(leg.bookingId, [leg]);
  }
  let written = 0;
  for (const [bookingId, bookingLegRows] of legsByBooking) {
    try {
      // onConflictDoNothing() can suppress some of the offered rows (e.g. a re-run over a
      // partially backfilled set) — `written` must count what was actually inserted, not what
      // was offered, or the owner reads a number that overstates what the run did.
      const inserted = await db
        .insert(bookingLegs)
        .values(bookingLegRows)
        .onConflictDoNothing()
        .returning({ id: bookingLegs.id });
      written += inserted.length;
    } catch (err) {
      skipped.push({
        bookingId,
        reason: 'insert_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Skips are REPORTED, never silent: a booking with no legs shows no card in Phase 2 and would
  // otherwise be invisible.
  console.log(`bookings examined : ${rows.length}`);
  console.log(`legs written      : ${written}`);
  console.log(`skipped           : ${skipped.length}`);
  for (const report of skipped) {
    const detail = report.detail ? `: ${report.detail}` : '';
    console.log(`  ${report.bookingId} — ${report.reason}${detail}`);
  }
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
