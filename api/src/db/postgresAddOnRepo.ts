import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from './client';
import { bookingAddOnRequests, bookingAddOns, bookingLegs, bookings, payments } from './schema';
import {
  AddOnError,
  addOnCancelRefusal,
  addOnRequestStands,
  compareAddOnLines,
  hasDuplicateAddOn,
  type AddOnLine,
  type AddOnRepo,
  type AddOnRequest,
  type StoredLeg,
} from './addOnRepo';
import type { AddOnRequestStatus } from '../domain/addOns';

type Reader = Pick<Db, 'select'>;
type RequestRow = typeof bookingAddOnRequests.$inferSelect;

const toRequest = (row: RequestRow, lines: AddOnLine[]): AddOnRequest => ({
  ...row,
  status: row.status as AddOnRequestStatus,
  lines,
});

// Each request's lines, in leg order then by code: the lines table keeps no order of its own.
async function linesFor(db: Reader, requestIds: string[]): Promise<Map<string, AddOnLine[]>> {
  const out = new Map<string, AddOnLine[]>();
  if (requestIds.length === 0) return out;
  const rows = await db
    .select({
      id: bookingAddOns.id,
      requestId: bookingAddOns.requestId,
      bookingId: bookingAddOns.bookingId,
      legId: bookingAddOns.legId,
      code: bookingAddOns.code,
      label: bookingAddOns.label,
      amountCents: bookingAddOns.amountCents,
      legSeq: bookingLegs.seq,
    })
    .from(bookingAddOns)
    .innerJoin(bookingLegs, eq(bookingLegs.id, bookingAddOns.legId))
    .where(inArray(bookingAddOns.requestId, requestIds));
  for (const row of rows.sort(compareAddOnLines)) {
    const line: AddOnLine = {
      id: row.id, requestId: row.requestId, bookingId: row.bookingId, legId: row.legId,
      code: row.code, label: row.label, amountCents: row.amountCents,
    };
    out.set(line.requestId, [...(out.get(line.requestId) ?? []), line]);
  }
  return out;
}

async function withLines(db: Reader, rows: RequestRow[]): Promise<AddOnRequest[]> {
  const lines = await linesFor(db, rows.map((row) => row.id));
  return rows.map((row) => toRequest(row, lines.get(row.id) ?? []));
}

export class PostgresAddOnRepo implements AddOnRepo {
  constructor(private readonly db: Db) {}

  async listLegs(bookingId: string): Promise<StoredLeg[]> {
    return this.db
      .select({
        id: bookingLegs.id,
        seq: bookingLegs.seq,
        kind: bookingLegs.kind,
        from: bookingLegs.fromPlace,
        to: bookingLegs.toPlace,
        viaStops: bookingLegs.viaStops,
        travelDate: bookingLegs.travelDate,
      })
      .from(bookingLegs)
      .where(and(eq(bookingLegs.bookingId, bookingId), isNull(bookingLegs.removedAt)))
      .orderBy(bookingLegs.seq);
  }

  async createRequest(input: {
    bookingId: string;
    lines: Array<{ legId: string; code: string; label: string; amountCents: number }>;
    currency: string;
    rateCardVersion: string;
    createdBy: string;
    now: Date;
    fullyRefundedPaymentIds: string[];
  }): Promise<AddOnRequest> {
    return this.db.transaction(async (tx) => {
      // The booking row lock is what makes "one of each add-on per leg" and the per-booking seq
      // safe: two staff sending at once serialise here, and the second reads the first's request.
      const [booking] = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(eq(bookings.id, input.bookingId))
        .for('update');
      if (!booking) throw new AddOnError('booking_not_found');
      const existing = await tx
        .select({
          id: bookingAddOnRequests.id,
          seq: bookingAddOnRequests.seq,
          status: bookingAddOnRequests.status,
          paymentId: bookingAddOnRequests.paymentId,
        })
        .from(bookingAddOnRequests)
        .where(eq(bookingAddOnRequests.bookingId, input.bookingId));
      const standingIds = existing
        .filter((r) => addOnRequestStands(r, input.fullyRefundedPaymentIds))
        .map((r) => r.id);
      const standing = standingIds.length
        ? await tx
            .select({ legId: bookingAddOns.legId, code: bookingAddOns.code })
            .from(bookingAddOns)
            .where(inArray(bookingAddOns.requestId, standingIds))
        : [];
      if (hasDuplicateAddOn(input.lines, standing)) throw new AddOnError('duplicate_add_on');
      const [row] = await tx
        .insert(bookingAddOnRequests)
        .values({
          bookingId: input.bookingId,
          seq: existing.reduce((max, r) => Math.max(max, r.seq), 0) + 1,
          status: 'open',
          totalCents: input.lines.reduce((sum, line) => sum + line.amountCents, 0),
          currency: input.currency,
          rateCardVersion: input.rateCardVersion,
          createdBy: input.createdBy,
          createdAt: input.now,
        })
        .returning();
      await tx
        .insert(bookingAddOns)
        .values(input.lines.map((line) => ({ ...line, requestId: row.id, bookingId: input.bookingId })));
      const [request] = await withLines(tx, [row]);
      return request;
    });
  }

