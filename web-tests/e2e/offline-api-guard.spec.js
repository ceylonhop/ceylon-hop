import { test, expect } from '@playwright/test';

// The offline suite must never address a real API host.
//
// Every root page carries an inline error reporter that beacons to a HARDCODED production
// URL (window.CEYLON_HOP_API || 'https://ceylon-hop-api.onrender.com') on ANY JS error, and
// it prefers navigator.sendBeacon — which page.route() does not intercept. Per-spec stubbing
// therefore cannot be relied on, and in practice was forgotten: pay-page.spec.js drives
// pay/start to bad_request in seven places with no guard at all, which mailed real
// client_error alerts to the founder on every local and CI run (2026-08-23).
//
// serve-booking.js now re-points /errors/client at this server's own origin for every page it
// serves under CH_TEST_OFFLINE_API=1, leaving window.CEYLON_HOP_API alone (moving the base
// un-stubs the ride-board specs, which match the API by hostname). This is the guard on that
// guard: it drives a real error through the REAL beacon path — sendBeacon is deliberately NOT
// disabled here, unlike error-beacon.spec.js — and fails if anything is addressed to a live host.

const LIVE_HOST = /onrender\.com|ceylonhop\.com/i;

// Covers ALL live-API traffic, not just the beacon: loading these pages unstubbed also fired
// GET /health (index, booking) and GET /quotes/pay/view (pay) at the live API. Those are
// payload-free GETs that alert nobody, but they made CI depend on prod being reachable —
// a cold Render instance answers slowly — so the rewrite now covers every API request.

// Beacon pages reached three different ways: a token page, the home page, and the booking
// page (which also resolves its base from ?api=).
const PAGES = ['/pay.html?t=test-token', '/index.html', '/booking.html'];

for (const target of PAGES) {
  test(`no live API host is contacted from ${target}`, async ({ page }) => {
    const hits = [];
    page.on('request', (r) => {
      let host = '';
      try { host = new URL(r.url()).hostname; } catch { return; }
      if (LIVE_HOST.test(host)) hits.push(r.url());
    });

    await page.goto(target);

    // Fire the reporter for real: an uncaught error is exactly what pay.html's refusal path
    // produces, and the reporter takes its sendBeacon branch here.
    await page.evaluate(() => { setTimeout(() => { throw new Error('offline-guard-probe'); }, 0); });
    await expect.poll(async () => {
      await page.waitForTimeout(120);
      return hits.length;
    }, { timeout: 3000, message: 'a request reached a live API host' }).toBe(0);

    expect(hits, `requests addressed to a live host: ${hits.join(', ')}`).toEqual([]);
  });
}
