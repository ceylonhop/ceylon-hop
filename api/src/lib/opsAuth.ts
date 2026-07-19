import { createHmac, timingSafeEqual } from 'node:crypto';

export type OpsRole = 'founder' | 'finance' | 'ops' | 'system';
export type OpsAction =
  | 'quote:manage' | 'quote:approve' | 'margin:view' | 'bookings:operate'
  | 'bookings:read' | 'payments:act' | 'admin:jobs';

// The capability matrix as data (spec §3). Adding a capability is one row here.
// quote:approve — the maker-checker gate: only the founder can mark a quote ready to send.
const CAPABILITIES: Record<OpsRole, ReadonlySet<OpsAction>> = {
  founder: new Set(['quote:manage', 'quote:approve', 'margin:view', 'bookings:operate', 'bookings:read', 'payments:act', 'admin:jobs']),
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

// How staff are labelled wherever the UI names a person (the assign picker, the queue's
// assignee chip): "Roshen Wijesinghe" → "Roshen W.". Short enough for a queue row, and it
// survives a second Roshen joining in a way a bare first name would not.
//
// The name comes from the Google profile captured at sign-in, so it is absent until that
// person signs in once (and always, for dev-login sessions). That is not an error state —
// we fall back to the email local part, which is exactly what the UI showed before names
// existed. Always returns something printable: a blank label reads as a broken row.
export function displayNameFor(name: string | null | undefined, email: string): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
  if (parts.length === 1) return parts[0];
  return (email ?? '').split('@')[0] || 'unknown';
}

export interface AssignableUser { email: string; role: OpsRole }

// Who a quote may be assigned to (spec 2026-07-16 §5/§7). Assignment drives an email carrying a
// deep link to the quote, so this is BOTH the picker's list and the assign validator's allow-list
// — one source of truth, because the two drifting apart is how you end up mailing a quote link to
// someone who can't open it (the /ops?quote= param resolves only for quote:manage; without it the
// link silently dumps them on the tickets queue). Today that's every role; this keeps it true.
export function assignableOpsUsers(raw: string): AssignableUser[] {
  return [...parseOpsUsers(raw)]
    .filter(([, role]) => can(role, 'quote:manage'))
    .map(([email, role]) => ({ email, role }));
}

// Who should be told a quote is waiting for approval (spec 2026-07-18): the quote:approve
// holders. Mirrors assignableOpsUsers, filtered on the approval capability instead.
export function approverOpsUsers(raw: string): AssignableUser[] {
  return [...parseOpsUsers(raw)]
    .filter(([, role]) => can(role, 'quote:approve'))
    .map(([email, role]) => ({ email, role }));
}

// Normalised assignee email, or null if they aren't assignable. Callers reject on null.
export function resolveAssignee(email: string, raw: string): string | null {
  const wanted = (email ?? '').trim().toLowerCase();
  return assignableOpsUsers(raw).some((u) => u.email === wanted) ? wanted : null;
}

export interface SessionPayload {
  email: string;
  exp: number; // epoch ms
  name?: string; // display name from Google at login; absent on legacy cookies + dev-login
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
  // Compare BYTE lengths, not string lengths — a crafted multibyte signature can match the hex
  // string length while producing a longer Buffer, which would make timingSafeEqual throw (500).
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch { return null; }
  const p = parsed as Partial<SessionPayload>;
  if (typeof p?.email !== 'string' || typeof p?.exp !== 'number') return null;
  if (p.exp <= now) return null;
  return { email: p.email, exp: p.exp, ...(typeof p.name === 'string' && p.name ? { name: p.name } : {}) };
}
