import { defineConfig, devices } from '@playwright/test';

// Serves the static site (same minimal server the preview uses) and runs the
// e2e specs against it. Google Maps, PayHere and the API are stubbed per-test
// (see e2e/_stubs.js) so the suite is deterministic and fully offline BY DEFAULT.
//
// The quote-tool and ops-ui specs are the exception: they exercise the real
// merged ops⇄quote dashboard served by the API at /ops (the quoting tool is a
// view mounted inside it, open to all 3 roles per spec D-A — see
// api/src/routes/ops-ui.html), which needs a reachable DATABASE_URL and writes
// rows to that DB. Those specs are skipped unless you opt in with CH_E2E_API=1,
// which also boots the API webServer below (see package.json's
// "test:e2e:tool"/"test:e2e:ops" scripts).
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  // The quote-tool/ops-ui specs share one Supabase session-mode pool (pool_size: 15 —
  // see api/.env's DATABASE_URL). Each Playwright worker opens its own browser and fires
  // concurrent DB-backed requests (loadQueue, /admin/quote/*), so a full 8-worker fan-out
  // can exhaust the pool and 500 on /admin/ops/bookings. Cap workers only for the
  // CH_E2E_API run; the offline default suite is unaffected.
  workers: process.env.CH_E2E_API === '1' ? 4 : undefined,
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'node ../serve-booking.js',
      url: 'http://localhost:4173/index.html',
      reuseExistingServer: true,
      timeout: 30000,
    },
    ...(process.env.CH_E2E_API === '1' ? [
      {
        // The API serves the merged ops⇄quote dashboard at /ops (see quote-tool.spec.js
        // and ops-ui.spec.js) — the quoting tool is a view inside it open to all 3 roles.
        // Needs DATABASE_URL (api/.env) — only booted when CH_E2E_API=1.
        command: 'npm --prefix ../api run dev',
        url: 'http://localhost:8787/health',
        reuseExistingServer: true,
        timeout: 60000,
        env: {
          ...process.env,
          // Parallel specs share one IP; the /admin/quote rate limiter (RATE_LIMIT_MAX*4)
          // saturates near the tail of a full run. Raise the cap for the test server only.
          RATE_LIMIT_MAX: '200',
          // The booted API needs an allowlist + a session secret for the /ops dev-login
          // flow the specs drive (Google Sign-In isn't usable in e2e). Dev defaults so
          // the suite runs out of the box; pass through process.env values (e.g. from
          // api/.env) if already set. NODE_ENV must NOT be 'production' or the API 404s
          // POST /admin/ops/dev-login (devBypassEnabled() in api/src/lib/opsMiddleware.ts).
          NODE_ENV: process.env.NODE_ENV === 'production' ? 'development' : (process.env.NODE_ENV || 'development'),
          OPS_USERS: process.env.OPS_USERS || 'founder@e2e.test:founder,finance@e2e.test:finance,ops@e2e.test:ops',
          OPS_SESSION_SECRET: process.env.OPS_SESSION_SECRET || 'dev-ops-secret-change-me',
        },
      },
    ] : []),
  ],
});
