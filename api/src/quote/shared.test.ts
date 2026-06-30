import { describe, it, expect } from 'vitest';
import { quoteSharedLegs } from './shared';

describe('quoteSharedLegs', () => {
  it('seat price × seats (Arvid Negombo→Sigiriya 2 seats @ $19 = $38)', () => {
    const r = quoteSharedLegs([{ routeId: 'negombo->sigiriya', seats: 2, seatPriceCents: 1900 }]);
    expect(r.subtotalCents).toBe(3800);
  });
  it('adds the $3/seat Colombo pickup surcharge (Hakan 1 seat @ $19 + $3 = $22)', () => {
    const r = quoteSharedLegs([
      { routeId: 'negombo->sigiriya', seats: 1, seatPriceCents: 1900, colomboPickup: true },
    ]);
    expect(r.subtotalCents).toBe(2200);
    expect(r.lineItems).toHaveLength(2);
  });
});
