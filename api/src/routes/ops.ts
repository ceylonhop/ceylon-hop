import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { BookingRepo } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { RideOpsRepo } from '../db/rideOpsRepo';
import type { CoordinatorRepo } from '../db/coordinatorRepo';
import { signSession, verifySession, roleForKey, type OpsRole } from '../lib/opsAuth';
import { toOpsRow, manifestLine } from '../services/opsView';

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

  // Reserved founder-only surface. The real finance content lands in the finance slice;
  // the gate is enforced now so revenue endpoints never leak to support.
  r.get('/finance/summary', (c) => {
    if (c.get('role') !== 'founder') return c.json({ error: 'forbidden' }, 403);
    return c.json({ ok: true });
  });

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

  // ---- daily rides, coordinators, manifest ----
  function resolveDate(q: string | undefined): string {
    if (q === 'today' || !q) return new Date().toISOString().slice(0, 10);
    if (q === 'tomorrow') { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); }
    return q;
  }

  async function rowsForDate(date: string) {
    const all = await deps.bookings.list();
    const ops = await deps.rideOps.listByBookingIds(all.map((b) => b.id));
    const opsById = new Map(ops.map((o) => [o.bookingId, o]));
    const out: { b: (typeof all)[number]; row: ReturnType<typeof toOpsRow> }[] = [];
    for (const b of all) {
      const paid = (await deps.payments.findByBookingId(b.id)).some((p) => p.status === 'succeeded');
      const row = toOpsRow(b, { rideOps: opsById.get(b.id) ?? null, paid });
      if (row.travelDate === date) out.push({ b, row });
    }
    return out;
  }

  r.get('/rides', async (c) => {
    const date = resolveDate(c.req.query('date'));
    const rows = (await rowsForDate(date)).map((x) => x.row);
    return c.json({ date, rows });
  });

  r.get('/coordinators', async (c) => c.json(await deps.coordinators.list()));
  r.post('/coordinators', async (c) => {
    const body = z.object({ name: z.string().min(1), whatsapp: z.string().min(1), regions: z.string().optional() }).parse(await c.req.json());
    return c.json(await deps.coordinators.create(body), 201);
  });

  r.get('/manifest', async (c) => {
    const coordinatorId = c.req.query('coordinatorId'); const date = resolveDate(c.req.query('date'));
    const mine = (await rowsForDate(date)).filter((x) => x.row.coordinatorId === coordinatorId);
    const coord = coordinatorId ? await deps.coordinators.get(coordinatorId) : null;
    const header = `Ceylon Hop — ${date}${coord ? ` — ${coord.name}` : ''}\n`;
    const text = header + (mine.length ? mine.map((x) => manifestLine(x.b)).join('\n') : '(no rides assigned)');
    return c.json({ text });
  });

  r.post('/manifest/sent', async (c) => {
    const body = z.object({ coordinatorId: z.string(), date: z.string() }).parse(await c.req.json());
    const mine = (await rowsForDate(resolveDate(body.date))).filter((x) => x.row.coordinatorId === body.coordinatorId);
    let sent = 0;
    for (const x of mine) {
      if (x.row.fulfilmentStatus === 'assigned') { await deps.rideOps.setStatus(x.b.id, 'sent_to_coordinator'); sent++; }
    }
    return c.json({ sent });
  });

  return r;
}
