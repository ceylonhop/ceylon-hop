import { Hono } from 'hono';
import { cors } from 'hono/cors';
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
import { quoteRoutes } from './routes/quote';
import { internalQuoteRoutes } from './routes/internalQuote';
import { InMemoryRideOpsRepo, type RideOpsRepo } from './db/rideOpsRepo';
import { InMemoryCoordinatorRepo, type CoordinatorRepo } from './db/coordinatorRepo';
import { InMemoryNotificationLogRepo, type NotificationLogRepo } from './db/notificationLogRepo';
import { InMemoryQuoteRepo, type QuoteRepo } from './db/quoteRepo';
import { rateLimit } from './lib/rateLimit';
import { config } from './config';

export interface AppDeps {
  bookings?: BookingRepo;
  payments?: PaymentRepo;
  conciergeTasks?: ConciergeTaskRepo;
  departures?: DepartureRepo;
  email?: EmailAdapter;
  adapter?: PaymentAdapter;
  maps?: MapsAdapter;
  rideOps?: RideOpsRepo;
  coordinators?: CoordinatorRepo;
  notificationLog?: NotificationLogRepo;
  quotes?: QuoteRepo;
  adminApiKey?: string;
  auth?: { opsSupportKey: string; opsFounderKey: string; opsSessionSecret: string };
  allowedOrigins?: string[];
  rateLimit?: { max: number; windowMs: number };
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
  const coordinators = deps.coordinators ?? new InMemoryCoordinatorRepo();
  const notificationLog = deps.notificationLog ?? new InMemoryNotificationLogRepo();
  const quotes = deps.quotes ?? new InMemoryQuoteRepo();
  const adminApiKey = deps.adminApiKey ?? config.ADMIN_API_KEY;
  const opsAuthCfg = {
    supportKey: deps.auth?.opsSupportKey ?? config.OPS_SUPPORT_KEY,
    founderKey: deps.auth?.opsFounderKey ?? config.OPS_FOUNDER_KEY,
    sessionSecret: deps.auth?.opsSessionSecret ?? config.OPS_SESSION_SECRET,
    adminApiKey,
  };
  const allowedOrigins =
    deps.allowedOrigins ?? config.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  const rl = deps.rateLimit ?? { max: config.RATE_LIMIT_MAX, windowMs: config.RATE_LIMIT_WINDOW_MS };

  const app = new Hono();

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
  // /admin/quote/* fronts billed Google APIs (GET /places, POST /distance), 2-3 pricing
  // passes per /estimate, and DB writes on /save — its admin-key auth only enforces when
  // configured, so this is a hard backstop. 4x the booking cap: autocomplete legitimately
  // bursts GETs while typing. Subpaths only — Hono's '/admin/quote/*' also matches the bare
  // parent path, so we explicitly pass the exact shell path through untouched, keeping
  // GET /admin/quote (the HTML shell) unthrottled, intentionally.
  const adminQuoteLimiter = rateLimit({ ...rl, max: rl.max * 4, methods: ['POST', 'GET'] });
  app.use('/admin/quote/*', (c, next) => (c.req.path === '/admin/quote' ? next() : adminQuoteLimiter(c, next)));

  // Never leak internals on an unexpected failure.
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal_error' }, 500);
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.route('/bookings', bookingRoutes({ bookings, payments, adapter, departures, maps }));
  app.route('/quote', quoteRoutes({ internalKey: config.INTERNAL_QUOTE_KEY }));
  app.route('/webhooks', webhookRoutes({ bookings, payments, adapter, email, conciergeTasks }));
  app.route('/admin/ops', opsRoutes({ bookings, payments, rideOps, coordinators, auth: opsAuthCfg }));
  // internal quoting tool — keyless access is a dev-only convenience; production fails closed (GL-1c)
  app.route('/admin/quote', internalQuoteRoutes({ maps, quotes, adminKey: adminApiKey, allowNoKey: config.NODE_ENV !== 'production' }));
  app.route('/admin', adminRoutes({ bookings, email, notificationLog, adminApiKey }));
  return app;
}

export const app = createApp();
