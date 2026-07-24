import 'dotenv/config';
import { z } from 'zod';

// The public, referrer-restricted browser Maps JS key the website already uses. The ops
// itinerary map defaults to it (no separate config needed) — just add the ops/API domain to
// this key's HTTP-referrer allowlist in the Google console. Override with MAPS_BROWSER_KEY.
const DEFAULT_MAPS_BROWSER_KEY = 'AIzaSyDY-pFmqV4eIax2hhsdj96YD1c8Em-srCI';

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
  // Origin serving /ops — used to deep-link internal emails straight to a quote. Distinct
  // from APP_BASE_URL (the customer site): the ops tool is served by the API host.
  OPS_BASE_URL: z.string().default(''),
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
  // Browser (referrer-restricted) Maps JS key for the ops itinerary map — templated into
  // the /ops HTML client-side. Separate from GOOGLE_MAPS_API_KEY (a server key restricted to
  // Distance Matrix). Defaults to the website's public browser key; set MAPS_BROWSER_KEY only
  // to use a different one. Either way, the ops domain must be in the key's referrer allowlist.
  MAPS_BROWSER_KEY: z.string().default(DEFAULT_MAPS_BROWSER_KEY),
  // Email (M4). When RESEND_API_KEY is set, the server sends real mail via Resend;
  // otherwise the fake adapter (records only). EMAIL_FROM must be a Resend-verified
  // sender (use onboarding@resend.dev for testing before the domain is verified).
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Ceylon Hop <onboarding@resend.dev>'),
  EMAIL_REPLY_TO: z.string().optional(),
  // Ops/quote auth (Google sign-in + capability roles). See docs/go-live-checklist.md.
  // OPS_USERS = "email:role,email:role" over roles founder|finance|ops (exactly the 3 staff).
  OPS_USERS: z.string().default(''),
  GOOGLE_OAUTH_CLIENT_ID: z.string().default(''),
  OPS_SESSION_SECRET: z.string().default('dev-ops-secret-change-me'),
  // Signs the view-only "manage my booking" link tokens (customer-facing #2). A DEDICATED
  // secret (not OPS_SESSION_SECRET) so customer links and ops sessions can't cross-replay.
  // Set to a strong unique value at launch — see docs/go-live-checklist.md.
  BOOKING_LINK_SECRET: z.string().default('dev-booking-link-secret-change-me'),
  // Quote engine internal key — passed to quoteRoutes to gate marginEstimateCents.
  INTERNAL_QUOTE_KEY: z.string().default(''),
  // Ride Board customer session (first customer-facing auth) — signs the ch_cust cookie.
  // A DEDICATED secret (not OPS_SESSION_SECRET) so a customer session can never be
  // cross-replayed as a staff session. Set to a strong unique value at launch.
  CUSTOMER_SESSION_SECRET: z.string().default('dev-customer-secret-change-me'),
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
const DEV_BOOKING_SECRET = 'dev-booking-link-secret-change-me';
const DEV_CUSTOMER_SECRET = 'dev-customer-secret-change-me';

// Exported for tests: build (and validate) a config from an arbitrary env.
export function buildConfig(env: Record<string, string | undefined>) {
  const cfg = Env.parse(env);
  if (cfg.NODE_ENV === 'production' && (!cfg.OPS_SESSION_SECRET || cfg.OPS_SESSION_SECRET === DEV_OPS_SECRET)) {
    throw new Error(
      'OPS_SESSION_SECRET must be set to a strong unique value in production ' +
        '(the default would let anyone forge a founder session cookie) — refusing to boot',
    );
  }
  // Same fail-closed guard for the booking-link secret: the default would let anyone who reads
  // the repo mint a valid view-only "manage my booking" token and read a customer's PII.
  if (cfg.NODE_ENV === 'production' && (!cfg.BOOKING_LINK_SECRET || cfg.BOOKING_LINK_SECRET === DEV_BOOKING_SECRET)) {
    throw new Error(
      'BOOKING_LINK_SECRET must be set to a strong unique value in production ' +
        '(the default would let anyone forge a booking-view token and read customer PII) — refusing to boot',
    );
  }
  // Same fail-closed guard for the customer-session secret: the default would let anyone
  // forge a customer session cookie (add names to lists / scratch others' names).
  if (cfg.NODE_ENV === 'production' && (!cfg.CUSTOMER_SESSION_SECRET || cfg.CUSTOMER_SESSION_SECRET === DEV_CUSTOMER_SECRET)) {
    throw new Error(
      'CUSTOMER_SESSION_SECRET must be set to a strong unique value in production ' +
        '(the default would let anyone forge a customer session) — refusing to boot',
    );
  }
  return cfg;
}

export const config = buildConfig(process.env);
