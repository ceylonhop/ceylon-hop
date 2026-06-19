import { serve } from '@hono/node-server';
import { config } from './config';
import { createApp } from './app';
import { createDb } from './db/client';
import { PostgresBookingRepo } from './db/postgresBookingRepo';
import { PostgresPaymentRepo } from './db/postgresPaymentRepo';
import { PostgresConciergeTaskRepo } from './db/postgresConciergeTaskRepo';

if (!config.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run the server (set it in api/.env)');
}

const { db } = createDb(config.DATABASE_URL);
const app = createApp({
  bookings: new PostgresBookingRepo(db),
  payments: new PostgresPaymentRepo(db),
  conciergeTasks: new PostgresConciergeTaskRepo(db),
});

serve({ fetch: app.fetch, port: config.PORT });
console.log(`Ceylon Hop API listening on http://localhost:${config.PORT} (Postgres)`);
