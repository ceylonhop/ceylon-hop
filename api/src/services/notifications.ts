import type { Booking } from '../db/bookingRepo';
import type { EmailAdapter } from '../adapters/email';

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export async function sendBookingConfirmation(
  booking: Booking,
  email: EmailAdapter,
): Promise<void> {
  const { reference, input, total, currency } = booking;
  const { customer, from, to } = input;
  const amount = money(total, currency);
  await email.send({
    to: customer.email,
    subject: `Your Ceylon Hop booking ${reference}`,
    html:
      `<p>Hi ${customer.name},</p>` +
      `<p>Your transfer <b>${from} → ${to}</b> is booked.</p>` +
      `<p>Reference: <b>${reference}</b><br>Total paid: <b>${amount}</b></p>` +
      `<p>Our team will message you on WhatsApp to confirm your exact pickup. See you on board.</p>`,
  });
}
