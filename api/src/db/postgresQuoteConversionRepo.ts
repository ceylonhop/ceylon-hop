import { eq } from 'drizzle-orm';
import type { Db } from './client';
import {
  bookingLegs,
  bookings,
  customers,
  quotes,
  transferRequests,
  tripRequests,
} from './schema';
import {
  generateReference,
  type BookingPricingSnapshot,
  type BookingRepo,
  type NewBooking,
} from './bookingRepo';
import {
  bookingFromLockedQuote,
  QuoteConversionError,
  type QuoteConversionFailurePoint,
  type QuoteConversionOutcome,
  type QuoteConversionRepo,
  type QuoteConversionRequest,
} from './quoteConversionRepo';
import { quoteRowToSaved } from './postgresQuoteRepo';
import { digestAccessToken, safeDigestEqual } from '../quote/webQuoteV2';
import { isReferenceCollision, legRowsForBooking } from './postgresBookingRepo';

const MAX_REFERENCE_ATTEMPTS = 5;
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

export class PostgresQuoteConversionRepo implements QuoteConversionRepo {
  constructor(
    private readonly db: Db,
    private readonly bookingRepo: BookingRepo,
    private readonly now: () => Date = () => new Date(),
    private readonly failAt?: (
      point: QuoteConversionFailurePoint,
    ) => void | Promise<void>,
  ) {}

  async convert(request: QuoteConversionRequest): Promise<QuoteConversionOutcome> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_REFERENCE_ATTEMPTS; attempt++) {
      try {
        const result = await this.db.transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(quotes)
            .where(eq(quotes.id, request.quoteId))
            .for('update');
          const suppliedDigest = digestAccessToken(request.accessToken);
          if (
            !row ||
            row.deletedAt ||
            row.channel !== 'web' ||
            !row.accessTokenDigest ||
            !safeDigestEqual(row.accessTokenDigest, suppliedDigest)
          ) {
            throw new QuoteConversionError('quote_access_denied');
          }
          if (row.revision !== request.revision) {
            throw new QuoteConversionError('stale_revision');
          }

          const saved = quoteRowToSaved(row);
          const material = bookingFromLockedQuote(saved, request);
          if (row.convertedBookingId) {
            return { bookingId: row.convertedBookingId, replay: true };
          }
          if (!row.rateLockedUntil || row.rateLockedUntil <= this.now()) {
            throw new QuoteConversionError('quote_expired');
          }

          const bookingId = await insertLockedBooking(
            tx,
            material.booking,
            material.snapshot,
            `quote-v2:${row.id}`,
          );
          await this.failAt?.('after_booking_insert');
          const now = this.now();
          const [updated] = await tx
            .update(quotes)
            .set({
              convertedBookingId: bookingId,
              status: 'won',
              decidedAt: row.decidedAt ?? now,
              updatedAt: now,
            })
            .where(eq(quotes.id, row.id))
            .returning({ id: quotes.id });
          if (!updated) throw new QuoteConversionError('quote_invalid');
          await this.failAt?.('after_quote_update');
          return { bookingId, replay: false };
        });

        const booking = await this.bookingRepo.get(result.bookingId);
        if (!booking) throw new QuoteConversionError('quote_invalid');
        return { booking, replay: result.replay };
      } catch (error) {
        if (!isReferenceCollision(error)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }
}

async function insertLockedBooking(
  tx: Transaction,
  booking: NewBooking,
  snapshot: BookingPricingSnapshot,
  idempotencyKey: string,
): Promise<string> {
  const customer = booking.input.customer;
  const [customerRow] = await tx
    .insert(customers)
    .values({
      firstName: customer.firstName,
      // The column is NOT NULL and the schema now allows no surname (spec 2026-08-08) —
      // store the absence as empty, never as the string \"undefined\".
      lastName: customer.lastName ?? '',
      email: customer.email,
      phoneCountryCode: customer.phoneCountryCode ?? null,
      phoneNumber: customer.phoneNumber ?? null,
      whatsapp: customer.whatsapp,
      country: customer.country,
      marketingOptIn: customer.marketingOptIn ?? null,
    })
    .returning({ id: customers.id });
  const [bookingRow] = await tx
    .insert(bookings)
    .values({
      customerId: customerRow.id,
      reference: generateReference(),
      status: 'draft',
      mode: booking.mode,
      total: booking.total,
      subtotal: snapshot.subtotalCents,
      discountTotal: snapshot.discountTotalCents,
      pricingSnapshotJson: snapshot,
      amountDueNow: booking.amountDueNow,
      currency: booking.currency,
      idempotencyKey,
      channel: booking.channel ?? 'website',
      needsPricing: false,
    })
    .returning({ id: bookings.id });

  if (booking.mode === 'trip') {
    await tx.insert(tripRequests).values({
      bookingId: bookingRow.id,
      serviceType: booking.input.serviceType,
      pax: booking.input.pax,
      vehicleType: booking.input.vehicleType,
      stops: booking.input.stops,
      nights: booking.input.nights,
      dates: booking.input.dates ?? null,
      days: booking.input.days ?? null,
      driverNights: booking.input.driverNights ?? null,
    });
  } else if (booking.mode === 'single') {
    await tx.insert(transferRequests).values({
      bookingId: bookingRow.id,
      fromPlace: booking.input.from,
      toPlace: booking.input.to,
      travelDate: booking.input.date ?? null,
      travelTime: booking.input.time ?? null,
      vehicleType: booking.input.vehicleType,
      adults: booking.input.adults,
      children: booking.input.children,
      bags: booking.input.bags,
      distanceKm: booking.distanceKm ?? null,
      durationMin: booking.durationMin ?? null,
    });
  } else {
    throw new QuoteConversionError('quote_invalid');
  }

  const legs = legRowsForBooking(bookingRow.id, booking);
  if (legs.length) await tx.insert(bookingLegs).values(legs);
  return bookingRow.id;
}
