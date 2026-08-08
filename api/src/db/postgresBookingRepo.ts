import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './client';
import { customers, bookings, transferRequests, tripRequests, sharedRequests, bookingLegs } from './schema';
import {
  type BookingRepo,
  type NewBooking,
  type Booking,
  type BookingChannel,
  type StatusAudit,
  BookingNotFoundError,
  generateReference,
  PAYER_EDITABLE_STATUSES,
} from './bookingRepo';
import { assertTransition, IllegalTransitionError, type BookingStatus } from '../domain/status';
import type { SingleTransferInput, BillingInput } from '../domain/singleTransfer';
import { deriveLegsForMode, type NewLegRow } from '../domain/bookingLegs';

type BookingRow = typeof bookings.$inferSelect;

// A Postgres unique-violation (23505). Drizzle wraps the driver error as `Error: Failed
// query…` with the real PostgresError on `.cause`; the raw postgres.js error carries
// `code`/`constraint_name` directly. Walk the cause chain so 23505 is recognised either way.
// Exported (with the detectors) for unit tests — the DB-gated postgres.test.ts can't run
// without a database, so this pure detector is what guards create()'s retry/idempotency paths.
const UNIQUE_VIOLATION = '23505';
const MAX_REFERENCE_ATTEMPTS = 5;
export function pgUniqueViolation(err: unknown): { constraint: string } | null {
  let e: unknown = err;
  for (let depth = 0; depth < 6 && e && typeof e === 'object'; depth++) {
    const o = e as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    if (o.code === UNIQUE_VIOLATION) return { constraint: String(o.constraint_name ?? o.constraint ?? '') };
    e = o.cause;
  }
  return null;
}

// A CH-XXXXX reference collision — retry the insert with a fresh reference rather than 500-ing.
export function isReferenceCollision(err: unknown): boolean {
  const v = pgUniqueViolation(err);
  return v !== null && v.constraint.includes('reference');
}

// A concurrent create with the same Idempotency-Key hits the unique idempotency_key constraint.
// Unlike a reference collision (retry with a fresh reference), the right response is to return
// the booking the winning insert created — create is idempotent by contract.
export function isIdempotencyCollision(err: unknown): boolean {
  const v = pgUniqueViolation(err);
  return v !== null && v.constraint.includes('idempotency');
}

// `booking_legs.from_place`/`to_place` are `text NOT NULL`, but `trip_request.stops` is a
// Postgres `text[] NOT NULL` — an array that may legally contain a null or empty-string element.
// A malformed stop reaching the insert would raise a not-null violation INSIDE insertBooking's
// transaction, rolling back the customer, the booking and the request row that already validated
// fine — turning a recoverable data gap into a failed payment. A dropped leg is fully
// recoverable (the backfill and the reconciliation script both pick it up later); a failed
// booking is not. So malformed legs are filtered out here, not thrown on.
function isUsablePlace(v: string): boolean {
  return typeof v === 'string' && v.length > 0;
}

// Exported for test — see postgresBookingRepo.legs.test.ts. b.mode is always a known literal
// here (it's a NewBooking), so deriveLegsForMode never actually returns undefined; `?? []`
// exists only so a future NewBooking mode nobody's taught this dispatch about degrades to "no
// legs" rather than a type error, same as before this was shared with planBackfill.
export function legRowsForBooking(bookingId: string, b: NewBooking): NewLegRow[] {
  const legs =
    deriveLegsForMode(b.mode, {
      single: b.mode === 'single' ? b.input : undefined,
      trip: b.mode === 'trip' ? b.input : undefined,
    }) ?? [];
  return legs
    .filter((leg) => isUsablePlace(leg.fromPlace) && isUsablePlace(leg.toPlace))
    .map((leg) => ({ ...leg, bookingId }));
}

export class PostgresBookingRepo implements BookingRepo {
  constructor(private readonly db: Db) {}

