import type {
  Booking,
  BookingPricingSnapshot,
  InMemoryBookingRepo,
  NewBooking,
} from './bookingRepo';
import type { InMemoryQuoteRepo, SavedQuote } from './quoteRepo';
import { SingleTransferInput, type CustomerInput } from '../domain/singleTransfer';
import { TripInput } from '../domain/trip';
import { quoteToBooking, QuoteNotBookableError } from '../quote/quoteToBooking';
import type { QuoteResult } from '../quote/types';
import {
  digestAccessToken,
  fingerprintIntent,
  safeDigestEqual,
  type WebQuoteIntent,
} from '../quote/webQuoteV2';

export type QuoteConversionErrorCode =
  | 'quote_access_denied'
  | 'quote_expired'
  | 'stale_revision'
  | 'quote_intent_mismatch'
  | 'quote_invalid';

export class QuoteConversionError extends Error {
  constructor(public readonly code: QuoteConversionErrorCode) {
    super(code);
    this.name = 'QuoteConversionError';
  }
}

export interface QuoteConversionRequest {
  quoteId: string;
  accessToken: string;
  revision: number;
  intent: WebQuoteIntent;
  bookingDetails: {
    customer: CustomerInput;
    date?: string;
    time?: string;
  };
}

export interface QuoteConversionOutcome {
  booking: Booking;
  replay: boolean;
}

export interface QuoteConversionRepo {
  convert(request: QuoteConversionRequest): Promise<QuoteConversionOutcome>;
}

export type QuoteConversionFailurePoint = 'after_booking_insert' | 'after_quote_update';

interface StoredQuoteResult {
  subtotalCents: number;
  totalCents: number;
  amountDueNowCents: number;
  currency: string;
  lineItems: unknown[];
}

function storedResult(quote: SavedQuote): StoredQuoteResult {
  const value = quote.result as Partial<QuoteResult> | null;
  if (
    !value ||
    !Number.isSafeInteger(value.subtotalCents) ||
    !Number.isSafeInteger(value.totalCents) ||
    !Number.isSafeInteger(value.amountDueNowCents) ||
    value.subtotalCents! < 0 ||
    value.totalCents! < 0 ||
    value.amountDueNowCents! < 0 ||
    value.amountDueNowCents! > value.totalCents! ||
    typeof value.currency !== 'string' ||
    !Array.isArray(value.lineItems) ||
    value.totalCents !== quote.totalCents ||
    value.currency !== quote.currency ||
    value.rateCardVersion !== quote.rateCardVersion
  ) {
    throw new QuoteConversionError('quote_invalid');
  }
  return value as StoredQuoteResult;
}

export function bookingFromLockedQuote(
  quote: SavedQuote,
  request: QuoteConversionRequest,
): { booking: NewBooking; snapshot: BookingPricingSnapshot } {
  const fingerprint = fingerprintIntent(request.intent);
  const storedRequest = quote.request as { v?: unknown; intent?: unknown; engine?: unknown } | null;
  if (
    !quote.intentFingerprint ||
    fingerprint !== quote.intentFingerprint ||
    fingerprintIntent(quote.intent) !== quote.intentFingerprint ||
    storedRequest?.v !== 2 ||
    fingerprintIntent(storedRequest.intent) !== quote.intentFingerprint ||
    !storedEngineMatchesIntent(storedRequest.engine, request.intent)
  ) {
    throw new QuoteConversionError('quote_intent_mismatch');
  }

  const expectedDate = request.intent.product === 'private' ? request.intent.date : undefined;
  const expectedTime = request.intent.product === 'private' ? request.intent.time : undefined;
  if (
    request.bookingDetails.date !== expectedDate ||
    request.bookingDetails.time !== expectedTime
  ) {
    throw new QuoteConversionError('quote_intent_mismatch');
  }

  const result = storedResult(quote);
  let mapped;
  try {
    mapped = quoteToBooking(quote, {
      customer: request.bookingDetails.customer,
      vehicleType: request.intent.vehicle,
      pax: request.intent.pax,
      bags: request.intent.bags,
      date: expectedDate,
      time: expectedTime,
    });
  } catch (error) {
    if (error instanceof QuoteNotBookableError) {
      throw new QuoteConversionError('quote_invalid');
    }
    throw error;
  }

  const parsedInput =
    mapped.mode === 'single'
      ? SingleTransferInput.safeParse(mapped.input)
      : TripInput.safeParse(mapped.input);
  if (!parsedInput.success) throw new QuoteConversionError('quote_invalid');

  const booking: NewBooking =
    mapped.mode === 'single'
      ? {
          mode: 'single',
          input: parsedInput.data as typeof mapped.input,
          total: result.totalCents,
          amountDueNow: result.amountDueNowCents,
          currency: result.currency,
          distanceKm: mapped.distanceKm,
          channel: 'website',
          needsPricing: false,
        }
      : {
          mode: 'trip',
          input: parsedInput.data as typeof mapped.input,
          total: result.totalCents,
          amountDueNow: result.amountDueNowCents,
          currency: result.currency,
          distanceKm: mapped.distanceKm,
          channel: 'website',
          needsPricing: false,
        };

  return {
    booking,
    snapshot: {
      version: 1,
      quoteId: quote.id,
      quoteRevision: quote.revision,
      intentFingerprint: fingerprint,
      subtotalCents: result.subtotalCents,
      // SH5 has no promotion/discount input. Price finishing is already represented by the
      // stored line items/result and must not be mislabeled as a discount.
      discountTotalCents: 0,
      totalCents: result.totalCents,
      amountDueNowCents: result.amountDueNowCents,
      currency: result.currency,
      rateCardVersion: quote.rateCardVersion,
      lineItems: structuredClone(result.lineItems),
    },
  };
}