  async get(requestId: string): Promise<AddOnRequest | null> {
    const rows = await this.db.select().from(bookingAddOnRequests).where(eq(bookingAddOnRequests.id, requestId));
    const [request] = await withLines(this.db, rows);
    return request ?? null;
  }

  async listByBooking(bookingId: string): Promise<AddOnRequest[]> {
    const rows = await this.db
      .select()
      .from(bookingAddOnRequests)
      .where(eq(bookingAddOnRequests.bookingId, bookingId))
      .orderBy(bookingAddOnRequests.seq);
    return withLines(this.db, rows);
  }

  async listByBookingIds(bookingIds: string[]): Promise<Map<string, AddOnRequest[]>> {
    const out = new Map<string, AddOnRequest[]>(bookingIds.map((id) => [id, []]));
    if (bookingIds.length === 0) return out;
    const rows = await this.db
      .select()
      .from(bookingAddOnRequests)
      .where(inArray(bookingAddOnRequests.bookingId, bookingIds))
      .orderBy(bookingAddOnRequests.seq);
    for (const request of await withLines(this.db, rows)) out.get(request.bookingId)?.push(request);
    return out;
  }

  async cancel(
    requestId: string,
    input: { by: string; reason: string; now: Date; inFlightAfter: Date },
  ): Promise<AddOnRequest> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(bookingAddOnRequests)
        .where(eq(bookingAddOnRequests.id, requestId))
        .for('update');
      if (!row) throw new AddOnError('request_not_found');
      const refusal = addOnCancelRefusal(row.status);
      if (refusal) throw new AddOnError(refusal);
      // A PayHere form cannot be recalled once open, and an abandoned one may never report a
      // failure, so the lock is time-bound: only an attempt after `inFlightAfter` holds it.
      if (row.paymentId) {
        const [payment] = await tx
          .select({ status: payments.status, lastAttemptAt: payments.lastAttemptAt })
          .from(payments)
          .where(eq(payments.id, row.paymentId));
        if (payment?.status === 'pending' && payment.lastAttemptAt && payment.lastAttemptAt > input.inFlightAfter) {
          throw new AddOnError('payment_in_flight');
        }
      }
      const [cancelled] = await tx
        .update(bookingAddOnRequests)
        .set({ status: 'cancelled', cancelledBy: input.by, cancelledAt: input.now, cancelReason: input.reason })
        .where(eq(bookingAddOnRequests.id, row.id))
        .returning();
      const [request] = await withLines(tx, [cancelled]);
      return request;
    });
  }

  async attachPayment(requestId: string, paymentId: string): Promise<void> {
    const [set] = await this.db
      .update(bookingAddOnRequests)
      .set({ paymentId })
      .where(and(eq(bookingAddOnRequests.id, requestId), isNull(bookingAddOnRequests.paymentId)))
      .returning({ id: bookingAddOnRequests.id });
    if (set) return;
    const [row] = await this.db
      .select({ paymentId: bookingAddOnRequests.paymentId })
      .from(bookingAddOnRequests)
      .where(eq(bookingAddOnRequests.id, requestId));
    if (!row) throw new AddOnError('request_not_found');
    // One request is one payment, keyed on the request, so a different id here is a bug upstream.
    if (row.paymentId !== paymentId) throw new Error(`add_on_request_has_another_payment: ${requestId}`);
  }
}
