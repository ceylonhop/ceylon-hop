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
  // Dedicated callback for Ride Board card preapprovals. This receives customer_token,
  // not an ordinary payment event, so it must never share /webhooks/payments.
  PAYHERE_RIDE_NOTIFY_URL: z.string().url().optional(),
  // Refund API (PayHere Settings -> API Keys, permission "Automated Charging API"). Optional
  // and deliberately NOT required in production: without them the ops UI simply offers the
  // manual dashboard refund, which is a supported flow rather than a degraded one.
  PAYHERE_APP_ID: z.string().optional(),
  PAYHERE_APP_SECRET: z.string().optional(),
  // Escape hatch for a NON-PRODUCTION deployment that still runs with NODE_ENV=production —
  // staging on Render is exactly that, and it deliberately uses the fake payment adapter.
  // Must be set deliberately: unset (the default) means real production fails closed.
  // NEVER set this on the environment that takes real money.
  ALLOW_FAKE_PAYMENTS: z.string().optional(),
  APP_BASE_URL: z.string().default('http://localhost:4173'),
  // Origin serving /ops — used to deep-link internal emails straight to a quote. Distinct
  // from APP_BASE_URL (the customer site): the ops tool is served by the API host.
  OPS_BASE_URL: z.string().default(''),
  // Public origin the Ride Board's share links are built from — the ride domain
  // (e.g. https://ride.ceylonhop.com), a second custom domain on this same service.
  // Unset: links are built from whichever host the request arrived on.
  SHARE_BASE_URL: z.string().default(''),
  // Public origin the CUSTOMER pay/manage links are built from — the pay domain
  // (e.g. https://pay.ceylonhop.com), a second custom domain on this same service, same
  // pattern as SHARE_BASE_URL above. Deliberately NOT APP_BASE_URL: that one also drives
  // the site links in three emails and PayHere's return_url/cancel_url, so repointing it to
  // move a payment link would drag all of that onto the pay domain too. A customer-facing
  // link reading ops.<domain> is what prompted this (owner, 2026-07-31).
  // Unset: falls back to APP_BASE_URL, i.e. exactly the behaviour before this existed.
  PAY_BASE_URL: z.string().default(''),
  // Where customer QUOTE links point (spec 2026-08-05 D2) — e.g. https://quote.ceylonhop.com.
  // A second custom domain on THIS service, so the page it serves is same-origin with the API.
  // Unset falls back to PAY_BASE_URL, which keeps dev and staging working with one host.
  QUOTE_BASE_URL: z.string().default(''),
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
  // Founder manual discounts (spec 2026-08-09 §11). Gates CREATION only: reading and honouring an
  // already-stored discount is unconditional, so turning this off never rewrites a price a
  // customer has already been shown.
  OPS_MANUAL_DISCOUNTS_ENABLED: z
    .enum(['0', '1', 'false', 'true'])
    .default('false')
    .transform((value) => value === '1' || value === 'true'),
  QUOTE_V2_ENABLED: z
    .enum(['0', '1', 'false', 'true'])
    .default('false')
    .transform((value) => value === '1' || value === 'true'),
  // Temporary rollout seam: staging may accept the legacy tokenless checkout while the
  // website deploy catches up. Default-off; live production with real payments rejects it.
  CHECKOUT_TOKEN_COMPATIBILITY: z
    .enum(['0', '1', 'false', 'true'])
    .default('false')
    .transform((value) => value === '1' || value === 'true'),
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
  // Notification blast-radius cap (docs/notification-safety-rails-spec.md, R1). The most
  // outbound emails ONE cron tick may send before it stops and pages the founder. Guards the
  // case notification_log cannot: a migration or status backfill making a batch of old
  // bookings newly eligible all at once. 25 is far above any legitimate tick at current
  // volume and far below a blast; raise it (and re-run the tick) if a real day needs more.
  NOTIFY_MAX_PER_RUN: z.coerce.number().default(25),
  // Outbound mail guard (same spec, R3). Both default to "off" so production is unchanged.
  // EMAIL_ALLOWLIST: when set, ONLY these recipients can be mailed — entries are exact
  // addresses or an `@domain` suffix, comma-separated. STAGING SETS THIS (`@ceylonhop.com`),
  // which is what makes it structurally unable to email a real customer instead of merely
  // conventionally unable (docs/staging-environment-plan.md).
  EMAIL_ALLOWLIST: z.string().default(''),
  // Relevance window (same spec, R6). Never notify about a trip that ended more than this
  // many days ago — stateless, so an emptied or restored notification_log cannot resurrect
  // an old booking. 30 days is well past any legitimate review request.
  NOTIFY_MAX_TRIP_AGE_DAYS: z.coerce.number().default(30),
  // Notification epoch (R6), ISO date. Never notify about a booking TAKEN before this.
  // Unset by default; set it to the go-live date to fence off the pre-launch backlog
  // permanently, in the direction the age window cannot cover (future-dated backfills).
  NOTIFY_EPOCH: z.string().default(''),
  // NOTIFICATIONS_ENABLED: the lever to throw WHILE a burst is happening. Stops customer
  // mail; ops alerts still go out, because silencing them would hide the incident.
  NOTIFICATIONS_ENABLED: z
    .enum(['0', '1', 'false', 'true'])
    .default('true')
    .transform((value) => value === '1' || value === 'true'),
});

