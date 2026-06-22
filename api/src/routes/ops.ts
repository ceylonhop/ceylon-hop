import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { BookingRepo } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { RideOpsRepo } from '../db/rideOpsRepo';
import type { CoordinatorRepo } from '../db/coordinatorRepo';
import { signSession, verifySession, roleForKey, type OpsRole } from '../lib/opsAuth';
import { toOpsRow } from '../services/opsView';

export interface OpsDeps {
  bookings: BookingRepo;
  payments: PaymentRepo;
  rideOps: RideOpsRepo;
  coordinators: CoordinatorRepo;
  auth: { supportKey: string; founderKey: string; sessionSecret: string; adminApiKey: string };
}

const COOKIE = 'ch_ops';

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

  r.get('/bookings', async (c) => {
    const status = c.req.query('status'); const mode = c.req.query('mode');
    const date = c.req.query('date'); const q = (c.req.query('q') ?? '').toLowerCase();
    const all = await deps.bookings.list(status ? { status: status as never } : undefined);
    const ops = await deps.rideOps.listByBookingIds(all.map((b) => b.id));
    const opsById = new Map(ops.map((o) => [o.bookingId, o]));
    const rows = [];
    for (const b of all) {
      if (mode && b.mode !== mode) continue;
      const paid = (await deps.payments.findByBookingId(b.id)).some((p) => p.status === 'succeeded');
      const row = toOpsRow(b, { rideOps: opsById.get(b.id) ?? null, paid });
      if (date && row.travelDate !== date) continue;
      if (q && !`${row.reference} ${row.customerName} ${b.input.customer.email}`.toLowerCase().includes(q)) continue;
      rows.push(row);
    }
    rows.reverse(); // newest-first (list() returns insertion order)
    return c.json(rows);
  });

  r.get('/bookings/:id', async (c) => {
    const b = await deps.bookings.get(c.req.param('id'));
    if (!b) return c.json({ error: 'not_found' }, 404);
    const ops = await deps.rideOps.getOrCreate(b.id);
    const payments = await deps.payments.findByBookingId(b.id);
    return c.json({ booking: b, ops, payments });
  });

  r.post('/bookings/:id/assign', async (c) => {
    const body = z.object({ coordinatorId: z.string().nullable() }).parse(await c.req.json());
    return c.json(await deps.rideOps.assign(c.req.param('id'), body.coordinatorId));
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
