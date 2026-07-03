import 'dotenv/config';
import { z } from 'zod';

const Env = z.object({
  PORT: z.coerce.number().default(8787),
  // Render sets NODE_ENV=production. Gates fail-open conveniences (e.g. the quoting tool
  // allowing keyless access in dev) — anything reading this must fail CLOSED in production.
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string().optional(),
  DATABASE_URL_TEST: z.string().optional(),
  ADMIN_API_KEY: z.string().default(''),
  PAYHERE_MERCHANT_ID: z.string().optional(),
  PAYHERE_MERCHANT_SECRET: z.string().optional(),
  PAYHERE_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYHERE_NOTIFY_URL: z.string().optional(),
  APP_BASE_URL: z.string().default('http://localhost:4173'),
  // Browser origins allowed to call the API (comma-separated). The live site + local dev.
  ALLOWED_ORIGINS: z
    .string()
    .default('https://ceylonhop.github.io,https://ceylonhop.com,http://localhost:4173,http://localhost:8787'),
  // Per-IP rate limit on booking writes.
  RATE_LIMIT_MAX: z.coerce.number().default(20),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  // Google Maps (M8). When set, the server uses the real Distance Matrix adapter; otherwise
  // the fake (haversine) adapter. Restrict the key to the Distance Matrix API.
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  // Email (M4). When RESEND_API_KEY is set, the server sends real mail via Resend;
  // otherwise the fake adapter (records only). EMAIL_FROM must be a Resend-verified
  // sender (use onboarding@resend.dev for testing before the domain is verified).
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Ceylon Hop <onboarding@resend.dev>'),
  EMAIL_REPLY_TO: z.string().optional(),
  // Ops dashboard auth (Slice 1: per-role keys → signed session cookie).
  OPS_SUPPORT_KEY: z.string().default(''),
  OPS_FOUNDER_KEY: z.string().default(''),
  OPS_SESSION_SECRET: z.string().default('dev-ops-secret-change-me'),
  // Quote engine internal key — passed to quoteRoutes to gate marginEstimateCents.
  INTERNAL_QUOTE_KEY: z.string().default(''),
  // M17 observability — all optional; every feature is dormant until its key is set.
  // ALERT_EMAIL: where ops alerts + the daily digest land (email-only channel, O1).
  ALERT_EMAIL: z.string().optional(),
  // SENTRY_DSN: error tracking activates when the owner creates the Sentry project (O2).
  SENTRY_DSN: z.string().optional(),
  // RESEND_WEBHOOK_SECRET: enables POST /webhooks/resend (bounce/complaint alerts).
  RESEND_WEBHOOK_SECRET: z.string().optional(),
});

// Ops⇄quote merge T1: the founder ops-session cookie now unlocks /admin/quote (margin +
// customer PII), so a defaulted OPS_SESSION_SECRET in production would let anyone who reads
// the repo mint a valid founder cookie. Fail CLOSED at boot; dev/test keep the default.
const DEV_OPS_SECRET = 'dev-ops-secret-change-me';

// Exported for tests: build (and validate) a config from an arbitrary env.
export function buildConfig(env: Record<string, string | undefined>) {
  const cfg = Env.parse(env);
  if (cfg.NODE_ENV === 'production' && (!cfg.OPS_SESSION_SECRET || cfg.OPS_SESSION_SECRET === DEV_OPS_SECRET)) {
    throw new Error(
      'OPS_SESSION_SECRET must be set to a strong unique value in production ' +
        '(the default would let anyone forge a founder session cookie) — refusing to boot',
    );
  }
  return cfg;
}

export const config = buildConfig(process.env);
