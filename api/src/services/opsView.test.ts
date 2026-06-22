import { describe, it, expect } from 'vitest';
import { toOpsRow, manifestLine } from './opsView';
import type { Booking } from '../db/bookingRepo';

const base: Booking = {
  mode: 'single', id: 'b1', reference: 'CH-AAA11', status: 'paid', createdAt: '2026-06-21T00:00:00Z',
  total: 12100, currency: 'USD',
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
});
