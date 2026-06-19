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

if (!config.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run the server (set it in api/.env)');
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

const { db, sql } = createDb(config.DATABASE_URL);
await seedCorridors(sql);
const app = createApp({
  bookings: new PostgresBookingRepo(db),
  payments: new PostgresPaymentRepo(db),
  conciergeTasks: new PostgresConciergeTaskRepo(db),
  departures: new PostgresDepartureRepo(sql),
  adapter,
});

serve({ fetch: app.fetch, port: config.PORT });
console.log(`Ceylon Hop API listening on http://localhost:${config.PORT} (Postgres)`);
