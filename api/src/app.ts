import { Hono } from 'hono';
import { InMemoryBookingRepo, type BookingRepo } from './db/bookingRepo';
import { InMemoryPaymentRepo, type PaymentRepo } from './db/paymentRepo';
import { FakeEmailAdapter, type EmailAdapter } from './adapters/email';
import { FakePaymentAdapter, type PaymentAdapter } from './adapters/payments';
import { bookingRoutes } from './routes/bookings';
import { webhookRoutes } from './routes/webhooks';

export interface AppDeps {
  bookings?: BookingRepo;
  payments?: PaymentRepo;
  email?: EmailAdapter;
  adapter?: PaymentAdapter;
}

// createApp lets tests inject fresh repos/fakes for isolation; the server uses defaults.
export function createApp(deps: AppDeps = {}) {
  const bookings = deps.bookings ?? new InMemoryBookingRepo();
  const payments = deps.payments ?? new InMemoryPaymentRepo();
  const email = deps.email ?? new FakeEmailAdapter();
  const adapter = deps.adapter ?? new FakePaymentAdapter();

  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.route('/bookings', bookingRoutes({ bookings, payments, adapter }));
  app.route('/webhooks', webhookRoutes({ bookings, payments, adapter, email }));
  return app;
}

export const app = createApp();
