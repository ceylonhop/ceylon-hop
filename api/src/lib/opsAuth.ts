import { createHmac, timingSafeEqual } from 'node:crypto';

export type OpsRole = 'support' | 'founder';

function mac(role: OpsRole, secret: string): string {
  return createHmac('sha256', secret).update(role).digest('hex');
}

export function signSession(role: OpsRole, secret: string): string {
  return `${role}.${mac(role, secret)}`;
}

export function verifySession(token: string | undefined, secret: string): OpsRole | null {
  if (!token) return null;
  const [role, sig] = token.split('.');
  if (role !== 'support' && role !== 'founder') return null;
  const expected = mac(role, secret);
  if (!sig || sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return role;
}

export function roleForKey(key: string, cfg: { supportKey: string; founderKey: string }): OpsRole | null {
  if (!key) return null;
  if (cfg.founderKey && key === cfg.founderKey) return 'founder';
  if (cfg.supportKey && key === cfg.supportKey) return 'support';
  return null;
}
