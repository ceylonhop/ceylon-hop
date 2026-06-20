import type { Context, Next } from 'hono';

// Per-IP sliding-window limiter for write endpoints. In-memory is fine: the API runs as a
// single instance. Only POST requests count (reads/preflight pass through). Behind Render
// the real client IP is the first entry of x-forwarded-for.
export function rateLimit(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, number[]>();

  return async (c: Context, next: Next) => {
    if (c.req.method !== 'POST') return next();

    const now = Date.now();
    const fwd = c.req.header('x-forwarded-for') ?? '';
    const ip = fwd.split(',')[0].trim() || c.req.header('x-real-ip') || 'unknown';

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
