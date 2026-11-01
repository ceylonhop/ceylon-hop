import { describe, it, expect } from 'vitest';
import { quoteSharedLegs } from './shared';

describe('quoteSharedLegs', () => {
  it('seat price × seats (Arvid Negombo→Sigiriya 2 seats @ $19 = $38)', () => {
    const r = quoteSharedLegs([{ routeId: 'negombo->sigiriya', seats: 2, seatPriceCents: 1900 }]);
    expect(r.subtotalCents).toBe(3800);
  });
});