// Ops⇄quote merge T1: the founder ops-session cookie now unlocks /admin/quote (margin +
// customer PII), so a defaulted OPS_SESSION_SECRET in production would let anyone who reads
// the repo mint a valid founder cookie. Fail CLOSED at boot; dev/test keep the default.
const DEV_OPS_SECRET = 'dev-ops-secret-change-me';
const DEV_BOOKING_SECRET = 'dev-booking-link-secret-change-me';
const DEV_CUSTOMER_SECRET = 'dev-customer-secret-change-me';

// A deployment opts in to fake payments explicitly; anything else (unset, empty, '0', 'false')
// leaves the production guard armed.
export function allowFakePayments(v: string | undefined): boolean {
  const t = String(v ?? '').trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes';
}

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
  if (
    cfg.NODE_ENV === 'production' &&
    cfg.CHECKOUT_TOKEN_COMPATIBILITY &&
    !allowFakePayments(cfg.ALLOW_FAKE_PAYMENTS)
  ) {
    throw new Error(
      'CHECKOUT_TOKEN_COMPATIBILITY cannot be enabled in live production — ' +
        'tokenless checkout is a staging-only rollout seam.',
    );
  }
  // Without PayHere credentials the payment seam silently falls back to FakePaymentAdapter,
  // whose webhook signing key is a constant in this repo — so anyone could forge a "succeeded"
  // webhook and mark their own booking paid for nothing. Money must never fail open.
  if (
    cfg.NODE_ENV === 'production' &&
    !(cfg.PAYHERE_MERCHANT_ID && cfg.PAYHERE_MERCHANT_SECRET) &&
    !allowFakePayments(cfg.ALLOW_FAKE_PAYMENTS)
  ) {
    throw new Error(
      'PAYHERE_MERCHANT_ID and PAYHERE_MERCHANT_SECRET must both be set in production ' +
        '(without them the fake payment adapter would accept forged webhooks and mark ' +
        'bookings paid without a real charge) — refusing to boot. If this is a staging ' +
        'deployment that runs on fake payments, set ALLOW_FAKE_PAYMENTS=1 there.',
    );
  }
  if (
    cfg.NODE_ENV === 'production' &&
    !allowFakePayments(cfg.ALLOW_FAKE_PAYMENTS) &&
    !(cfg.PAYHERE_APP_ID && cfg.PAYHERE_APP_SECRET && cfg.PAYHERE_RIDE_NOTIFY_URL)
  ) {
    throw new Error(
      'PAYHERE_APP_ID, PAYHERE_APP_SECRET and PAYHERE_RIDE_NOTIFY_URL must be set in production ' +
        'so Ride Board joins use real PayHere preapproval and Automated Charging — refusing to boot.',
    );
  }
  return cfg;
}

export const config = buildConfig(process.env);
