import { describe, it, expect } from 'vitest';
import { toOpsRow, manifestLine } from './opsView';
import type { Booking } from '../db/bookingRepo';

const base: Booking = {
  mode: 'single', id: 'b1', reference: 'CH-AAA11', status: 'paid', createdAt: '2026-06-21T00:00:00Z',
  total: 12100, currency: 'USD', channel: 'website',
  input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 1, bags: 2,
    date: '2026-06-22', time: '09:00',
    customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' } },
};

describe('opsView', () => {
  it('shapes a single-transfer row with route, pax and payment status', () => {
    const row = toOpsRow(base, { paid: true, rideOps: null });
    expect(row.route).toBe('Colombo Airport → Galle');
    expect(row.pax).toBe(3);
    expect(row.paymentStatus).toBe('paid');
    expect(row.fulfilmentStatus).toBe('unassigned'); // default when no ride_ops
    expect(row.customerFirstName).toBe('Maya');
  });
  it('marks unpaid bookings', () => {
    expect(toOpsRow({ ...base, status: 'payment_pending' }, { paid: false }).paymentStatus).toBe('unpaid');
  });
  it('manifestLine excludes money', () => {
    const line = manifestLine(base);
    expect(line).toContain('CH-AAA11');
    expect(line).toContain('09:00');
    expect(line).toContain('Colombo Airport → Galle');
    expect(line).not.toMatch(/\$|121|USD/);
  });

  it('carries ride_ops state (coordinator, status, flags) into the row', () => {
    const row = toOpsRow(base, {
      paid: true,
      rideOps: {
        bookingId: 'b1', coordinatorId: 'c1', fulfilmentStatus: 'vehicle_confirmed',
        vehiclePhotoReceived: true, customerUpdated: true, opsNotes: null,
        assignedAt: null, sentAt: null, acknowledgedAt: null, vehicleConfirmedAt: null, updatedAt: '',
      },
    });
    expect(row.coordinatorId).toBe('c1');
    expect(row.fulfilmentStatus).toBe('vehicle_confirmed');
    expect(row.vehiclePhotoReceived).toBe(true);
    expect(row.customerUpdated).toBe(true);
  });

  const trip: Booking = {
    mode: 'trip', id: 't1', reference: 'CH-TRIP1', status: 'paid', createdAt: '2026-06-21T00:00:00Z',
    total: 60000, currency: 'USD', channel: 'website',
    input: { stops: ['Colombo Airport', 'Kandy', 'Ella'], nights: [0, 2, 2], dates: ['2026-07-01', '2026-07-03'],
      pax: 4, vehicleType: 'van', serviceType: 'chauffeur',
      customer: { firstName: 'Sam', lastName: 'P', email: 's@x.com', whatsapp: '+1', country: 'US' } },
  };

  it('shapes a trip row (stops joined, pax, first dated leg)', () => {
    const row = toOpsRow(trip, { paid: true });
    expect(row.route).toBe('Colombo Airport → Kandy → Ella');
    expect(row.pax).toBe(4);
    expect(row.travelDate).toBe('2026-07-01');
    expect(row.travelTime).toBeNull();
    expect(manifestLine(trip)).toContain('TBC'); // no per-leg time → TBC
  });

  const shared: Booking = {
    mode: 'shared', id: 's1', reference: 'CH-SHR01', status: 'paid', createdAt: '2026-06-21T00:00:00Z',
    total: 4000, currency: 'USD', channel: 'website',
    input: { corridorId: 'cmb-galle', date: '2026-07-10', time: '08:00', seats: 3,
      customer: { firstName: 'Ana', lastName: 'R', email: 'a@x.com', whatsapp: '+2', country: 'PT' } },
  };

  it('shapes a shared row (corridor route, seats as pax, date/time)', () => {
    const row = toOpsRow(shared, { paid: true });
    expect(row.route).toBe('Shared · cmb-galle');
    expect(row.pax).toBe(3);
    expect(row.travelDate).toBe('2026-07-10');
    expect(row.travelTime).toBe('08:00');
    expect(manifestLine(shared)).toContain('08:00');
  });

  it('exposes booking channel on the ops row', () => {
    const row = toOpsRow({ ...base, channel: 'whatsapp' }, { paid: true });
    expect(row.channel).toBe('whatsapp');
  });
});
