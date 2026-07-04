import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import {
  verifySession, signSession, parseOpsUsers, roleForEmail, can,
  type OpsRole, type OpsAction,
} from './opsAuth';

export const OPS_COOKIE = 'ch_ops';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface OpsIdentity { email: string; role: OpsRole }
export interface OpsAuthConfig {
  opsUsers: string;
  googleClientId: string;
  sessionSecret: string;
  adminApiKey: string;
  nodeEnv: string;
}

declare module 'hono' {
  interface ContextVariableMap { identity: OpsIdentity; revoked: boolean }
}

export function devBypassEnabled(cfg: OpsAuthConfig): boolean {
  return cfg.nodeEnv !== 'production';
}

export function issueSessionCookie(c: Context, email: string, sessionSecret: string, now: number): void {
  const token = signSession({ email, exp: now + SESSION_TTL_MS }, sessionSecret);
  setCookie(c, OPS_COOKIE, token, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_MS / 1000,
  });
}

// Resolve identity from (a) x-admin-key → system, or (b) session cookie → email → role
// looked up FRESH from OPS_USERS every request. Never throws; guards enforce.
export function opsIdentity(cfg: OpsAuthConfig): MiddlewareHandler {
  const users = parseOpsUsers(cfg.opsUsers);
  return async (c, next) => {
    const key = c.req.header('x-admin-key');
    if (key && cfg.adminApiKey && key === cfg.adminApiKey) {
      c.set('identity', { email: 'cron', role: 'system' });
      return next();
    }
    const payload = verifySession(getCookie(c, OPS_COOKIE), cfg.sessionSecret, Date.now());
    if (payload) {
      const role = roleForEmail(payload.email, users);
      if (role) {
        c.set('identity', { email: payload.email, role });
      } else {
        c.set('revoked', true); // valid cookie, email no longer allowlisted → 403 at the guard
      }
    }
    return next();
  };
}

export function requireCap(action: OpsAction): MiddlewareHandler {
  return async (c, next) => {
    const id = c.get('identity');
    if (!id) {
      if (c.get('revoked')) return c.json({ error: 'forbidden' }, 403);
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (!can(id.role, action)) return c.json({ error: 'forbidden' }, 403);
    return next();
  };
}
