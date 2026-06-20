import { describe, it, expect } from 'vitest';
import { sendBookingConfirmation } from './notifications';
import { FakeEmailAdapter } from '../adapters/email';
import type { Booking } from '../db/bookingRepo';

const booking: Booking = {
  mode: 'single',
  id: 'id1',
  reference: 'CH-ABC12',
  status: 'paid',
  createdAt: new Date().toISOString(),
  total: 5000,
  currency: 'USD',
  input: {
    from: 'Colombo Airport',
    to: 'Ella',
    vehicleType: 'car',
    adults: 2,
    children: 0,
    bags: 2,
    customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
  },
};

describe('sendBookingConfirmation', () => {
  it('emails the customer with the reference, route and total — once', async () => {
    const email = new FakeEmailAdapter();
    await sendBookingConfirmation(booking, email);
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m.to).toBe('maya@example.com');
    expect(m.subject).toContain('CH-ABC12');
    expect(m.html).toContain('Colombo Airport');
    expect(m.html).toContain('Ella');
    expect(m.html).toContain('$50.00');
  });
});
