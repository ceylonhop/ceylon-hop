import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { BookingRepo } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { RideOpsRepo } from '../db/rideOpsRepo';
import { signSession, verifySession, roleForKey, type OpsRole } from '../lib/opsAuth';
import { toOpsRow, type OpsBookingRow } from '../services/opsView';

export interface OpsDeps {
  bookings: BookingRepo;
  payments: PaymentRepo;
  rideOps: RideOpsRepo;
  auth: { supportKey: string; founderKey: string; sessionSecret: string; adminApiKey: string };
}

const COOKIE = 'ch_ops';

// The unified post-payment ops queue: everything still needing a human before it's
// handed off (payment_pending) or in flight (paid, with ride_ops carrying the stage).
const QUEUE_STATUSES = ['payment_pending', 'paid'] as const;

export function opsRoutes(deps: OpsDeps) {
  const r = new Hono<{ Variables: { role: OpsRole } }>();
  const { auth } = deps;

  r.post('/login', async (c) => {
    const body = z.object({ key: z.string() }).safeParse(await c.req.json().catch(() => ({})));
    const role = body.success ? roleForKey(body.data.key, { supportKey: auth.supportKey, founderKey: auth.founderKey }) : null;
    if (!role) return c.json({ error: 'unauthorized' }, 401);
    setCookie(c, COOKIE, signSession(role, auth.sessionSecret), {
      httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 12,
    });
    return c.json({ role }, 200);
  });

  r.post('/logout', (c) => { setCookie(c, COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 }); return c.json({ ok: true }); });

  // auth middleware for everything below
  r.use('*', async (c, next) => {
    const headerRole = c.req.header('x-admin-key') && c.req.header('x-admin-key') === auth.adminApiKey ? 'founder' : null;
    const role = headerRole ?? verifySession(getCookie(c, COOKIE), auth.sessionSecret);
    if (!role) return c.json({ error: 'unauthorized' }, 401);
    c.set('role', role);
    await next();
  });

  r.get('/whoami', (c) => c.json({ role: c.get('role') }));

  // Reserved founder-only surface. The real finance content lands in the finance slice;
  // the gate is enforced now so revenue endpoints never leak to support.
  r.get('/finance/summary', (c) => {
    if (c.get('role') !== 'founder') return c.json({ error: 'forbidden' }, 403);
    return c.json({ ok: true });
  });

  r.get('/bookings', async (c) => {
    const stage = c.req.query('stage'); const date = c.req.query('date');
    const q = (c.req.query('q') ?? '').toLowerCase();
    const all = await deps.bookings.list({ status: [...QUEUE_STATUSES] });
    const ops = await deps.rideOps.listByBookingIds(all.map((b) => b.id));
    const opsById = new Map(ops.map((o) => [o.bookingId, o]));
    const rows: OpsBookingRow[] = [];
    for (const b of all) {
      const paid = (await deps.payments.findByBookingId(b.id)).some((p) => p.status === 'succeeded');
      const row = toOpsRow(b, { rideOps: opsById.get(b.id) ?? null, paid });
      if (stage && row.stage !== stage) continue;
      if (date && row.travelDate !== date) continue;
      if (q && !`${row.reference} ${row.customerName} ${b.input.customer.email}`.toLowerCase().includes(q)) continue;
      rows.push(row);
    }
    // travelDate ascending, nulls last
    rows.sort((a, b) => {
      if (a.travelDate === b.travelDate) return 0;
      if (a.travelDate === null) return 1;
      if (b.travelDate === null) return -1;
      return a.travelDate < b.travelDate ? -1 : 1;
    });
    return c.json(rows);
  });

  r.get('/bookings/:id', async (c) => {
    const b = await deps.bookings.get(c.req.param('id'));
    if (!b) return c.json({ error: 'not_found' }, 404);
    const ops = await deps.rideOps.getOrCreate(b.id);
    const payments = await deps.payments.findByBookingId(b.id);
    return c.json({ booking: b, ops, payments });
  });

  r.post('/bookings/:id/status', async (c) => {
    const body = z.object({ to: z.string() }).parse(await c.req.json());
    try {
      return c.json(await deps.rideOps.setStatus(c.req.param('id'), body.to as never));
    } catch {
      return c.json({ error: 'illegal_transition' }, 400);
    }
  });

  r.post('/bookings/:id/flags', async (c) => {
    const body = z.object({
      vehiclePhotoReceived: z.boolean().optional(),
      customerUpdated: z.boolean().optional(),
      opsNotes: z.string().nullable().optional(),
    }).parse(await c.req.json());
    return c.json(await deps.rideOps.setFlags(c.req.param('id'), body));
  });

  return r;
}
