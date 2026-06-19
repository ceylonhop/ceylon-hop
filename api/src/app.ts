import { Hono } from 'hono';
import { InMemoryBookingRepo, type BookingRepo } from './db/bookingRepo';
import { bookingRoutes } from './routes/bookings';

// createApp lets tests inject a fresh repo for isolation; the server uses the default.
export function createApp(repo: BookingRepo = new InMemoryBookingRepo()) {
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.route('/bookings', bookingRoutes(repo));
  return app;
}

export const app = createApp();
