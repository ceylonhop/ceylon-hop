import { describe, it, expect } from 'vitest';
import { sendBookingConfirmation, sendCancellationConfirmation, sendRefundConfirmation } from './notifications';
import { FakeEmailAdapter } from '../adapters/email';
import type { Booking } from '../db/bookingRepo';

const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };

const single: Booking = {
  mode: 'single',
  id: 'id1',
  reference: 'CH-ABC12',
  status: 'paid',
  createdAt: new Date().toISOString(),
  total: 5000,
  currency: 'USD',
  input: { from: 'Colombo Airport', to: 'Ella', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer },
};

describe('sendBookingConfirmation — single transfer', () => {
  it('emails the customer with reference, route, vehicle, travellers and total — once', async () => {
    const email = new FakeEmailAdapter();
    await sendBookingConfirmation(single, email);
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m.to).toBe('maya@example.com');
    expect(m.subject).toContain('CH-ABC12');
    expect(m.subject.toLowerCase()).toContain('confirmed');
    expect(m.html).toContain('Colombo Airport');
    expect(m.html).toContain('Ella');
    expect(m.html).toContain('AC car');
    expect(m.html).toContain('2 adults');
    expect(m.html).toContain('$50.00');
  });

  it('includes a plain-text alternative mirroring the details', async () => {
    const email = new FakeEmailAdapter();
    await sendBookingConfirmation(single, email);
    const m = email.sent[0];
    expect(m.text).toBeTruthy();
    expect(m.text).toContain('CH-ABC12');
    expect(m.text).toContain('Colombo Airport → Ella');
    expect(m.text).toContain('$50.00');
    expect(m.text).not.toContain('<'); // genuinely plain text
  });

  it('shows "To confirm" when no date was set (flexible booking)', async () => {
    const email = new FakeEmailAdapter();
    await sendBookingConfirmation(single, email);
    expect(email.sent[0].html).toContain('To confirm');
  });

  it('formats a set date + time', async () => {
    const email = new FakeEmailAdapter();
    await sendBookingConfirmation({ ...single, input: { ...single.input, date: '2026-06-26', time: '09:00' } }, email);
    const m = email.sent[0];
    expect(m.html).toContain('26 Jun 2026');
    expect(m.html).toContain('09:00');
  });
});

describe('sendBookingConfirmation — trip (chauffeur)', () => {
  const trip: Booking = {
    mode: 'trip',
    id: 'id2',
    reference: 'CH-TRIP1',
    status: 'paid',
    createdAt: new Date().toISOString(),
    total: 60000,
    currency: 'USD',
    input: {
      stops: ['Colombo Airport', 'Kandy', 'Ella'],
      nights: [0, 2, 2],
      dates: ['2026-07-01', '2026-07-03'],
      pax: 3,
      vehicleType: 'van',
      serviceType: 'chauffeur',
      customer,
      days: 5,
      driverNights: 4,
    },
  };

  it('lists the stops, chauffeur service and the 10-day cancellation policy', async () => {
    const email = new FakeEmailAdapter();
    await sendBookingConfirmation(trip, email);
    const m = email.sent[0];
    // route is now a stop-by-stop timeline (each stop on its own row)
    expect(m.html).toContain('Colombo Airport');
    expect(m.html).toContain('Kandy');
    expect(m.html).toContain('Ella');
    expect(m.html).toContain('Chauffeur-guide');
    expect(m.html).toContain('From');
    expect(m.html).toContain('1 Jul 2026');
    expect(m.text).toContain('Colombo Airport → Kandy → Ella'); // text keeps the joined route
    expect(m.text).toContain('10 days');
  });
});

describe('sendBookingConfirmation — shared seat', () => {
  const shared: Booking = {
    mode: 'shared',
    id: 'id3',
    reference: 'CH-SHR01',
    status: 'paid',
    createdAt: new Date().toISOString(),
    total: 4000,
    currency: 'USD',
    input: { corridorId: 'cmb-galle', date: '2026-07-10', time: '08:00', seats: 2, customer },
  };

  it('shows shared service, seats and the fixed departure', async () => {
    const email = new FakeEmailAdapter();
    await sendBookingConfirmation(shared, email);
    const m = email.sent[0];
    expect(m.html).toContain('Shared ride');
    expect(m.html).toContain('10 Jul 2026');
    expect(m.html).toContain('08:00');
    expect(m.html).toContain('$40.00');
  });
});

describe('sendCancellationConfirmation', () => {
  it('emails the customer that the booking is cancelled, with reference + route — once', async () => {
    const email = new FakeEmailAdapter();
    await sendCancellationConfirmation(single, email);
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m.to).toBe('maya@example.com');
    expect(m.subject).toContain('CH-ABC12');
    expect(m.subject.toLowerCase()).toContain('cancel');
    expect(m.html.toLowerCase()).toContain('cancel');
    expect(m.html).toContain('Colombo Airport');
    expect(m.html).toContain('Ella');
  });

  it('includes a plain-text alternative with the reference and no markup', async () => {
    const email = new FakeEmailAdapter();
    await sendCancellationConfirmation(single, email);
    const m = email.sent[0];
    expect(m.text).toBeTruthy();
    expect(m.text).toContain('CH-ABC12');
    expect(m.text).not.toContain('<');
  });
});

describe('sendRefundConfirmation', () => {
  it('emails the customer that a refund was processed, with reference + amount — once', async () => {
    const email = new FakeEmailAdapter();
    await sendRefundConfirmation(single, email);
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m.to).toBe('maya@example.com');
    expect(m.subject).toContain('CH-ABC12');
    expect(m.subject.toLowerCase()).toContain('refund');
    expect(m.html.toLowerCase()).toContain('refund');
    expect(m.html).toContain('$50.00');
  });

  it('includes a plain-text alternative with the reference and no markup', async () => {
    const email = new FakeEmailAdapter();
    await sendRefundConfirmation(single, email);
    const m = email.sent[0];
    expect(m.text).toContain('CH-ABC12');
    expect(m.text).not.toContain('<');
  });
});