  private async assemble(row: BookingRow): Promise<Booking> {
    const [cust] = await this.db.select().from(customers).where(eq(customers.id, row.customerId));
    const customer = {
      firstName: cust.firstName,
      lastName: cust.lastName,
      email: cust.email,
      phoneCountryCode: cust.phoneCountryCode ?? undefined,
      phoneNumber: cust.phoneNumber ?? undefined,
      whatsapp: cust.whatsapp,
      country: cust.country,
      marketingOptIn: cust.marketingOptIn ?? undefined,
    };
    const base = {
      id: row.id,
      reference: row.reference,
      status: row.status as BookingStatus,
      createdAt: row.createdAt.toISOString(),
      total: row.total,
      amountDueNow: row.amountDueNow, // null on pre-GL-3 rows
      needsPricing: row.needsPricing, // null on rows predating the column
      // Cancellation audit (owner rule 2026-08-02); null on anything not cancelled, and on
      // cancellations that predate the rule.
      cancellationReason: row.cancellationReason,
      cancelledBy: row.cancelledBy,
      cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
      currency: row.currency,
      channel: row.channel as BookingChannel,
      // Billing is all-or-nothing: address/city/country are validated together at /start, so
      // a row either has the set or has none. Keyed off address to avoid handing checkout a
      // half-filled object it would send to the gateway.
      billing: row.billingAddress
        ? {
            firstName: row.billingFirstName ?? undefined,
            lastName: row.billingLastName ?? undefined,
            address: row.billingAddress,
            city: row.billingCity ?? '',
            postcode: row.billingPostcode ?? undefined,
            state: row.billingState ?? undefined,
            country: row.billingCountry ?? '',
          }
        : null,
      termsAcceptedAt: row.termsAcceptedAt ? row.termsAcceptedAt.toISOString() : null,
    };
    if (row.mode === 'trip') {
      const [tr] = await this.db
        .select()
        .from(tripRequests)
        .where(eq(tripRequests.bookingId, row.id));
      return {
        ...base,
        mode: 'trip',
        input: {
          stops: tr.stops,
          nights: tr.nights,
          dates: tr.dates ?? undefined,
          pax: tr.pax,
          vehicleType: tr.vehicleType as 'car' | 'van',
          serviceType: tr.serviceType as 'private' | 'chauffeur',
          days: tr.days ?? undefined,
          driverNights: tr.driverNights ?? undefined,
          customer,
        },
      };
    }
    if (row.mode === 'shared') {
      const [sr] = await this.db
        .select()
        .from(sharedRequests)
        .where(eq(sharedRequests.bookingId, row.id));
      return {
        ...base,
        mode: 'shared',
        input: {
          corridorId: sr.corridorId,
          date: sr.date,
          time: sr.time,
          seats: sr.seats,
          customer,
        },
      };
    }
    const [t] = await this.db
      .select()
      .from(transferRequests)
      .where(eq(transferRequests.bookingId, row.id));
    return {
      ...base,
      mode: 'single',
      distanceKm: t.distanceKm ?? undefined,
      durationMin: t.durationMin ?? undefined,
      input: {
        from: t.fromPlace,
        to: t.toPlace,
        date: t.travelDate ?? undefined,
        time: t.travelTime ?? undefined,
        vehicleType: t.vehicleType as 'car' | 'van',
        adults: t.adults,
        children: t.children,
        bags: t.bags,
        customer,
      },
    };
  }

