import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

// ============================================================================
// Customer session — the FIRST customer-facing auth (staff use ch_ops/RBAC).
// Same HMAC-cookie idiom as opsAuth (base64url(json).hmac, length-guarded
// timingSafeEqual), but a SEPARATE cookie (ch_cust) + secret so a customer
// session and a staff session can never be cross-replayed. Identity only — a
// customer has no capabilities; routes just require "signed in".
// ============================================================================

export const CUSTOMER_COOKIE = 'ch_cust';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — travellers come back across a trip

export interface CustomerSession {
  sub: string; // Google subject (stable per-user id)
  email: string;
  name: string; // Google display name
  country: string; // ISO-ish country code / label the traveller is shown by
  photo?: string; // Google profile photo URL
  exp: number; // epoch ms
}

function mac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function signCustomerSession(payload: CustomerSession, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

export function verifyCustomerSession(
  token: string | undefined,
  secret: string,
  now: number,
): CustomerSession | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = mac(body, secret);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const p = parsed as Partial<CustomerSession>;
  if (
    typeof p?.sub !== 'string' ||
    typeof p?.email !== 'string' ||
    typeof p?.name !== 'string' ||
    typeof p?.country !== 'string' ||
    typeof p?.exp !== 'number'
  ) {
    return null;
  }
  if (p.exp <= now) return null;
  return {
    sub: p.sub,
    email: p.email,
    name: p.name,
    country: p.country,
    exp: p.exp,
    ...(typeof p.photo === 'string' && p.photo ? { photo: p.photo } : {}),
  };
}

export function issueCustomerCookie(
  c: Context,
  session: Omit<CustomerSession, 'exp'>,
  secret: string,
  now: number,
): void {
  const token = signCustomerSession({ ...session, exp: now + SESSION_TTL_MS }, secret);
  // SameSite=None so the cookie rides cross-origin fetches (board.html on the Pages site →
  // API on Render). Requires Secure (set). CSRF stays covered: the write endpoints only accept
  // application/json, which forces a CORS preflight, so a non-allowlisted origin's POST is
  // blocked before it runs.
  setCookie(c, CUSTOMER_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'None',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearCustomerCookie(c: Context): void {
  setCookie(c, CUSTOMER_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'None', path: '/', maxAge: 0 });
}

declare module 'hono' {
  interface ContextVariableMap {
    customer: CustomerSession;
  }
}

/** Reads the ch_cust cookie and, when valid, sets c.var.customer. Never throws. */
export function customerIdentity(sessionSecret: string): MiddlewareHandler {
  return async (c, next) => {
    const s = verifyCustomerSession(getCookie(c, CUSTOMER_COOKIE), sessionSecret, Date.now());
    if (s) c.set('customer', s);
    return next();
  };
}

/** Gate for endpoints that need a signed-in traveller. */
export function requireCustomer(): MiddlewareHandler {
  return async (c, next) => {
    if (!c.get('customer')) return c.json({ error: 'sign_in_required' }, 401);
    return next();
  };
}

// ---- Ride-member "manage my name" capability token -------------------------
// Same shape as bookingToken (base64url(json).hmac, no expiry), but a distinct
// payload {listId, sub} so it can never be confused with a booking-view token.

export function signRideMemberToken(listId: string, sub: string, secret: string): string {
  const body = Buffer.from(JSON.stringify({ listId, sub })).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

export function verifyRideMemberToken(
  token: string | undefined,
  secret: string,
): { listId: string; sub: string } | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = mac(body, secret);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const p = parsed as { listId?: unknown; sub?: unknown };
  return typeof p?.listId === 'string' && p.listId && typeof p?.sub === 'string' && p.sub
    ? { listId: p.listId, sub: p.sub }
    : null;
}
