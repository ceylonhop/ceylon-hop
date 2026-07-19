import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { BookingRepo } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { RideOpsRepo } from '../db/rideOpsRepo';
import type { OpsUserProfileRepo } from '../db/opsUserProfileRepo';
import { assignableOpsUsers, can, displayNameFor, parseOpsUsers, roleForEmail, type OpsAction } from '../lib/opsAuth';
import {
  opsIdentity, requireCap, issueSessionCookie, devBypassEnabled, OPS_COOKIE,
  type OpsAuthConfig,
} from '../lib/opsMiddleware';
import { verifyGoogleIdToken, type JwtVerifier } from '../lib/googleAuth';
import { toOpsRow, type OpsBookingRow } from '../services/opsView';
import type { EmailAdapter } from '../adapters/email';
import type { NotificationLogRepo } from '../db/notificationLogRepo';
import { sendNoShowNotice } from '../services/notifications';

export interface OpsDeps {
  bookings: BookingRepo;
  payments: PaymentRepo;
  rideOps: RideOpsRepo;
  opsUserProfiles: OpsUserProfileRepo;
  auth: OpsAuthConfig;
  googleVerifier?: JwtVerifier; // test seam — bypasses real Google JWKS
  // Optional so tests that only exercise fulfilment can omit them; when present, the
  // fulfilment milestones fire the matching customer email (once, via notificationLog).
  email?: EmailAdapter;
  notificationLog?: NotificationLogRepo;
  baseUrl?: string;
  linkSecret?: string;
}

// Every action the capability matrix knows about — used only to compute whoami's `caps`
// list from the resolved role, never to grant anything (can() remains the sole gate).
const ALL_ACTIONS: OpsAction[] = [
  'quote:manage', 'quote:approve', 'margin:view', 'bookings:operate', 'bookings:read', 'payments:act', 'admin:jobs',
];

const QUEUE_STATUSES = ['payment_pending', 'paid'] as const;

// A fulfilment milestone that has a customer email attached. 'no_show' → the
// forfeited-fare notice. The 'vehicle_confirmed' (driver-arranged) milestone
// deliberately sends NO customer email (owner decision 2026-07-18): the paid
// confirmation already went out, so confirming the driver is an internal step.
async function maybeEmailForStage(deps: OpsDeps, bookingId: string, to: string): Promise<void> {
  const kind = to === 'no_show' ? 'no_show_notice' : null;
  if (!kind || !deps.email) return;
  const log = deps.notificationLog;
  try {
    if (log && (await log.wasSent(bookingId, kind))) return; // already emailed for this milestone
    const booking = await deps.bookings.get(bookingId);
    if (!booking) return;
    await sendNoShowNotice(booking, deps.email);
    await log?.markSent(bookingId, kind);
  } catch (err) {
    console.error(`ops ${kind} email failed for ${bookingId}:`, err);
  }
}

