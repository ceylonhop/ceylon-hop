import { Hono } from 'hono';
import type { BookingRepo } from '../db/bookingRepo';
import { BOOKING_STATUSES, type BookingStatus } from '../domain/status';

// Interim staff API guarded by a single shared key. Supabase Auth + RBAC replaces this
// in M12 — do not bake the API-key assumption deep.
export function adminRoutes(deps: { bookings: BookingRepo; adminApiKey: string }) {
  const { bookings, adminApiKey } = deps;
  const r = new Hono();

  r.get('/bookings', async (c) => {
    const key = c.req.header('x-admin-key');
    if (!adminApiKey || key !== adminApiKey) return c.json({ error: 'unauthorized' }, 401);

    const status = c.req.query('status');
    if (status && !(BOOKING_STATUSES as readonly string[]).includes(status)) {
      return c.json({ error: 'bad_status' }, 400);
    }
    const list = await bookings.list(status ? { status: status as BookingStatus } : undefined);
    return c.json(list, 200);
  });

  return r;
}
