import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');

describe('customer confirmation promises', () => {
  it('waits for server-confirmed payment before showing a booking confirmation', () => {
    // Since 2026-09-24 a real-gateway website payment hands the browser to PayHere and comes back
    // to the booking's manage page (booking-page-redirect.test.js); THAT page asks our server,
    // which the webhook owns, before it says the booking is paid. booking.js's gateway hand-off
    // must never reach the on-page confirmation.
    const js = read('booking.js');
    const handoff = js.slice(js.indexOf('function redirectToPayHere('), js.indexOf('function redirectToPayHere(') + 2000);
    // The form POST itself is checkout-handoff.js's chSubmitToGateway (shared with manage.html).
    expect(handoff).toContain('chSubmitToGateway(checkout)');
    expect(handoff.slice(0, handoff.indexOf('chSubmitToGateway(checkout)'))).not.toMatch(/finalizeBooking/);
    const manage = read('manage.html');
    expect(manage).toContain('/bookings/pay-return?rt=');
    expect(manage).toMatch(/x\.status === 'paid'/);
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
