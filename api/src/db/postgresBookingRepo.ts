import { and, asc, desc, eq, exists, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import {
  customers,
  bookings,
  transferRequests,
  tripRequests,
  sharedRequests,
  bookingLegs,
  payments,
  promoCodes,
  quotes,
  bookingStatusEvents,
} from './schema';
import { chosenAddOns, type PaySelection } from '../quote/paySelection';
import type { RouteVariant } from '../quote/routeChoice';
import {
  type BookingRepo,
  type NewBooking,
  type Booking,
  type BookingChannel,
  type StatusAudit,
  type PromoHold,
  type PromoBookingUse,
  type BookingStatusEvent,
  type BookingStatusEventMismatch,
  type WebsitePricingSnapshot,
  BookingNotFoundError,
  BookingTransitionContextRequiredError,
  generateReference,
  snapshotAddOns,
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
import type { BookingTransitionContext } from '../domain/trackingContract';

type BookingRow = typeof bookings.$inferSelect;
type BookingStatusEventRow = typeof bookingStatusEvents.$inferSelect;
export type BookingTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface PostgresBookingRepoOptions {
  transitionTrackingEnabled?: boolean;
}

export async function applyBookingStatusTransition(
  tx: BookingTransaction,
  input: {
    id: string;
    to: BookingStatus;
    audit?: StatusAudit;
    context?: BookingTransitionContext;
    transitionTrackingEnabled?: boolean;
  },
): Promise<BookingRow> {
  const [row] = await tx.select().from(bookings).where(eq(bookings.id, input.id));
  if (!row) throw new BookingNotFoundError(input.id);
  const from = row.status as BookingStatus;
  assertTransition(from, input.to);
  if (input.transitionTrackingEnabled && !input.context) {
    throw new BookingTransitionContextRequiredError();
  }

  const [moved] = await tx
    .update(bookings)
    .set({
      status: input.to,
      ...(input.to === 'cancelled' && input.audit
        ? {
            cancellationReason: input.audit.reason,
            cancelledBy: input.audit.by,
            cancelledAt: input.audit.at ?? new Date(),
          }
        : {}),
    })
    .where(and(eq(bookings.id, input.id), eq(bookings.status, from)))
    .returning();
  if (!moved) {
    const [current] = await tx.select().from(bookings).where(eq(bookings.id, input.id));
    throw new IllegalTransitionError((current?.status as BookingStatus) ?? from, input.to);
  }

  if (input.transitionTrackingEnabled && input.context) {
    await tx.insert(bookingStatusEvents).values({
      bookingId: input.id,
      fromStatus: from,
      toStatus: input.to,
      source: input.context.source,
      actorType: input.context.actorType,
      actorId: input.context.actorId ?? null,
      reason: input.context.reason ?? input.audit?.reason ?? null,
      requestId: input.context.requestId ?? null,
      runId: input.context.runId ?? null,
      relatedEntityType: input.context.relatedEntityType ?? null,
      relatedEntityId: input.context.relatedEntityId ?? null,
    });
  }
  return moved;
}

function buildStatusEvent(row: BookingStatusEventRow): BookingStatusEvent {
  return {
    id: row.id,
    bookingId: row.bookingId,
    fromStatus: row.fromStatus as BookingStatus,
    toStatus: row.toStatus as BookingStatus,
    source: row.source as BookingStatusEvent['source'],
    actorType: row.actorType as BookingStatusEvent['actorType'],
    actorId: row.actorId,
    reason: row.reason,
    requestId: row.requestId,
    runId: row.runId,
    relatedEntityType: row.relatedEntityType as BookingStatusEvent['relatedEntityType'],
    relatedEntityId: row.relatedEntityId,
    occurredAt: row.occurredAt.toISOString(),
  };
}

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
    customerNotes: row.customerNotes,
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
        // Undefined, not null, when the row never recorded any — so an old booking's shape is
        // byte-identical (0061_route_variant is additive/nullable, no backfill).
        ...(tr.routeVariants ? { routeVariants: tr.routeVariants as RouteVariant[] } : {}),
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
      // Undefined, not null, when the row never recorded one — so an old booking's shape is
      // byte-identical (0061_route_variant is additive/nullable, no backfill).
      ...(t.routeVariant ? { routeVariant: t.routeVariant as RouteVariant } : {}),
      customer,
    },
  };
}

