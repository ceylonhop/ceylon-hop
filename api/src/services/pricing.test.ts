import { describe, it, expect } from 'vitest';
import { quoteSingleTransfer, quoteTrip } from './pricing';
import type { SingleTransferInput } from '../domain/singleTransfer';
import type { TripInput } from '../domain/trip';

const base: SingleTransferInput = {
  from: 'A',
  to: 'B',
  vehicleType: 'car',
  adults: 1,
  children: 0,
  bags: 0,
  customer: { name: 'Maya', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

describe('quoteSingleTransfer (stub)', () => {
  it('prices a car for one adult at the base', () => {
    expect(quoteSingleTransfer(base)).toEqual({ currency: 'USD', total: 4000 });
  });

  it('adds per-extra-adult', () => {
    expect(quoteSingleTransfer({ ...base, adults: 3 }).total).toBe(6000);
  });

  it('adds the van surcharge', () => {
    expect(quoteSingleTransfer({ ...base, vehicleType: 'van', adults: 2 }).total).toBe(7000);
  });

  it('is deterministic', () => {
    expect(quoteSingleTransfer(base)).toEqual(quoteSingleTransfer(base));
  });
});

const trip: TripInput = {
  stops: ['Colombo Airport', 'Sigiriya', 'Ella'],
  nights: [1, 2, 0],
  pax: 2,
  vehicleType: 'car',
  serviceType: 'private',
  customer: { name: 'Maya', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

describe('quoteTrip (stub)', () => {
  it('prices private per inter-city leg', () => {
    // 3 stops = 2 legs × 5000 (car)
    expect(quoteTrip(trip)).toEqual({ currency: 'USD', total: 10000 });
  });

  it('adds the van surcharge per leg', () => {
    expect(quoteTrip({ ...trip, vehicleType: 'van' }).total).toBe(12000); // 2 × 6000
  });

  it('prices chauffeur per day (nights + 1)', () => {
    // nights 1+2+0 = 3 -> 4 days × 5500
    expect(quoteTrip({ ...trip, serviceType: 'chauffeur' }).total).toBe(22000);
  });
});
