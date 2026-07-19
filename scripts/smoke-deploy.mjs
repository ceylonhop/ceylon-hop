#!/usr/bin/env node
// Post-deploy smoke test (guard G5). Proves a just-deployed API is actually serving AND its
// database answers — not just that the process booted. Exits non-zero on any failure so it can
// gate a deploy / promotion.
//
//   node scripts/smoke-deploy.mjs <baseUrl>
//   node scripts/smoke-deploy.mjs https://ceylon-hop-api-staging.onrender.com
//
// Checks (read-only — safe against production, writes no rows):
//   1. GET /health       → 200 {status:"ok"}          (process is up)
//   2. GET /health/deep  → 200 {status:"ok",db:"ok"}   (DB connection + SELECT 1 works)
//
// Free-tier Render services sleep after inactivity, so the first request can take 30–60s to
// wake the container. We retry with backoff for up to ~2 minutes before giving up.

const baseUrl = process.argv[2]?.replace(/\/$/, '');
if (!baseUrl) {
  console.error('usage: node scripts/smoke-deploy.mjs <baseUrl>');
  process.exit(2);
}

const MAX_WAIT_MS = 120_000; // total budget to absorb a cold start
const PER_TRY_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_TRY_TIMEOUT_MS);
  try {
    const res = await fetch(baseUrl + path, { signal: ctrl.signal });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// Retry a check until it passes or the overall budget runs out (handles cold starts).
async function waitFor(name, path, assertOk) {
  const deadline = Date.now() + MAX_WAIT_MS;
  let attempt = 0;
  let lastErr = 'no attempt made';
  while (Date.now() < deadline) {
    attempt++;
    try {
      const { status, body } = await fetchJson(path);
      const problem = assertOk(status, body);
      if (!problem) {
        console.log(`  ✓ ${name} (attempt ${attempt})`);
        return true;
      }
      lastErr = `${problem} — got ${status} ${JSON.stringify(body)}`;
    } catch (err) {
      lastErr = err.name === 'AbortError' ? 'request timed out (cold start?)' : String(err);
    }
    const backoff = Math.min(8000, 1000 * attempt);
    console.log(`  … ${name} not ready (${lastErr}); retrying in ${backoff / 1000}s`);
    await sleep(backoff);
  }
  console.error(`  ✗ ${name} FAILED after ${attempt} attempts: ${lastErr}`);
  return false;
}

console.log(`Smoke-testing ${baseUrl}`);

const healthOk = await waitFor('GET /health', '/health', (status, body) =>
  status === 200 && body && body.status === 'ok' ? null : 'expected 200 {status:"ok"}',
);

const deepOk = await waitFor('GET /health/deep', '/health/deep', (status, body) =>
  status === 200 && body && body.status === 'ok' && body.db === 'ok'
    ? null
    : 'expected 200 {status:"ok",db:"ok"}',
);

if (healthOk && deepOk) {
  console.log('Smoke PASSED — API is serving and the database answers.');
  process.exit(0);
}
console.error('Smoke FAILED — do not treat this deploy as healthy.');
process.exit(1);
