import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AlertAdapter } from '../adapters/alerts';
import { track } from '../observability/track';

// M17 (O4): front-end pages beacon their JS errors here instead of carrying a Sentry
// browser SDK — no DSN in the frozen front-end, works with zero accounts today, and the
// server forwards to Sentry (tagged frontend) once keys exist. Public endpoint on public
// pages: strictly validated, size-capped, rate-limited at the mount, and it never 500s —
// a broken error reporter must not create more errors.

const MAX_BODY_BYTES = 2048;

const ClientErrorSchema = z.object({
  message: z.string().min(1).max(500),
  stack: z.string().max(1500).optional(),
  url: z.string().max(300).optional(),
  ua: z.string().max(300).optional(),
});

export function clientErrorRoutes(deps: { alerts: AlertAdapter }) {
  const r = new Hono();

  r.post('/', async (c) => {
    try {
      const raw = await c.req.text();
      if (raw.length > MAX_BODY_BYTES) return c.body(null, 413);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return c.body(null, 400);
      }
      const result = ClientErrorSchema.safeParse(parsed);
      if (!result.success) return c.body(null, 400);
      const e = result.data;

      track(new Error(e.message), { tag: 'frontend', extra: { stack: e.stack, url: e.url, ua: e.ua } });
      const digest = createHash('sha1').update(e.message).digest('hex').slice(0, 12);
      await deps.alerts.send({
        severity: 'warning',
        kind: 'client_error',
        title: `Front-end error: ${e.message.slice(0, 80)}`,
        body: `${e.message}\n\nurl: ${e.url ?? '?'}\nua: ${e.ua ?? '?'}\n\n${e.stack ?? ''}`.trim(),
        dedupeKey: digest,
      });
      return c.body(null, 204);
    } catch (err) {
      // Never let the error reporter become an error source.
      console.error('client-error intake failed:', err);
      return c.body(null, 204);
    }
  });

  return r;
}