export class PostgresBookingRepo implements BookingRepo {
  constructor(
    private readonly db: Db,
    private readonly options: PostgresBookingRepoOptions = {},
  ) {}

  // SQL twin of promoUseState() (domain/promoCode.ts); bookingPromo.test.ts holds both to the same cases.
  private succeededPayment() {
    return exists(
      this.db
        .select({ one: sql`1` })
        .from(payments)
        .where(and(eq(payments.bookingId, bookings.id), eq(payments.status, 'succeeded'))),
    );
  }

  private async countUses(tx: BookingTransaction, codeId: string, now: Date): Promise<{ paid: number; held: number }> {
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
  private async takeUse(tx: BookingTransaction, codeId: string, now: Date): Promise<PromoCode> {
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
    const promoIds = [...new Set(rows.flatMap((r) => (r.promoCodeId ? [r.promoCodeId] : [])))];
    const [trips, shareds, transfers, linkedQuotes, codes] = await Promise.all([
      tripIds.length ? this.db.select().from(tripRequests).where(inArray(tripRequests.bookingId, tripIds)) : [],
      sharedIds.length ? this.db.select().from(sharedRequests).where(inArray(sharedRequests.bookingId, sharedIds)) : [],
      singleIds.length ? this.db.select().from(transferRequests).where(inArray(transferRequests.bookingId, singleIds)) : [],
      // The add-ons live on the booking's quote as priced lines (same filter as
      // PostgresQuoteRepo.findByConvertedBookingId). Parallel with the rest: no extra round-trip.
      this.db
        .select({ bookingId: quotes.convertedBookingId, request: quotes.requestJson, result: quotes.resultJson, selection: quotes.payLinkSelection })
        .from(quotes)
        .where(and(inArray(quotes.convertedBookingId, rows.map((r) => r.id)), isNull(quotes.deletedAt))),
      // The promo codes' names, only when a booking here carried one — same round-trip as the rest.
      promoIds.length ? this.db.select({ id: promoCodes.id, code: promoCodes.code }).from(promoCodes).where(inArray(promoCodes.id, promoIds)) : [],
    ]);
    const codeBy = new Map(codes.map((c) => [c.id, c.code]));
    const tripBy = new Map(trips.map((t) => [t.bookingId, t]));
    const sharedBy = new Map(shareds.map((t) => [t.bookingId, t]));
    const transferBy = new Map(transfers.map((t) => [t.bookingId, t]));
    const addOnsBy = new Map(linkedQuotes.map((q) => [q.bookingId, chosenAddOns(q, q.selection as PaySelection | null)]));
    return rows.map((row) => {
      const cust = custById.get(row.customerId);
      if (!cust) throw new Error(`booking ${row.id}: customer ${row.customerId} missing`);
      const req = row.mode === 'trip' ? tripBy.get(row.id) : row.mode === 'shared' ? sharedBy.get(row.id) : transferBy.get(row.id);
      if (!req) throw new Error(`booking ${row.id}: ${row.mode} request row missing`);
      const built = build(row, cust, req);
      const promoCode = row.promoCodeId ? codeBy.get(row.promoCodeId) : undefined;
      const booking = promoCode ? { ...built, promoCode } : built;
      // The booking's quote names them; a website booking has none, so its own snapshot does.
      const fromQuote = addOnsBy.get(row.id);
      const addOns = fromQuote?.length ? fromQuote : snapshotAddOns(row.pricingSnapshotJson);
      return addOns.length ? { ...booking, addOns } : booking;
    });
  }

  async create(b: NewBooking, opts?: { idempotencyKey?: string; promo?: PromoHold; pricingSnapshot?: WebsitePricingSnapshot }): Promise<Booking> {
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

  private async insertBooking(b: NewBooking, opts?: { idempotencyKey?: string; promo?: PromoHold; pricingSnapshot?: WebsitePricingSnapshot }): Promise<BookingRow> {
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
          customerNotes: b.customerNotes ?? null,
          discountTotal: b.mode !== 'shared' && b.discountTotal !== undefined ? b.discountTotal : null,
          promoCodeId: opts?.promo ? opts.promo.code.id : null,
          promoHoldUntil: opts?.promo ? new Date(opts.promo.now.getTime() + PROMO_HOLD_MS) : null,
          pricingSnapshotJson: opts?.pricingSnapshot ?? null,
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
          routeVariants: t.routeVariants ?? null,
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
          routeVariant: t.routeVariant ?? null,
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
    details: { customer: SingleTransferInput['customer']; billing?: BillingInput; termsAcceptedAt?: Date; amountDueNow?: number },
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
      // The deposit-or-full choice (spec 2026-10-07 §4): rewritten only while no payment on the
      // booking has succeeded, decided inside this same statement so a settlement landing
      // concurrently cannot be undone. The status guard in the WHERE below covers the rest.
      if (details.amountDueNow !== undefined) {
        set.amountDueNow = sql`case when ${this.succeededPayment()} then ${bookings.amountDueNow} else ${details.amountDueNow}::integer end`;
      }
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

  async setStatus(
    id: string,
    to: BookingStatus,
    audit?: StatusAudit,
    context?: BookingTransitionContext,
  ): Promise<Booking> {
    const updated = await this.db.transaction((tx) => applyBookingStatusTransition(tx, {
      id, to, audit, context,
      transitionTrackingEnabled: this.options.transitionTrackingEnabled,
    }));
    return this.assemble(updated);
  }

  async listStatusEvents(bookingId: string): Promise<BookingStatusEvent[]> {
    const rows = await this.db
      .select()
      .from(bookingStatusEvents)
      .where(eq(bookingStatusEvents.bookingId, bookingId))
      .orderBy(
        asc(bookingStatusEvents.occurredAt),
        asc(bookingStatusEvents.id),
      );
    return rows.map(buildStatusEvent);
  }

  async listStatusEventsForBookingIds(bookingIds: string[]): Promise<BookingStatusEvent[]> {
    if (!bookingIds.length) return [];
    const rows = await this.db
      .select()
      .from(bookingStatusEvents)
      .where(inArray(bookingStatusEvents.bookingId, bookingIds))
      .orderBy(
        asc(bookingStatusEvents.occurredAt),
        asc(bookingStatusEvents.id),
      );
    return rows.map(buildStatusEvent);
  }

  async listStatusEventMismatches(): Promise<BookingStatusEventMismatch[]> {
    const latest = this.db
      .selectDistinctOn([bookingStatusEvents.bookingId], {
        bookingId: bookingStatusEvents.bookingId,
        eventStatus: bookingStatusEvents.toStatus,
      })
      .from(bookingStatusEvents)
      .orderBy(
        bookingStatusEvents.bookingId,
        desc(bookingStatusEvents.occurredAt),
        desc(bookingStatusEvents.id),
      )
      .as('latest_booking_status_event');
    const rows = await this.db
      .select({
        bookingId: bookings.id,
        currentStatus: bookings.status,
        eventStatus: latest.eventStatus,
      })
      .from(bookings)
      .innerJoin(latest, eq(bookings.id, latest.bookingId))
      .where(ne(bookings.status, latest.eventStatus))
      .orderBy(asc(bookings.id));
    return rows.map((row) => ({
      bookingId: row.bookingId,
      currentStatus: row.currentStatus as BookingStatus,
      eventStatus: row.eventStatus as BookingStatus,
    }));
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
