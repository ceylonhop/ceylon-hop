import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { compress } from 'hono/compress';
import { secureHeaders } from 'hono/secure-headers';
import { InMemoryBookingRepo, type BookingRepo } from './db/bookingRepo';
import { InMemoryPaymentRepo, type PaymentRepo } from './db/paymentRepo';
import { InMemoryConciergeTaskRepo, type ConciergeTaskRepo } from './db/conciergeTaskRepo';
import { InMemoryDepartureRepo, type DepartureRepo } from './db/departureRepo';
import { FakeEmailAdapter, type EmailAdapter } from './adapters/email';
import { FakePaymentAdapter, type PaymentAdapter } from './adapters/payments';
import { FakeMapsAdapter, type MapsAdapter } from './adapters/maps';
import { bookingRoutes } from './routes/bookings';
import { webhookRoutes } from './routes/webhooks';
import { adminRoutes } from './routes/admin';
import { opsRoutes } from './routes/ops';
import { opsUiRoutes } from './routes/opsUi';
import { quoteRoutes } from './routes/quote';
import { internalQuoteRoutes } from './routes/internalQuote';
import { clientErrorRoutes } from './routes/clientErrors';
import { InMemoryRideOpsRepo, type RideOpsRepo } from './db/rideOpsRepo';
import { InMemoryNotificationLogRepo, type NotificationLogRepo } from './db/notificationLogRepo';
import { InMemoryQuoteRepo, type QuoteRepo } from './db/quoteRepo';
import { LogAlertAdapter, type AlertAdapter } from './adapters/alerts';
import type { AlertLogRepo } from './db/alertLogRepo';
import { track } from './observability/track';
import { rateLimit } from './lib/rateLimit';
import { config } from './config';
import type { JwtVerifier } from './lib/googleAuth';

export interface AppDeps {
  bookings?: BookingRepo;
  payments?: PaymentRepo;
  conciergeTasks?: ConciergeTaskRepo;
  departures?: DepartureRepo;
  email?: EmailAdapter;
  adapter?: PaymentAdapter;
  maps?: MapsAdapter;
  rideOps?: RideOpsRepo;
  notificationLog?: NotificationLogRepo;
  quotes?: QuoteRepo;
  adminApiKey?: string;
  // Signs/verifies customers' view-only "manage my booking" links (GET /bookings/view).
  bookingLinkSecret?: string;
  // Front-end origin used to build those links in emails (defaults to config.APP_BASE_URL).
  bookingBaseUrl?: string;
  auth?: { opsUsers: string; googleClientId: string; opsSessionSecret: string; nodeEnv?: string };
  mapsBrowserKey?: string; // browser Maps JS key templated into the /ops itinerary map
  googleVerifier?: JwtVerifier; // test seam, threaded to opsRoutes only
  allowedOrigins?: string[];
  rateLimit?: { max: number; windowMs: number };
  // M17 — ops alerting seam. The server passes ThrottledAlerts(EmailAlertAdapter|LogAlertAdapter);
  // tests inject FakeAlertAdapter. Defaults to log-only so alerts are always at least visible.
  alerts?: AlertAdapter;
  // M17 — enables POST /webhooks/resend when set (tests inject; server uses config).
  resendWebhookSecret?: string;
  // M17 — /health/deep runs this to prove DB connectivity (server passes SELECT 1;
  // unset in unit tests / dev-in-memory → the deep check reports db:'skipped').
  pingDb?: () => Promise<void>;
  // M17 — alert dedupe ledger + digest recipient (digest only mails when set).
  alertLog?: AlertLogRepo;
  digestTo?: string;
}

