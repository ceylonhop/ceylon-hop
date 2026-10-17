import { Hono } from 'hono';
import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware';
import { collectSystemHealth, type SystemHealthDeps } from '../services/systemHealth';

// Founder system health (spec 2026-10-13 §5). Gated on analytics:view, not a new capability: the
// matrix row would be identical, and "founder-only system page" is what that capability already
// means. One read-only JSON document per view; the UI never caches it (no-store), a Refresh
// control re-fetches.

export interface OpsHealthDeps extends Omit<SystemHealthDeps, 'limits'> {
  auth: OpsAuthConfig;
  limits: SystemHealthDeps['limits'];
  now?: () => Date;
}

export function opsHealthRoutes(deps: OpsHealthDeps) {
  const r = new Hono();
  r.use('*', opsIdentity(deps.auth));
  r.use('*', requireCap('analytics:view'));

  r.get('/', async (c) => {
    const health = await collectSystemHealth((deps.now ?? (() => new Date()))(), deps);
    c.header('cache-control', 'no-store');
    return c.json(health);
  });

  return r;
}