function storedEngineMatchesIntent(engineValue: unknown, intent: WebQuoteIntent): boolean {
  if (!engineValue || typeof engineValue !== 'object') return false;
  const engine = engineValue as Record<string, unknown>;
  if (
    engine.product !== intent.product ||
    engine.vehicle !== intent.vehicle ||
    engine.pax !== intent.pax ||
    engine.bags !== intent.bags
  ) {
    return false;
  }
  if (intent.product === 'private') {
    const legs = engine.legs;
    return (
      Array.isArray(legs) &&
      legs.length === intent.legs.length &&
      legs.every((leg, index) => {
        if (!leg || typeof leg !== 'object') return false;
        const row = leg as Record<string, unknown>;
        return row.from === intent.legs[index].from && row.to === intent.legs[index].to;
      })
    );
  }
  const days = engine.travelDays;
  return (
    engine.firstDate === intent.firstDate &&
    engine.lastDate === intent.lastDate &&
    Array.isArray(days) &&
    days.length === intent.travelDays.length &&
    days.every((day, index) => {
      if (!day || typeof day !== 'object') return false;
      const row = day as Record<string, unknown>;
      const expected = intent.travelDays[index];
      return row.date === expected.date && row.from === expected.from && row.to === expected.to;
    })
  );
}

export class InMemoryQuoteConversionRepo implements QuoteConversionRepo {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly quotes: InMemoryQuoteRepo,
    private readonly bookings: InMemoryBookingRepo,
    private readonly now: () => Date = () => new Date(),
    private readonly failAt?: (point: QuoteConversionFailurePoint) => void,
  ) {}

  async convert(request: QuoteConversionRequest): Promise<QuoteConversionOutcome> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.convertAtomically(request);
    } finally {
      release();
    }
  }

  private async convertAtomically(
    request: QuoteConversionRequest,
  ): Promise<QuoteConversionOutcome> {
    const quote = await this.quotes.get(request.quoteId);
    const suppliedDigest = digestAccessToken(request.accessToken);
    if (
      !quote ||
      quote.channel !== 'web' ||
      !quote.accessTokenDigest ||
      !safeDigestEqual(quote.accessTokenDigest, suppliedDigest)
    ) {
      throw new QuoteConversionError('quote_access_denied');
    }
    if (quote.revision !== request.revision) {
      throw new QuoteConversionError('stale_revision');
    }

    const material = bookingFromLockedQuote(quote, request);
    if (quote.convertedBookingId) {
      const existing = await this.bookings.get(quote.convertedBookingId);
      if (!existing) throw new QuoteConversionError('quote_invalid');
      return { booking: existing, replay: true };
    }
    if (!quote.rateLockedUntil || quote.rateLockedUntil <= this.now()) {
      throw new QuoteConversionError('quote_expired');
    }

    const bookingSnapshot = this.bookings.snapshotForQuoteConversion();
    const quoteSnapshot = this.quotes.snapshotForQuoteConversion();
    try {
      const booking = await this.bookings.create(material.booking, {
        idempotencyKey: `quote-v2:${quote.id}`,
      });
      this.bookings.setPricingSnapshotForQuoteConversion(booking.id, material.snapshot);
      this.failAt?.('after_booking_insert');
      const updated = await this.quotes.patch(quote.id, {
        convertedBookingId: booking.id,
        status: 'won',
      });
      if (!updated) throw new QuoteConversionError('quote_invalid');
      this.failAt?.('after_quote_update');
      return { booking, replay: false };
    } catch (error) {
      this.bookings.restoreForQuoteConversion(bookingSnapshot);
      this.quotes.restoreForQuoteConversion(quoteSnapshot);
      throw error;
    }
  }
}
