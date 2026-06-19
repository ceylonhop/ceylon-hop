import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { InMemoryBookingRepo, type BookingRepo } from './db/bookingRepo';
import { InMemoryPaymentRepo, type PaymentRepo } from './db/paymentRepo';
import { InMemoryConciergeTaskRepo, type ConciergeTaskRepo } from './db/conciergeTaskRepo';
import { InMemoryDepartureRepo, type DepartureRepo } from './db/departureRepo';
import { FakeEmailAdapter, type EmailAdapter } from './adapters/email';
import { FakePaymentAdapter, type PaymentAdapter } from './adapters/payments';
import { bookingRoutes } from './routes/bookings';
import { webhookRoutes } from './routes/webhooks';
import { adminRoutes } from './routes/admin';
import { config } from './config';

export interface AppDeps {
  bookings?: BookingRepo;
  payments?: PaymentRepo;
  conciergeTasks?: ConciergeTaskRepo;
  departures?: DepartureRepo;
  email?: EmailAdapter;
  adapter?: PaymentAdapter;
  adminApiKey?: string;
}

// createApp lets tests inject fresh repos/fakes for isolation; the server uses defaults.
export function createApp(deps: AppDeps = {}) {
  const bookings = deps.bookings ?? new InMemoryBookingRepo();
  const payments = deps.payments ?? new InMemoryPaymentRepo();
  const conciergeTasks = deps.conciergeTasks ?? new InMemoryConciergeTaskRepo();
  const departures = deps.departures ?? new InMemoryDepartureRepo();
  const email = deps.email ?? new FakeEmailAdapter();
  const adapter = deps.adapter ?? new FakePaymentAdapter();
  const adminApiKey = deps.adminApiKey ?? config.ADMIN_API_KEY;

  const app = new Hono();

  // The browser calls this API cross-origin (site on a different port/host). Allow it.
  // Tighten `origin` to the real site domains before production.
  app.use('*', cors());

  // Never leak internals on an unexpected failure.
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal_error' }, 500);
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.route('/bookings', bookingRoutes({ bookings, payments, adapter, departures }));
  app.route('/webhooks', webhookRoutes({ bookings, payments, adapter, email, conciergeTasks }));
  app.route('/admin', adminRoutes({ bookings, adminApiKey }));
  return app;
}

export const app = createApp();
