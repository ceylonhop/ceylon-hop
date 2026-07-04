import { createHmac, timingSafeEqual } from 'node:crypto';

export type OpsRole = 'founder' | 'finance' | 'ops' | 'system';
export type OpsAction =
  | 'quote:manage' | 'margin:view' | 'bookings:operate'
  | 'bookings:read' | 'payments:act' | 'admin:jobs';

// The capability matrix as data (spec §3). Adding a capability is one row here.
const CAPABILITIES: Record<OpsRole, ReadonlySet<OpsAction>> = {
  founder: new Set(['quote:manage', 'margin:view', 'bookings:operate', 'bookings:read', 'payments:act', 'admin:jobs']),
  finance: new Set(['quote:manage', 'bookings:read', 'payments:act']),
  ops: new Set(['quote:manage', 'bookings:operate', 'bookings:read']),
  system: new Set(['admin:jobs']),
};

export function can(role: OpsRole, action: OpsAction): boolean {
  return CAPABILITIES[role]?.has(action) ?? false;
}

const ROLE_VALUES: ReadonlySet<string> = new Set(['founder', 'finance', 'ops']);

// Parse OPS_USERS="email:role,email:role". Emails lowercased. 'system' is NOT a
// valid login role, so it is rejected here alongside any other unknown string.
export function parseOpsUsers(raw: string): Map<string, OpsRole> {
  const out = new Map<string, OpsRole>();
  for (const entry of (raw ?? '').split(',')) {
    const [email, role] = entry.split(':').map((s) => s.trim());
    if (!email || !role || !ROLE_VALUES.has(role)) continue;
    out.set(email.toLowerCase(), role as OpsRole);
  }
  return out;
}

export function roleForEmail(email: string, users: Map<string, OpsRole>): OpsRole | null {
  return users.get((email ?? '').toLowerCase()) ?? null;
}

export interface SessionPayload {
  email: string;
  exp: number; // epoch ms
}

function mac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

// Cookie = base64url(json).hmac. Identity only — no role (spec D5).
export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

export function verifySession(token: string | undefined, secret: string, now: number): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = mac(body, secret);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch { return null; }
  const p = parsed as Partial<SessionPayload>;
  if (typeof p?.email !== 'string' || typeof p?.exp !== 'number') return null;
  if (p.exp <= now) return null;
  return { email: p.email, exp: p.exp };
}
