import type { Booking } from '../db/bookingRepo';
import type { EmailAdapter } from '../adapters/email';

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export async function sendBookingConfirmation(
  booking: Booking,
  email: EmailAdapter,
): Promise<void> {
  const customer = booking.input.customer;
  const amount = money(booking.total, booking.currency);
  const route =
    booking.mode === 'trip'
      ? booking.input.stops.join(' → ')
      : `${booking.input.from} → ${booking.input.to}`;

  await email.send({
    to: customer.email,
    subject: `Your Ceylon Hop booking ${booking.reference}`,
    html:
      `<p>Hi ${customer.name},</p>` +
      `<p>Your trip <b>${route}</b> is booked.</p>` +
      `<p>Reference: <b>${booking.reference}</b><br>Total paid: <b>${amount}</b></p>` +
      `<p>Our team will message you on WhatsApp to confirm your pickup. See you on board.</p>`,
  });
}
