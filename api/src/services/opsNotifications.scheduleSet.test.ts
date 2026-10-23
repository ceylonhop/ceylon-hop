import { describe, it, expect } from 'vitest';
import { teamScheduleSetEmail } from './opsNotifications';
import type { Booking } from '../db/bookingRepo';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const customer = { firstName: 'Sam', lastName: 'Perera', email: 's@x.com', whatsapp: '+447700900000', country: 'GB' };
const booking = (date: string, time: string | undefined): Booking => ({
  mode: 'single', id: '11111111-1111-4111-8111-111111111111', reference: 'CH-K7Q2M', status: 'paid',
  createdAt: new Date().toISOString(), total: 12400, currency: 'USD', channel: 'website',
  input: { from: 'Colombo Airport (CMB)', to: 'Ella', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer, date, time },
} as Booking);

describe('teamScheduleSetEmail — the customer set their pickup on the manage page', () => {
  it('starts "Date set:" and names the booking, route and new pickup', () => {
    const m = teamScheduleSetEmail(booking(inDays(14), '09:00'), { date: null, time: null }, 'https://ops.example');
    expect(m.subject.startsWith('Date set: CH-K7Q2M — ')).toBe(true);
    expect(m.subject).toContain('Colombo Airport (CMB) → Ella');
    expect(m.subject).toContain('09:00');
    expect(m.subject).not.toContain('URGENT');
    expect(m.text).toContain('set it on their booking page');
    expect(m.text).toContain('was: no date, no time');
  });

  it('says URGENT when the pickup is tomorrow (Colombo)', () => {
    const m = teamScheduleSetEmail(booking(inDays(1), '20:00'), { date: null, time: null }, 'https://ops.example');
    expect(m.subject).toContain('URGENT');
    expect(m.html).toContain('URGENT');
  });

  it('names what was there before a time-only fill', () => {
    const m = teamScheduleSetEmail(booking(inDays(14), '09:00'), { date: inDays(14), time: null }, 'https://ops.example');
    expect(m.text).toContain('was: date set, no time');
  });
});
