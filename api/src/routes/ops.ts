import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { BookingRepo } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { RideOpsRepo } from '../db/rideOpsRepo';
import type { CoordinatorRepo } from '../db/coordinatorRepo';
import { signSession, verifySession, roleForKey, type OpsRole } from '../lib/opsAuth';

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

  return r;
}