export function opsRoutes(deps: OpsDeps) {
  const r = new Hono();
  const { auth } = deps;
  const users = parseOpsUsers(auth.opsUsers);

  // Remember who someone is, by the name Google already knows them by. Deliberately swallows
  // its errors: this is a nicety on the login path, and the prod migration lands by hand AFTER
  // the code deploys — for that window the table is missing and every write throws. Nobody
  // should be locked out of the ops tool because we couldn't store a label.
  async function rememberName(email: string, name: string | undefined): Promise<void> {
    if (!name) return;
    try {
      await deps.opsUserProfiles.upsert(email, name);
    } catch (err) {
      console.error('ops profile name upsert failed for', email, err);
    }
  }

  // Google sign-in: the browser POSTs the Google ID token; we verify, allowlist-check, set cookie.
  r.post('/login', async (c) => {
    const body = z.object({ credential: z.string() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    if (!auth.googleClientId || !auth.opsUsers) return c.json({ error: 'login_unavailable' }, 503); // fail closed
    let id;
    try {
      id = await verifyGoogleIdToken(body.data.credential, { clientId: auth.googleClientId, verifier: deps.googleVerifier });
    } catch {
      return c.json({ error: 'invalid_token' }, 401);
    }
    if (!id.emailVerified) return c.json({ error: 'email_unverified' }, 403);
    const role = roleForEmail(id.email, users);
    if (!role) return c.json({ error: 'not_authorised', email: id.email }, 403);
    issueSessionCookie(c, id.email, auth.sessionSecret, Date.now(), id.name);
    await rememberName(id.email, id.name);
    return c.json({ email: id.email, role }, 200);
  });

  // Dev-only bypass: mint a session for a chosen allowlisted email without Google.
  // Refuses (404, no cookie) when NODE_ENV === 'production' — asserted in Task T-F.
  r.post('/dev-login', async (c) => {
    if (!devBypassEnabled(auth)) return c.json({ error: 'not_found' }, 404);
    const body = z.object({ email: z.string() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    if (!roleForEmail(body.data.email, users)) return c.json({ error: 'not_authorised' }, 403);
    issueSessionCookie(c, body.data.email, auth.sessionSecret, Date.now());
    return c.json({ ok: true }, 200);
  });

  r.post('/logout', (c) => {
    setCookie(c, OPS_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
    return c.json({ ok: true });
  });

  // Identity + guards for everything below.
  r.use('*', opsIdentity(auth));

  // Backfill seam: sessions live for 7 days, so login alone would leave the picker showing
  // email local parts for up to a week after this ships — for people who are signed in and
  // working the whole time. whoami runs once per app boot and the cookie already carries the
  // name, so the roster heals on the next page load instead. A write on a read path, which is
  // a smell worth the honesty of the picker naming actual humans on day one.
  r.get('/whoami', requireCap('bookings:read'), async (c) => {
    const identity = c.get('identity');
    const caps = ALL_ACTIONS.filter((a) => can(identity.role, a));
    await rememberName(identity.email, identity.name);
    return c.json({ email: identity.email, role: identity.role, caps, ...(identity.name ? { name: identity.name } : {}) });
  });

  // The assign picker's roster (spec 2026-07-16 §7). Staff emails, so it needs a session — but
  // no special capability: anyone who can work a quote can hand it to a colleague. The list is
  // filtered to users who can actually OPEN a quote, so we never offer an assignee whose
  // notification link would dead-end (see assignableOpsUsers).
  // displayName is computed here, not in the browser, so the picker and the queue's assignee
  // chip cannot drift apart — they consume the same label. Role stays env-owned; the name is
  // joined on from whatever we've captured at sign-in. A failed lookup costs the names, never
  // the roster: staff must still be able to hand a quote over.
  r.get('/users', requireCap('bookings:read'), async (c) => {
    let names = new Map<string, string>();
    try {
      names = await deps.opsUserProfiles.namesByEmail();
    } catch (err) {
      console.error('ops profile name lookup failed; falling back to email local parts', err);
    }
    const users = assignableOpsUsers(auth.opsUsers)
      .map((u) => ({ ...u, displayName: displayNameFor(names.get(u.email), u.email) }));
    return c.json({ users });
  });

  r.get('/finance/summary', requireCap('margin:view'), (c) => c.json({ ok: true }));

  r.get('/bookings', requireCap('bookings:read'), async (c) => {
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

  // Spec §3.1 [CORRECTED]: the payments row carries no cost/margin field (confirmed against
  // db/paymentRepo.ts's Payment interface — amount/status/provider/orderId only). There is
  // nothing to strip here. If cost tracking is ever added to this response, gate it behind
  // can(identity.role, 'margin:view') and add a test on both sides before shipping it.
  r.get('/bookings/:id', requireCap('bookings:read'), async (c) => {
    const b = await deps.bookings.get(c.req.param('id'));
    if (!b) return c.json({ error: 'not_found' }, 404);
    const ops = await deps.rideOps.getOrCreate(b.id);
    const payments = await deps.payments.findByBookingId(b.id);
    return c.json({ booking: b, ops, payments });
  });

  r.post('/bookings/:id/status', requireCap('bookings:operate'), async (c) => {
    // Bad body → 400, not a thrown 500 that also pages the founder via onError's alert.
    const body = z.object({ to: z.string() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const id = c.req.param('id');
    let updated;
    try {
      updated = await deps.rideOps.setStatus(id, body.data.to as never);
    } catch {
      return c.json({ error: 'illegal_transition' }, 400);
    }
    // Fire the matching customer email on the milestone, once (idempotent via the log).
    // Best-effort: a mail hiccup must never fail the ops action the operator just took.
    await maybeEmailForStage(deps, id, body.data.to);
    return c.json(updated);
  });

  r.post('/bookings/:id/flags', requireCap('bookings:operate'), async (c) => {
    const body = z.object({
      vehiclePhotoReceived: z.boolean().optional(),
      customerUpdated: z.boolean().optional(),
      opsNotes: z.string().nullable().optional(),
    }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    return c.json(await deps.rideOps.setFlags(c.req.param('id'), body.data));
  });

  return r;
}
