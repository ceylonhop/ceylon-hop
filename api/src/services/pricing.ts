import type { SingleTransferInput } from '../domain/singleTransfer';

// TODO: replace with the real engine reading the active rate_card (spec §6).
// This is a deterministic placeholder so the booking flow can be built end-to-end now.
const BASE_CENTS = 4000;
const PER_EXTRA_ADULT_CENTS = 1000;
const VAN_SURCHARGE_CENTS = 2000;

export function quoteSingleTransfer(input: SingleTransferInput): {
  currency: string;
  total: number;
} {
  const extraAdults = Math.max(0, input.adults - 1);
  let total = BASE_CENTS + extraAdults * PER_EXTRA_ADULT_CENTS;
  if (input.vehicleType === 'van') total += VAN_SURCHARGE_CENTS;
  return { currency: 'USD', total };
}