// createApp lets tests inject fresh repos/fakes for isolation; the server uses defaults.
export function createApp(deps: AppDeps = {}) {
  const bookings = deps.bookings ?? new InMemoryBookingRepo();
  const payments = deps.payments ?? new InMemoryPaymentRepo();
  const conciergeTasks = deps.conciergeTasks ?? new InMemoryConciergeTaskRepo();
  const departures = deps.departures ?? new InMemoryDepartureRepo();
  const email = deps.email ?? new FakeEmailAdapter();
  const adapter = deps.adapter ?? new FakePaymentAdapter();
  const maps = deps.maps ?? new FakeMapsAdapter();
  const rideOps = deps.rideOps ?? new InMemoryRideOpsRepo();
  const notificationLog = deps.notificationLog ?? new InMemoryNotificationLogRepo();
  const quotes = deps.quotes ?? new InMemoryQuoteRepo();
  const alerts = deps.alerts ?? new LogAlertAdapter();
  const adminApiKey = deps.adminApiKey ?? config.ADMIN_API_KEY;
  const opsAuthCfg = {
    opsUsers: deps.auth?.opsUsers ?? config.OPS_USERS,
    googleClientId: deps.auth?.googleClientId ?? config.GOOGLE_OAUTH_CLIENT_ID,
    sessionSecret: deps.auth?.opsSessionSecret ?? config.OPS_SESSION_SECRET,
    adminApiKey,
    nodeEnv: deps.auth?.nodeEnv ?? config.NODE_ENV,
  };
  const allowedOrigins =
    deps.allowedOrigins ?? config.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  const rl = deps.rateLimit ?? { max: config.RATE_LIMIT_MAX, windowMs: config.RATE_LIMIT_WINDOW_MS };

  const app = new Hono();

  // Security headers on every response — most importantly X-Frame-Options + nosniff, so the
  // cookie-authenticated /ops app can't be framed (clickjacking) or MIME-sniffed. No CSP here:
  // the ops HTML relies on inline scripts/styles and a data: logo.
  app.use('*', secureHeaders({
    // Google Identity Services popup mode needs the opener to allow cross-origin popups.
    // With the stricter default COOP (`same-origin`), Chrome can strand the GIS popup on
    // a blank /gsi/transform page after account selection.
    crossOriginOpenerPolicy: 'same-origin-allow-popups',
  }));

  // Restrict cross-origin browser calls to the live site + local dev. Server-to-server
  // callers (e.g. the PayHere webhook) send no Origin and are unaffected by CORS.
  app.use(
    '*',
    cors({
      origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['content-type', 'idempotency-key', 'x-admin-key', 'x-internal-key'],
    }),
  );

  // Per-IP rate limit on booking writes (not webhooks — those come from PayHere).
  app.use('/bookings/*', rateLimit(rl));
  app.use('/quote', rateLimit(rl));
  // M17: public front-end error beacon — same per-IP write limit as other public endpoints.
  app.use('/errors/*', rateLimit(rl));
  // /admin/quote/* fronts billed Google APIs (GET /places, POST /distance), 2-3 pricing
  // passes per /estimate, and DB writes on /save — its admin-key auth only enforces when
  // configured, so this is a hard backstop. 4x the booking cap: autocomplete legitimately
  // bursts GETs while typing. Subpaths only — Hono's '/admin/quote/*' also matches the bare
  // parent path, so we explicitly pass the exact parent path through untouched, keeping
  // GET /admin/quote (now a bare 302 redirect to /ops — T2) unthrottled, intentionally.
  const adminQuoteLimiter = rateLimit({ ...rl, max: rl.max * 4, methods: ['POST', 'GET'] });
  app.use('/admin/quote/*', (c, next) => (c.req.path === '/admin/quote' ? next() : adminQuoteLimiter(c, next)));

  // Never leak internals on an unexpected failure.
  app.onError((err, c) => {
    console.error(err);
    // M17: report to Sentry (dormant without SENTRY_DSN) + alert the founder. Both are
    // fire-and-forget — the 500 response is identical to before.
    track(err, { route: c.req.path });
    void alerts.send({
      severity: 'critical',
      kind: 'api_error',
      title: `API error on ${c.req.path}: ${err.name}`,
      body: `${c.req.method} ${c.req.path}\n${err.message}`,
      dedupeKey: `${err.name}:${c.req.path}`,
    });
    return c.json({ error: 'internal_error' }, 500);
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));
  // M17: the uptime monitor's target — proves the DB answers, unlike the static /health
  // (which stays fast for keep-warm pings and the booking page's warm-up call).
  app.get('/health/deep', async (c) => {
    if (!deps.pingDb) return c.json({ status: 'ok', db: 'skipped' });
    try {
      await deps.pingDb();
      return c.json({ status: 'ok', db: 'ok' });
    } catch (err) {
      console.error('/health/deep DB check failed:', err);
      void alerts.send({
        severity: 'critical',
        kind: 'db_down',
        title: 'Database check failed on /health/deep',
        body: err instanceof Error ? err.message : String(err),
      });
      return c.json({ status: 'degraded', db: 'down' }, 503);
    }
  });
  app.route(
    '/bookings',
    bookingRoutes({
      bookings,
      payments,
      adapter,
      departures,
      maps,
      conciergeTasks,
      quotes,
      linkSecret: deps.bookingLinkSecret ?? config.BOOKING_LINK_SECRET,
    }),
  );
  app.route('/quote', quoteRoutes({ internalKey: config.INTERNAL_QUOTE_KEY, quotes }));
  app.route(
    '/webhooks',
    webhookRoutes({
      bookings,
      payments,
      adapter,
      email,
      conciergeTasks,
      alerts,
      notificationLog,
      resendWebhookSecret: deps.resendWebhookSecret ?? config.RESEND_WEBHOOK_SECRET,
      baseUrl: deps.bookingBaseUrl ?? config.APP_BASE_URL,
      linkSecret: deps.bookingLinkSecret ?? config.BOOKING_LINK_SECRET,
    }),
  );
  app.route('/errors/client', clientErrorRoutes({ alerts }));
  app.route('/admin/ops', opsRoutes({
    bookings, payments, rideOps, auth: opsAuthCfg, googleVerifier: deps.googleVerifier,
    email, notificationLog,
    baseUrl: deps.bookingBaseUrl ?? config.APP_BASE_URL,
    linkSecret: deps.bookingLinkSecret ?? config.BOOKING_LINK_SECRET,
  }));
  // The /ops shell is a ~190KB self-contained HTML app (ops dashboard + embedded quote view).
  // gzip it (~40KB on the wire) for every founder page load. Transparent to non-gzip clients
  // (Hono's compress only fires when the request sends Accept-Encoding: gzip/deflate).
  app.use('/ops', compress());
  app.route('/ops', opsUiRoutes(opsAuthCfg.googleClientId, opsAuthCfg.nodeEnv !== 'production', deps.mapsBrowserKey ?? config.MAPS_BROWSER_KEY ?? ''));
  // internal quoting tool — D-A: opens to all 3 roles via quote:manage (opsIdentity +
  // requireCap, same as /admin/ops); x-admin-key resolves to `system`, which lacks
  // quote:manage (403) — a leaked cron key cannot see customer PII or issue quotes.
  // allowedOrigins: CSRF allow-list for the tool's mutation routes (T2), unchanged.
  app.route('/admin/quote', internalQuoteRoutes({
    maps, quotes,
    auth: opsAuthCfg,
    allowedOrigins,
  }));
  // T-E: cancel/refund require payments:act (founder or finance, human session only —
  // system/x-admin-key lacks payments:act per the matrix, spec D6). Cron/watchdog stay
  // machine-driven via admin:jobs (system or founder).
  app.route(
    '/admin',
    adminRoutes({
      bookings,
      departures,
      email,
      notificationLog,
      auth: opsAuthCfg,
      alerts,
      alertLog: deps.alertLog,
      digestTo: deps.digestTo ?? config.ALERT_EMAIL,
      baseUrl: deps.bookingBaseUrl ?? config.APP_BASE_URL,
      linkSecret: deps.bookingLinkSecret ?? config.BOOKING_LINK_SECRET,
    }),
  );
  return app;
}

export const app = createApp();
