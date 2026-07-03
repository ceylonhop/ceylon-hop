import type { Context, Next } from 'hono';

// Per-IP sliding-window limiter for write endpoints. In-memory is fine: the API runs as a
// single instance. By default only POST requests count (reads/preflight pass through); pass
// `methods` to also throttle GETs (e.g. billed read endpoints like autocomplete). Behind
// Render the trusted proxy APPENDS the connecting IP to x-forwarded-for, so only the
// RIGHTMOST entry can be trusted — everything left of it (and x-real-ip) is client-supplied
// and trivially spoofable (GL-3).
function clientKey(c: Context): string {
  const fwd = c.req.header('x-forwarded-for') ?? '';
  const entries = fwd.split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.length) return entries[entries.length - 1];
  // No proxy header (direct connection / tests): the socket address via @hono/node-server.
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

export function rateLimit(opts: { windowMs: number; max: number; methods?: string[] }) {
  const hits = new Map<string, number[]>();
  const methods = opts.methods ?? ['POST'];

  return async (c: Context, next: Next) => {
    if (!methods.includes(c.req.method)) return next();

    const now = Date.now();
    const ip = clientKey(c);

    const recent = (hits.get(ip) ?? []).filter((t) => now - t < opts.windowMs);
    if (recent.length >= opts.max) {
      const retrySec = Math.ceil((opts.windowMs - (now - recent[0])) / 1000);
      c.header('Retry-After', String(retrySec));
      return c.json({ error: 'rate_limited', message: 'Too many requests — please slow down.' }, 429);
    }

    recent.push(now);
    hits.set(ip, recent);

    // Bound memory: occasionally drop IPs whose window has fully expired.
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (v.every((t) => now - t >= opts.windowMs)) hits.delete(k);
    }

    return next();
  };
}
