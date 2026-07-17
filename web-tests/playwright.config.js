import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveStaticPort } from './static-port.js';

// Serves the static site (same minimal server the preview uses) and runs the
// e2e specs against it. Google Maps, PayHere and the API are stubbed per-test
// (see e2e/_stubs.js) so the suite is deterministic and fully offline BY DEFAULT.
//
// The quote-tool and ops-ui specs are the exception: they exercise the real
// merged ops⇄quote dashboard served by the API at /ops (the quoting tool is a
// view mounted inside it, open to all 3 roles per spec D-A — see
// api/src/routes/ops-ui.html), which needs a reachable database and writes real
// rows to it. Those specs are skipped unless you opt in with CH_E2E_API=1, which
// also boots the API webServer below (see package.json's
// "test:e2e:tool"/"test:e2e:ops" scripts).
//
// Those writes go to DATABASE_URL_TEST — never the API's own DATABASE_URL. See the
// guard below for why.

const E2E_API = process.env.CH_E2E_API === '1';

// Static-server port: per-worktree by default so concurrent checkouts never
// reuse each other's server (see static-port.js for the incident that motivated
// this); set CH_STATIC_PORT to pin it, e.g. to reuse a preview on 4173.
const STATIC_PORT = resolveStaticPort(process.env, fileURLToPath(new URL('..', import.meta.url)));

// Read ONLY DATABASE_URL_TEST out of api/.env. Deliberately does NOT load that file
// into process.env: it also holds the production DATABASE_URL, and the test runner has
// no business carrying prod credentials around.
function testDbFromApiEnv() {
  try {
    const path = fileURLToPath(new URL('../api/.env', import.meta.url));
    const m = readFileSync(path, 'utf8').match(/^DATABASE_URL_TEST=(.*)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
  } catch {
    return undefined;
  }
}

const TEST_DB = process.env.DATABASE_URL_TEST || testDbFromApiEnv();

// Fail closed. These specs write quote rows to whatever DB the booted API resolves.
// Until 2026-07-17 there was no test DB and no guard: the API fell back to api/.env's
// DATABASE_URL — production — and a run of the ops-e2e suite left 45 "E2E …" quotes in
// the live quoting tool alongside real customers. Refuse to run rather than guess.
if (E2E_API && !TEST_DB) {
  throw new Error(
    'CH_E2E_API=1 requires DATABASE_URL_TEST — these specs write quote rows to a real DB.\n' +
      "Without it the booted API falls back to api/.env's DATABASE_URL, which is PRODUCTION.\n" +
      'Set it in api/.env or the environment, e.g.\n' +
      '  DATABASE_URL_TEST=postgresql://postgres:postgres@localhost:5432/ceylonhop_test\n' +
      '(same value .github/workflows/ci.yml provisions for CI).',
  );
}

export default defineConfig({
  testDir: './e2e',
  // Fails the CH_E2E_API run fast if the API port is owned by something that isn't the
  // Ceylon Hop API. Playwright's own readiness probe can't catch that: it only checks the
  // status code and accepts 401, so a squatter looks "ready" and reuseExistingServer keeps
  // the real API from booting — surfacing as 26 baffling "#login not found" failures.
  // See api-guard.js.
  globalSetup: './global-setup.js',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Retry once everywhere (not just CI): the heavy ops-SPA specs occasionally time out on a
  // per-action wait under parallel CPU contention on a busy dev machine (they pass in isolation),
  // so a single retry absorbs those transient timeouts and keeps the local full run green.
  retries: 1,
  reporter: process.env.CI ? 'github' : 'list',
  // The quote-tool/ops-ui specs share one connection pool. Each Playwright worker opens
  // its own browser and fires concurrent DB-backed requests (loadQueue, /admin/quote/*),
  // so a full 8-worker fan-out can exhaust the pool and 500 on /admin/ops/bookings. Cap
  // workers only for the CH_E2E_API run; the offline default suite is unaffected.
  workers: E2E_API ? 4 : undefined,
  use: {
    baseURL: `http://localhost:${STATIC_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'node ../serve-booking.js',
      url: `http://localhost:${STATIC_PORT}/index.html`,
      reuseExistingServer: true,
      timeout: 30000,
      env: { ...process.env, CH_STATIC_PORT: String(STATIC_PORT) },
    },
    ...(E2E_API ? [
      {
        // The API serves the merged ops⇄quote dashboard at /ops (see quote-tool.spec.js
        // and ops-ui.spec.js) — the quoting tool is a view inside it open to all 3 roles.
        // Only booted when CH_E2E_API=1, and only ever against DATABASE_URL_TEST.
        command: 'npm --prefix ../api run dev',
        url: 'http://localhost:8787/health',
        reuseExistingServer: true,
        timeout: 60000,
        env: {
          ...process.env,
          // Point the booted API at the TEST database. This MUST be set explicitly:
          // the API's config does `import 'dotenv/config'` and would otherwise resolve
          // api/.env's production DATABASE_URL. dotenv never overwrites a var that is
          // already set, so this assignment wins and prod is never reachable from a test.
          DATABASE_URL: TEST_DB,
          // The test DB is disposable, so let the API self-apply pending migrations on
          // boot — the same fail-closed path Render uses (api/src/server.ts). A fresh
          // local Postgres then needs no manual `npm run migrate`.
          RUN_MIGRATIONS: '1',
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
