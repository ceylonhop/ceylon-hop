import { describe, expect, it } from 'vitest';
import { FakeEmailAdapter } from '../adapters/email';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import {
  sendBookingConfirmation,
  sendBookingConfirmed,
  sendCancellationConfirmation,
  sendDepositReceived,
  sendDetailsNeeded,
  sendNoShowNotice,
  sendPaymentFailed,
  sendPaymentIncomplete,
  sendRefundConfirmation,
  sendReviewRequest,
  sendTripReminder,
} from './notifications';

describe('booking email tracking metadata', () => {
  it('marks every in-scope booking email with the frozen kind and a stable logical key', async () => {
    const bookings = new InMemoryBookingRepo();
    const booking = await bookings.create({
      mode: 'single', total: 10_000, amountDueNow: 10_000, currency: 'USD',
      input: {
        from: 'Colombo', to: 'Kandy', vehicleType: 'car', adults: 2, children: 0, bags: 1,
        customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+94770000000', country: 'LK' },
      },
    });
    const email = new FakeEmailAdapter();

    await sendBookingConfirmation(booking, email);
    await sendCancellationConfirmation(booking, email);
    await sendRefundConfirmation(booking, email);
    await sendTripReminder(booking, email);
    await sendReviewRequest(booking, email);
    await sendPaymentIncomplete(booking, email);
    await sendPaymentFailed(booking, email);
    await sendDepositReceived(booking, email);
    await sendBookingConfirmed(booking, email);
    await sendNoShowNotice(booking, email);
    await sendDetailsNeeded(booking, email);

    expect(email.sent.map((message) => message.tracking?.kind)).toEqual([
      'confirmation', 'cancellation', 'refund', 'trip_reminder', 'review_request',
      'payment_recovery', 'payment_failed', 'deposit_received', 'booking_confirmed',
      'no_show_notice', 'details_needed',
    ]);
    expect(email.sent.every((message) =>
      message.tracking?.bookingId === booking.id &&
      message.tracking.templateKey.length > 0 &&
      message.tracking.templateVersion.length > 0 &&
      message.tracking.trackingKey.startsWith(`${booking.id}:`),
    )).toBe(true);
  });
});
