import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');

describe('customer confirmation promises', () => {
  it('waits for server-confirmed payment before showing a booking confirmation', () => {
    const js = read('booking.js');
    expect(js).toContain('/bookings/pay-return?rt=');
    expect(js).toMatch(/payhere\.onCompleted\s*=\s*function\(\)\{\s*waitForPaymentConfirmation\(checkout, booking\)/);
    expect(js).not.toMatch(/payhere\.onCompleted\s*=\s*function\(\)\{[^}]*finalizeBooking/);
  });

  it('uses one honest WhatsApp and driver-details promise across customer surfaces', () => {
    const booking = read('booking.html');
    const sources = [
      booking,
      read('booking.js'),
      read('search.js'),
      read('pay.html'),
      read('quote.html'),
      read('manage.html'),
      read('about.html'),
      read('api/src/services/notifications.ts'),
    ].join('\n');

    expect(booking).toContain('Confirmation emailed after payment');
    expect(booking).toContain('Personal follow-up on WhatsApp');
    expect(sources).toContain('Your driver and vehicle details will be sent on WhatsApp before pickup.');
    expect(sources).not.toMatch(/Instant confirmation on WhatsApp|instant WhatsApp confirmation|usually reply in minutes|we reply fast|first thing in the morning|48 hours before pickup|2 days before pick-up|driver(?:&rsquo;|’)s details the evening before|driver(?:&rsquo;|’)s (?:name and vehicle|details) on WhatsApp shortly before pickup/i);
  });
});