  async create(b: NewBooking, opts?: { idempotencyKey?: string }): Promise<Booking> {
    if (opts?.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(opts.idempotencyKey);
      if (existing) return existing;
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_REFERENCE_ATTEMPTS; attempt++) {
      try {
        // assemble after commit so the joined rows are visible
        return await this.assemble(await this.insertBooking(b, opts));
      } catch (err) {
        // Lost the race to a concurrent create with the same Idempotency-Key — the other
        // insert committed the booking, so return it instead of 500-ing (create is idempotent).
        if (opts?.idempotencyKey && isIdempotencyCollision(err)) {
          const existing = await this.findByIdempotencyKey(opts.idempotencyKey);
          if (existing) return existing;
        }
        // A reference collision rolls back the whole tx (customer insert included), so
        // retrying with a fresh generateReference() is clean — no orphaned customer row.
        if (!isReferenceCollision(err)) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  private async insertBooking(b: NewBooking, opts?: { idempotencyKey?: string }): Promise<BookingRow> {
    const c = b.input.customer;
    return this.db.transaction(async (tx) => {
      const [cust] = await tx
        .insert(customers)
        .values({
          firstName: c.firstName,
          // The column is NOT NULL and the schema now allows no surname (spec 2026-08-08) —
          // store the absence as empty, never as the string \"undefined\".
          lastName: c.lastName ?? '',
          email: c.email,
          phoneCountryCode: c.phoneCountryCode ?? null,
          phoneNumber: c.phoneNumber ?? null,
          whatsapp: c.whatsapp,
          country: c.country,
          marketingOptIn: c.marketingOptIn ?? null,
        })
        .returning();
      const [bk] = await tx
        .insert(bookings)
        .values({
          customerId: cust.id,
          reference: generateReference(),
          status: 'draft',
          mode: b.mode,
          total: b.total,
          amountDueNow: b.amountDueNow,
          currency: b.currency,
          idempotencyKey: opts?.idempotencyKey ?? null,
          channel: b.channel ?? 'website',
          needsPricing: b.needsPricing ?? null,
          billingFirstName: b.billing?.firstName ?? null,
          billingLastName: b.billing?.lastName ?? null,
          billingAddress: b.billing?.address ?? null,
          billingCity: b.billing?.city ?? null,
          billingCountry: b.billing?.country ?? null,
          billingPostcode: b.billing?.postcode ?? null,
          billingState: b.billing?.state ?? null,
          termsAcceptedAt: b.termsAcceptedAt ?? null,
        })
        .returning();
      if (b.mode === 'trip') {
        const t = b.input;
        await tx.insert(tripRequests).values({
          bookingId: bk.id,
          serviceType: t.serviceType,
          pax: t.pax,
          vehicleType: t.vehicleType,
          stops: t.stops,
          nights: t.nights,
          dates: t.dates ?? null,
          days: t.days ?? null,
          driverNights: t.driverNights ?? null,
        });
      } else if (b.mode === 'shared') {
        const t = b.input;
        await tx.insert(sharedRequests).values({
          bookingId: bk.id,
          corridorId: t.corridorId,
          date: t.date,
          time: t.time,
          seats: t.seats,
        });
      } else {
        const t = b.input;
        await tx.insert(transferRequests).values({
          bookingId: bk.id,
          fromPlace: t.from,
          toPlace: t.to,
          travelDate: t.date ?? null,
          travelTime: t.time ?? null,
          vehicleType: t.vehicleType,
          adults: t.adults,
          children: t.children,
          bags: t.bags,
          distanceKm: b.distanceKm ?? null,
          durationMin: b.durationMin ?? null,
        });
      }
      const legs = legRowsForBooking(bk.id, b);
      if (legs.length) await tx.insert(bookingLegs).values(legs);
      return bk;
    });
  }

  async get(id: string): Promise<Booking | null> {
    const [row] = await this.db.select().from(bookings).where(eq(bookings.id, id));
    return row ? this.assemble(row) : null;
  }

  async findByIdempotencyKey(key: string): Promise<Booking | null> {
    const [row] = await this.db.select().from(bookings).where(eq(bookings.idempotencyKey, key));
    return row ? this.assemble(row) : null;
  }

  async refreshPayerDetails(
    id: string,
    details: { customer: SingleTransferInput['customer']; billing?: BillingInput; termsAcceptedAt?: Date },
  ): Promise<Booking> {
    const c = details.customer;
    const b = details.billing;
    await this.db.transaction(async (tx) => {
      // The status check is part of the UPDATE, not a read-then-write: a settlement landing
      // between the two would otherwise let us rewrite the payer of a booking that has already
      // been charged. No row returned → paid (or beyond) → touch nothing, not even the customer.
      //
      // Absent billing leaves what was captured before, matching the in-memory repo: a payer who
      // filled the address on their first attempt and left it blank on a retry keeps it.
      const set: Record<string, unknown> = {};
      if (b) {
        set.billingFirstName = b.firstName ?? null;
        set.billingLastName = b.lastName ?? null;
        set.billingAddress = b.address;
        set.billingCity = b.city;
        set.billingCountry = b.country;
        set.billingPostcode = b.postcode ?? null;
        set.billingState = b.state ?? null;
      }
      // The acceptance belongs to whoever is actually paying, so a payer submission always
      // rewrites it. An ops re-book sends none — nobody ticked a box on a WhatsApp booking —
      // and must leave the column as it found it.
      if (details.termsAcceptedAt) set.termsAcceptedAt = details.termsAcceptedAt;
      // The UPDATE has to SET something real or it returns no row, and the status guard below
      // is the whole point of doing this as one statement. An ops re-book carries neither
      // billing nor an acceptance, so assign status to itself: here the guard, not the value,
      // is what the statement is for.
      if (Object.keys(set).length === 0) set.status = bookings.status;
      const [bk] = await tx
        .update(bookings)
        .set(set)
        .where(and(eq(bookings.id, id), inArray(bookings.status, [...PAYER_EDITABLE_STATUSES])))
        .returning();
      if (!bk) return;
      await tx
        .update(customers)
        .set({
          firstName: c.firstName,
          // The column is NOT NULL and the schema now allows no surname (spec 2026-08-08) —
          // store the absence as empty, never as the string \"undefined\".
          lastName: c.lastName ?? '',
          email: c.email,
          phoneCountryCode: c.phoneCountryCode ?? null,
          phoneNumber: c.phoneNumber ?? null,
          whatsapp: c.whatsapp,
          country: c.country,
          marketingOptIn: c.marketingOptIn ?? null,
        })
        .where(eq(customers.id, bk.customerId));
    });
    const fresh = await this.get(id);
    if (!fresh) throw new BookingNotFoundError(id);
    return fresh;
  }

  async setStatus(id: string, to: BookingStatus, audit?: StatusAudit): Promise<Booking> {
    const [row] = await this.db.select().from(bookings).where(eq(bookings.id, id));
    if (!row) throw new BookingNotFoundError(id);
    const from = row.status as BookingStatus;
    assertTransition(from, to);
    // Compare-and-set: only move the row if it is STILL in `from`, so two concurrent
    // transitions (e.g. a double-cancel) can't both win and double-release seats.
    const [updated] = await this.db
      .update(bookings)
      .set({
        status: to,
        // Only a cancellation carries a reason; every other transition leaves these untouched.
        ...(to === 'cancelled' && audit
          ? { cancellationReason: audit.reason, cancelledBy: audit.by, cancelledAt: audit.at ?? new Date() }
          : {}),
      })
      .where(and(eq(bookings.id, id), eq(bookings.status, from)))
      .returning();
    if (!updated) {
      const [current] = await this.db.select().from(bookings).where(eq(bookings.id, id));
      throw new IllegalTransitionError((current?.status as BookingStatus) ?? from, to);
    }
    return this.assemble(updated);
  }

  async list(filter?: { status?: BookingStatus | BookingStatus[] }): Promise<Booking[]> {
    let rows: BookingRow[];
    if (!filter?.status) {
      rows = await this.db.select().from(bookings);
    } else if (Array.isArray(filter.status)) {
      rows = await this.db.select().from(bookings).where(inArray(bookings.status, filter.status));
    } else {
      rows = await this.db.select().from(bookings).where(eq(bookings.status, filter.status));
    }
    return Promise.all(rows.map((r) => this.assemble(r)));
  }
}
