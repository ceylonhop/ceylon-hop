import { and, desc, eq, exists, gt, inArray, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { customers, bookings, transferRequests, tripRequests, sharedRequests, bookingLegs, payments, promoCodes } from './schema';
import {
  type BookingRepo,
  type NewBooking,
  type Booking,
  type BookingChannel,
  type StatusAudit,
  type PromoHold,
  type PromoBookingUse,
  BookingNotFoundError,
  generateReference,
  PAYER_EDITABLE_STATUSES,
} from './bookingRepo';
import { toPromoCode } from './promoCodeRow';
import {
  PROMO_HELD_STATUSES,
  PROMO_HOLD_MS,
  PROMO_PAID_STATUSES,
  PromoCodeRefusedError,
  promoCodeAvailability,
  promoUseState,
  type PromoCode,
} from '../domain/promoCode';
import { assertTransition, IllegalTransitionError, type BookingStatus } from '../domain/status';
import type { SingleTransferInput, BillingInput } from '../domain/singleTransfer';
import { deriveLegsForMode, type NewLegRow } from '../domain/bookingLegs';
import { track } from '../observability/track';

type BookingRow = typeof bookings.$inferSelect;
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

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

// Exported for test — see postgresBookingRepo.legs.test.ts. b.mode is always a known literal
// here (it's a NewBooking), so deriveLegsForMode never actually returns undefined; `?? []`
// exists only so a future NewBooking mode nobody's taught this dispatch about degrades to "no
// legs" rather than a type error, same as before this was shared with planBackfill.
//
// deriveLegsForMode already drops malformed places (a null/empty fromPlace or toPlace, or a
// null/empty entry inside viaStops) before returning — see domain/bookingLegs.ts. That filtering
// used to live here; it moved so legRowsForBooking and planBackfill (backfill-booking-legs.ts)
// can't disagree about what "usable" means.
export function legRowsForBooking(bookingId: string, b: NewBooking): NewLegRow[] {
  const legs =
    deriveLegsForMode(b.mode, {
      single: b.mode === 'single' ? b.input : undefined,
      trip: b.mode === 'trip' ? b.input : undefined,
    }) ?? [];
  return legs.map((leg) => ({ ...leg, bookingId }));
}

// legRowsForBooking guards VALUES (a null/empty place) but not SHAPES: a `stops` that isn't an
// array, or a `dates` that isn't an array for a chauffeur trip, still throws inside
// deriveTripLegs/chauffeurDays. None of these are reachable today — trip_request.stops is
// `text[] NOT NULL`, quoteToBooking builds both arrays itself, and zod validates the website
// path — but insertBooking calls this INSIDE its transaction, after the customer, booking and
// request rows are already written, so "this insert cannot fail a payment" has to be literally
// true for shapes too. A dropped set of legs is fully recoverable (the backfill and the
// reconciliation script both pick it up); a failed payment is not. track() so the failure isn't
// silent — something this basic reaching this deep is a bug worth knowing about, not a routine
// data gap like the value-level drops above.
export function safeLegRowsForBooking(bookingId: string, b: NewBooking): NewLegRow[] {
  try {
    return legRowsForBooking(bookingId, b);
  } catch (err) {
    track(err, { tag: 'booking-legs-derivation', extra: { bookingId, mode: b.mode } });
    return [];
  }
}

type CustomerRow = typeof customers.$inferSelect;
type RequestRow = typeof tripRequests.$inferSelect | typeof sharedRequests.$inferSelect | typeof transferRequests.$inferSelect;

// Pure shaping of one booking from its already-fetched rows. No I/O here on purpose: every
// query belongs in assembleMany(), where it runs once per table.
function build(row: BookingRow, cust: CustomerRow, req: RequestRow): Booking {
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
    // Only bookings made with a code carry these, so every other booking's shape is unchanged.
    ...(row.promoCodeId
      ? {
          promoCodeId: row.promoCodeId,
          promoHoldUntil: row.promoHoldUntil ? row.promoHoldUntil.toISOString() : null,
          discountTotal: row.discountTotal ?? 0,
        }
      : {}),
  };
  if (row.mode === 'trip') {
    const tr = req as typeof tripRequests.$inferSelect;
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
    const sr = req as typeof sharedRequests.$inferSelect;
    return {
      ...base,
      mode: 'shared',
      input: {
        corridorId: sr.corridorId,
        // null => this row never recorded its leg (pre-0051). Undefined, not null, so the
        // label resolver's "both ends or nothing" rule reads it the same as an absent field.
        ...(sr.fromPlace ? { fromPlace: sr.fromPlace } : {}),
        ...(sr.toPlace ? { toPlace: sr.toPlace } : {}),
        ...(sr.bags === null ? {} : { bags: sr.bags }),
        date: sr.date,
        time: sr.time,
        seats: sr.seats,
        customer,
      },
    };
  }
  const t = req as typeof transferRequests.$inferSelect;
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

export class PostgresBookingRepo implements BookingRepo {
  constructor(private readonly db: Db) {}

  // SQL twin of promoUseState() (domain/promoCode.ts); bookingPromo.test.ts holds both to the same cases.
  private succeededPayment() {
    return exists(
      this.db
        .select({ one: sql`1` })
        .from(payments)
        .where(and(eq(payments.bookingId, bookings.id), eq(payments.status, 'succeeded'))),
    );
  }

  private async countUses(tx: Transaction, codeId: string, now: Date): Promise<{ paid: number; held: number }> {
    const paid = or(inArray(bookings.status, [...PROMO_PAID_STATUSES]), this.succeededPayment());
    const held = and(inArray(bookings.status, [...PROMO_HELD_STATUSES]), gt(bookings.promoHoldUntil, now));
    const [row] = await tx
      .select({
        paid: sql<number>`count(*) filter (where ${paid})`.mapWith(Number),
        held: sql<number>`count(*) filter (where not (${paid}) and ${held})`.mapWith(Number),
      })
      .from(bookings)
      .where(eq(bookings.promoCodeId, codeId));
    return { paid: row?.paid ?? 0, held: row?.held ?? 0 };
  }

  /** Lock the code row and prove a use can be taken at `now` (§5.3). */
  private async takeUse(tx: Transaction, codeId: string, now: Date): Promise<PromoCode> {
    const [locked] = await tx.select().from(promoCodes).where(eq(promoCodes.id, codeId)).for('update');
    if (!locked) throw new PromoCodeRefusedError('promo_code_invalid');
    const code = toPromoCode(locked);
    const unavailable = promoCodeAvailability(code, now);
    if (unavailable) throw new PromoCodeRefusedError(unavailable);
    const { paid, held } = await this.countUses(tx, code.id, now);
    if (paid + held >= code.maxUses) throw new PromoCodeRefusedError('promo_code_used_up');
    return code;
  }

  private async assemble(row: BookingRow): Promise<Booking> {
    const [b] = await this.assembleMany([row]);
    return b;
  }

  // One round-trip per TABLE, not per booking. list() feeds the ops queue, which reads every
  // booking in the eight queue statuses on every page load; a customer + request lookup per
  // row was 2N statements, and from Render to the Supabase pooler each one costs ~100 ms
  // (2026-09-22). get() goes through here too so the two never drift in shape.
  private async assembleMany(rows: BookingRow[]): Promise<Booking[]> {
    if (rows.length === 0) return [];
    const custRows = await this.db.select().from(customers)
      .where(inArray(customers.id, [...new Set(rows.map((r) => r.customerId))]));
    const custById = new Map(custRows.map((c) => [c.id, c]));
    const idsFor = (mode: string) => rows.filter((r) => r.mode === mode).map((r) => r.id);
    const tripIds = idsFor('trip'); const sharedIds = idsFor('shared');
    const singleIds = rows.filter((r) => r.mode !== 'trip' && r.mode !== 'shared').map((r) => r.id);
    const [trips, shareds, transfers] = await Promise.all([
      tripIds.length ? this.db.select().from(tripRequests).where(inArray(tripRequests.bookingId, tripIds)) : [],
      sharedIds.length ? this.db.select().from(sharedRequests).where(inArray(sharedRequests.bookingId, sharedIds)) : [],
      singleIds.length ? this.db.select().from(transferRequests).where(inArray(transferRequests.bookingId, singleIds)) : [],
    ]);
    const tripBy = new Map(trips.map((t) => [t.bookingId, t]));
    const sharedBy = new Map(shareds.map((t) => [t.bookingId, t]));
    const transferBy = new Map(transfers.map((t) => [t.bookingId, t]));
    return rows.map((row) => {
      const cust = custById.get(row.customerId);
      if (!cust) throw new Error(`booking ${row.id}: customer ${row.customerId} missing`);
      const req = row.mode === 'trip' ? tripBy.get(row.id) : row.mode === 'shared' ? sharedBy.get(row.id) : transferBy.get(row.id);
      if (!req) throw new Error(`booking ${row.id}: ${row.mode} request row missing`);
      return build(row, cust, req);
    });
  }

  async create(b: NewBooking, opts?: { idempotencyKey?: string; promo?: PromoHold }): Promise<Booking> {
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

  private async insertBooking(b: NewBooking, opts?: { idempotencyKey?: string; promo?: PromoHold }): Promise<BookingRow> {
    const c = b.input.customer;
    return this.db.transaction(async (tx) => {
      // Re-reads the code under FOR UPDATE: a code switched off or filled mid-request is not honoured.
      if (opts?.promo) await this.takeUse(tx, opts.promo.code.id, opts.promo.now);
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
          discountTotal: b.mode !== 'shared' && b.discountTotal !== undefined ? b.discountTotal : null,
          promoCodeId: opts?.promo ? opts.promo.code.id : null,
          promoHoldUntil: opts?.promo ? new Date(opts.promo.now.getTime() + PROMO_HOLD_MS) : null,
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
          fromPlace: t.fromPlace ?? null,
          toPlace: t.toPlace ?? null,
          bags: t.bags ?? null,
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
      const legs = safeLegRowsForBooking(bk.id, b);
      if (legs.length) await tx.insert(bookingLegs).values(legs);
      return bk;
    });
  }

  async get(id: string): Promise<Booking | null> {
    const [row] = await this.db.select().from(bookings).where(eq(bookings.id, id));
    return row ? this.assemble(row) : null;
  }

  async promoUsage(codeId: string, now: Date): Promise<{ paid: number; held: number }> {
    return this.db.transaction((tx) => this.countUses(tx, codeId, now));
  }

  async promoBookings(codeId: string, now: Date): Promise<PromoBookingUse[]> {
    const rows = await this.db
      .select({
        id: bookings.id,
        reference: bookings.reference,
        status: bookings.status,
        discountTotal: bookings.discountTotal,
        createdAt: bookings.createdAt,
        promoHoldUntil: bookings.promoHoldUntil,
        hasSucceededPayment: sql<boolean>`${this.succeededPayment()}`,
      })
      .from(bookings)
      .where(eq(bookings.promoCodeId, codeId))
      .orderBy(desc(bookings.createdAt));
    return rows.map((r) => ({
      bookingId: r.id,
      reference: r.reference,
      status: r.status as BookingStatus,
      discountCents: r.discountTotal ?? 0,
      createdAt: r.createdAt.toISOString(),
      use: promoUseState(
        { status: r.status as BookingStatus, promoHoldUntil: r.promoHoldUntil, hasSucceededPayment: r.hasSucceededPayment === true },
        now,
      ),
    }));
  }

  async reholdPromo(bookingId: string, code: PromoCode, now: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(promoCodes).where(eq(promoCodes.id, code.id)).for('update');
      if (!locked) throw new PromoCodeRefusedError('promo_code_invalid');
      const [bk] = await tx
        .select({ promoCodeId: bookings.promoCodeId, promoHoldUntil: bookings.promoHoldUntil })
        .from(bookings)
        .where(eq(bookings.id, bookingId));
      if (!bk) throw new BookingNotFoundError(bookingId);
      if (bk.promoCodeId !== code.id) throw new Error('PROMO_CODE_MISMATCH');
      const holdValid = bk.promoHoldUntil !== null && bk.promoHoldUntil.getTime() > now.getTime();
      if (!holdValid) {
        const fresh = toPromoCode(locked);
        const unavailable = promoCodeAvailability(fresh, now);
        if (unavailable) throw new PromoCodeRefusedError(unavailable);
        const { paid, held } = await this.countUses(tx, fresh.id, now);
        if (paid + held >= fresh.maxUses) throw new PromoCodeRefusedError('promo_code_used_up');
      }
      await tx
        .update(bookings)
        .set({ promoHoldUntil: new Date(now.getTime() + PROMO_HOLD_MS) })
        .where(eq(bookings.id, bookingId));
    });
  }

  async findByIdempotencyKey(key: string): Promise<Booking | null> {
    const [row] = await this.db.select().from(bookings).where(eq(bookings.idempotencyKey, key));
    return row ? this.assemble(row) : null;
  }

  async findByReference(reference: string): Promise<Booking | null> {
    const [row] = await this.db.select().from(bookings).where(eq(bookings.reference, reference));
    return row ? this.assemble(row) : null;
  }

  // person_key is the generated lower(btrim(email)) column, indexed (0032). One query for the
  // rows, then the same batched assembly list() uses.
  async listByPersonKey(personKey: string, limit: number): Promise<Booking[]> {
    const rows = await this.db
      .select({ b: bookings })
      .from(bookings)
      .innerJoin(customers, eq(customers.id, bookings.customerId))
      .where(eq(customers.personKey, personKey))
      .orderBy(desc(bookings.createdAt))
      .limit(limit);
    return this.assembleMany(rows.map((r) => r.b));
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
    return this.assembleMany(rows);
  }
}
