import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// Loading every key page should not throw uncaught JS errors. Aborted stub
// resources (payhere.js, maps) produce benign "failed to load" console noise,
// which we filter — the real signal is uncaught exceptions + genuine errors.
const PAGES = [
  { path: '/index.html', query: '' },
  { path: '/search.html', query: 'from=cmb-airport&to=ella&pax=2' },
  { path: '/booking.html', query: 'mode=private&from=cmb-airport&to=hikkaduwa&price=121&vehicle=car' },
  { path: '/plan.html', query: 'stops=cmb-airport|kandy|ella&pax=2&vehicle=car' },
  { path: '/tour.html', query: '' },
];

const ignore = (text) =>
  /Failed to load resource|ERR_FAILED|ERR_ABORTED|net::|favicon|payhere\.lk|googleapis/i.test(text);

for (const p of PAGES) {
  test(`no uncaught errors on ${p.path}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !ignore(m.text())) errors.push(`console: ${m.text()}`); });

    await gotoBooking(page, { path: p.path, query: p.query });
    await page.waitForTimeout(600);

    expect(errors, errors.join('\n')).toEqual([]);
  });
}
