import type { SingleTransferInput } from '../domain/singleTransfer';
import type { TripInput } from '../domain/trip';

// TODO: replace with the real engine reading the active rate_card (spec §6).
// These are deterministic placeholders so the booking flow can be built end-to-end now.
const BASE_CENTS = 4000;
const PER_EXTRA_ADULT_CENTS = 1000;
const VAN_SURCHARGE_CENTS = 2000;
const LEG_BASE_CENTS = 5000;
const LEG_VAN_SURCHARGE_CENTS = 1000;
const CHAUFFEUR_DAY_CENTS = 5500;

export function quoteSingleTransfer(input: SingleTransferInput): {
  currency: string;
  total: number;
} {
  const extraAdults = Math.max(0, input.adults - 1);
  let total = BASE_CENTS + extraAdults * PER_EXTRA_ADULT_CENTS;
  if (input.vehicleType === 'van') total += VAN_SURCHARGE_CENTS;
  return { currency: 'USD', total };
}

export function quoteTrip(input: TripInput): { currency: string; total: number } {
  // Chauffeur is billed per day (nights + 1); private is billed per inter-city leg.
  if (input.serviceType === 'chauffeur') {
    const nights = input.nights.reduce((a, b) => a + b, 0);
    return { currency: 'USD', total: (nights + 1) * CHAUFFEUR_DAY_CENTS };
  }
  const legs = Math.max(0, input.stops.length - 1);
  const perLeg = LEG_BASE_CENTS + (input.vehicleType === 'van' ? LEG_VAN_SURCHARGE_CENTS : 0);
  return { currency: 'USD', total: legs * perLeg };
}

// A shared seat is priced from the corridor's per-seat price × the number of seats.
export function quoteShared(seats: number, seatPriceCents: number): {
  currency: string;
  total: number;
} {
  return { currency: 'USD', total: seats * seatPriceCents };
}
