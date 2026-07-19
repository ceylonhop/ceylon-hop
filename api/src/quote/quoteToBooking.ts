import type { SavedQuote } from '../db/quoteRepo';
import type { QuoteRequest } from './types';
import type { SingleTransferInput, CustomerInput } from '../domain/singleTransfer';
import type { TripInput } from '../domain/trip';

// The booking fields the quote can't supply — collected by the ops "Mark booked" modal.
export interface BookingDetails {
  customer: CustomerInput;
  vehicleType: 'car' | 'van';
  pax: number;
  bags: number;
  date?: string;
  time?: string;
}

export type MappedBooking =
  | { mode: 'single'; input: SingleTransferInput; distanceKm: number | null }
  | { mode: 'trip'; input: TripInput; distanceKm: number | null };

// The quote has no bookable itinerary (shared, or a legacy row with no engine request).
export class QuoteNotBookableError extends Error {}

function sumKm(legs: { distanceKm: number }[]): number | null {
  if (!legs.length) return null;
  const total = legs.reduce((a, l) => a + (Number(l.distanceKm) || 0), 0);
  return total > 0 ? Math.round(total) : null;
}

// Inclusive day span between two ISO dates (e.g. 08-01..08-03 = 3 days).
function daySpan(firstDate: string, lastDate: string): number {
  const ms = Date.parse(lastDate) - Date.parse(firstDate);
  if (Number.isNaN(ms)) return 1;
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

// Map a stored ops quote's engine request + the modal details into a bookable input.
// Private single-leg → single; private multi-leg or chauffeur → trip. Shared / engine-less
// quotes throw (ops quotes are private/chauffeur; nothing else reaches this path).
export function quoteToBooking(quote: SavedQuote, details: BookingDetails): MappedBooking {
  const engine = (quote.request as { engine?: QuoteRequest } | null)?.engine;
  if (!engine || engine.product === 'shared') {
    throw new QuoteNotBookableError('quote has no bookable itinerary');
  }

  if (engine.product === 'private') {
    const legs = engine.legs;
    if (!legs.length) throw new QuoteNotBookableError('private quote has no legs');
    const distanceKm = sumKm(legs);
    if (legs.length === 1) {
      return {
        mode: 'single',
        distanceKm,
        input: {
          from: legs[0].from,
          to: legs[0].to,
          date: details.date,
          time: details.time,
          vehicleType: details.vehicleType,
          adults: details.pax,
          children: 0,
          bags: details.bags,
          customer: details.customer,
        },
      };
    }
    const stops = [legs[0].from, ...legs.map((l) => l.to)];
    return {
      mode: 'trip',
      distanceKm,
      input: {
        stops,
        nights: Array(Math.max(0, stops.length - 1)).fill(0),
        dates: details.date ? [details.date] : undefined,
        pax: details.pax,
        vehicleType: details.vehicleType,
        serviceType: 'private',
        customer: details.customer,
      },
    };
  }

  // chauffeur
  const days = [...engine.travelDays].sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length) throw new QuoteNotBookableError('chauffeur quote has no travel days');
  const span = daySpan(engine.firstDate, engine.lastDate);
  const stops = [days[0].from, ...days.map((d) => d.to)];
  return {
    mode: 'trip',
    distanceKm: sumKm(days),
    input: {
      stops,
      nights: Array(Math.max(0, stops.length - 1)).fill(0),
      dates: days.map((d) => d.date),
      pax: details.pax,
      vehicleType: details.vehicleType,
      serviceType: 'chauffeur',
      customer: details.customer,
      days: span,
      driverNights: Math.max(0, span - 1),
    },
  };
}
