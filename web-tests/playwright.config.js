import { defineConfig, devices } from '@playwright/test';

// Serves the static site (same minimal server the preview uses) and runs the
// e2e specs against it. Google Maps, PayHere and the API are stubbed per-test
// (see e2e/_stubs.js) so the suite is deterministic and fully offline BY DEFAULT.
//
// The quote-tool specs are the one exception: they exercise the real internal
// quoting tool served by the API at /admin/quote, which needs a reachable
// DATABASE_URL and writes rows to that DB. Those specs are skipped unless you
// opt in with CH_E2E_API=1, which also boots the API webServer below (see
// package.json's "test:e2e:tool" script).
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
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
        // The API serves the internal quoting tool at /admin/quote (see quote-tool.spec.js).
        // Needs DATABASE_URL (api/.env) — only booted when CH_E2E_API=1.
        command: 'npm --prefix ../api run dev',
        url: 'http://localhost:8787/health',
        reuseExistingServer: true,
        timeout: 60000,
        // Parallel specs share one IP; the /admin/quote rate limiter (RATE_LIMIT_MAX*4)
        // saturates near the tail of a full run. Raise the cap for the test server only.
        env: { ...process.env, RATE_LIMIT_MAX: '200' },
      },
    ] : []),
  ],
});
