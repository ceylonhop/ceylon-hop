import { defineConfig, devices } from '@playwright/test';

// Serves the static site (same minimal server the preview uses) and runs the
// e2e specs against it. Google Maps, PayHere and the API are stubbed per-test
// (see e2e/_stubs.js) so the suite is deterministic and fully offline.
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
    {
      // The API serves the internal quoting tool at /admin/quote (see quote-tool.spec.js).
      command: 'npm --prefix ../api run dev',
      url: 'http://localhost:8787/health',
      reuseExistingServer: true,
      timeout: 60000,
    },
  ],
});
