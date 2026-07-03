import { serve } from '@hono/node-server';
import { config } from './config';
import { createApp } from './app';
import { createDb } from './db/client';
import { PostgresBookingRepo } from './db/postgresBookingRepo';
import { PostgresPaymentRepo } from './db/postgresPaymentRepo';
import { PostgresConciergeTaskRepo } from './db/postgresConciergeTaskRepo';
import { PostgresDepartureRepo, seedCorridors } from './db/postgresDepartureRepo';
import { PayHerePaymentAdapter } from './adapters/payhere';
import { FakePaymentAdapter } from './adapters/payments';
import { FakeMapsAdapter, GoogleMapsAdapter } from './adapters/maps';
import { FakeEmailAdapter, ResendEmailAdapter } from './adapters/email';
import { PostgresCoordinatorRepo } from './db/postgresCoordinatorRepo';
import { PostgresRideOpsRepo } from './db/postgresRideOpsRepo';
import { PostgresNotificationLogRepo } from './db/postgresNotificationLogRepo';
import { PostgresQuoteRepo } from './db/postgresQuoteRepo';
import { PostgresAlertLogRepo } from './db/postgresAlertLogRepo';
import { EmailAlertAdapter, LogAlertAdapter, ThrottledAlerts } from './adapters/alerts';
import { initTracking } from './observability/track';

if (!config.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run the server (set it in api/.env)');
}

if (!config.ADMIN_API_KEY) {
  console.warn(
    'WARNING: ADMIN_API_KEY is not set — the internal quoting tool (/admin/quote/*) is UNAUTHENTICATED and exposes customer PII + cost/margin. Set ADMIN_API_KEY before serving real traffic.',
  );
}

const adapter =
  config.PAYHERE_MERCHANT_ID && config.PAYHERE_MERCHANT_SECRET
    ? new PayHerePaymentAdapter(config.PAYHERE_MERCHANT_ID, config.PAYHERE_MERCHANT_SECRET, {
        mode: config.PAYHERE_MODE,
        notifyUrl: config.PAYHERE_NOTIFY_URL ?? '',
        returnUrl: `${config.APP_BASE_URL}/booking.html`,
        cancelUrl: `${config.APP_BASE_URL}/booking.html`,
      })
    : new FakePaymentAdapter();

const maps = config.GOOGLE_MAPS_API_KEY
  ? new GoogleMapsAdapter(config.GOOGLE_MAPS_API_KEY)
  : new FakeMapsAdapter();

const email = config.RESEND_API_KEY
  ? new ResendEmailAdapter(config.RESEND_API_KEY, {
      from: config.EMAIL_FROM,
      replyTo: config.EMAIL_REPLY_TO,
    })
  : new FakeEmailAdapter();

const { db, sql } = createDb(config.DATABASE_URL);
await seedCorridors(sql);

// M17 — error tracking (dormant without SENTRY_DSN) + throttled ops alerts. Email-only
// per the owner's O1 decision; log-only until ALERT_EMAIL is set at launch.
initTracking(config.SENTRY_DSN, {
  environment: config.NODE_ENV,
  release: process.env.RENDER_GIT_COMMIT,
});
const alerts = new ThrottledAlerts(
  config.ALERT_EMAIL ? new EmailAlertAdapter(email, config.ALERT_EMAIL) : new LogAlertAdapter(),
  new PostgresAlertLogRepo(db),
);

const app = createApp({
  bookings: new PostgresBookingRepo(db),
  payments: new PostgresPaymentRepo(db),
  conciergeTasks: new PostgresConciergeTaskRepo(db),
  departures: new PostgresDepartureRepo(sql),
  rideOps: new PostgresRideOpsRepo(db),
  coordinators: new PostgresCoordinatorRepo(db),
  notificationLog: new PostgresNotificationLogRepo(db),
  quotes: new PostgresQuoteRepo(db),
  adapter,
  maps,
  email,
  alerts,
  auth: {
    opsSupportKey: config.OPS_SUPPORT_KEY,
    opsFounderKey: config.OPS_FOUNDER_KEY,
    opsSessionSecret: config.OPS_SESSION_SECRET,
  },
});

serve({ fetch: app.fetch, port: config.PORT });
console.log(`Ceylon Hop API listening on http://localhost:${config.PORT} (Postgres)`);
