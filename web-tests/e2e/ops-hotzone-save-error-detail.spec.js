import { test, expect } from '@playwright/test';

// Follow-up to #972 (which fixed apiBook() only): POST/PATCH /admin/quote/zones answer a Zod
// failure with `{ error: 'bad_request', detail: <first issue message> }`, but hzSubmitZone() got
// the response through errPayload(), which kept only `{ error }` — so the founder saw a bare
// "Check the values" with no hint WHICH value (the one the client does not pre-check is the
// 120-char town limit). Drives the REAL Rates page control (fill → Add zone → shell toast) with
// the route stubbed, like ops-book-error-message.spec.js. Offline: every /admin/** is stubbed.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

const DETAIL = 'String must contain at most 120 character(s)';

// Open the Rates page as a founder and submit the Add-a-zone form — with POST /zones answering `answer`.
async function addZone(page, answer) {
  const posts = [];
  await page.addInitScript(() => {
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: {
        Map: function () {}, DirectionsService: function () {}, DirectionsRenderer: function () {},
        TravelMode: { DRIVING: 'DRIVING' }, importLibrary: async () => ({}),
      },
    };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) =>
    r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage', 'quote:approve', 'margin:view'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/zones', (r) => {
    if (r.request().method() === 'POST') { posts.push(r.request().postData()); return r.fulfill(answer); }
    return r.fulfill(json({ zones: [], disabled: false }));
  });
  // Rate card unavailable → "Loading rate card…" placeholder; the Hot-zones panel renders independently.
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill({ status: 500, body: '' }));
  await page.route('**/admin/quote/places**', (r) => r.fulfill(json({ places: [], suggestions: [] })));

  await page.goto(OPS_FILE + '#rates');
  await expect(page.locator('#hz-place')).toBeVisible({ timeout: 10000 });
  await page.locator('#hz-place').fill('Ella');
  await page.locator('#hz-boost').fill('15');
  await page.locator('[data-action="hzSubmit"]').click();
  // The refusal under test is the SERVER's: the request really went out.
  await expect.poll(() => posts.length).toBe(1);
}
const toast = (page) => page.locator('#toast');

test('a rejected zone field: the toast carries the server detail, not just "Check the values"', async ({ page }) => {
  await addZone(page, json({ error: 'bad_request', detail: DETAIL }, 400));
  await expect(toast(page)).toHaveClass(/show/);
  await expect(toast(page)).toHaveClass(/bad/);
  await expect(toast(page)).toContainText('Check the values — ' + DETAIL);
});

test('a bad_request without detail still reads "Check the values"', async ({ page }) => {
  await addZone(page, json({ error: 'bad_request' }, 400));
  await expect(toast(page)).toHaveClass(/bad/);
  await expect(toast(page)).toHaveText('Check the values');
});

test('a non-JSON 500 still falls back to the status code', async ({ page }) => {
  await addZone(page, { status: 500, contentType: 'text/html', body: '<html><body>Internal Server Error</body></html>' });
  await expect(toast(page)).toHaveClass(/bad/);
  await expect(toast(page)).toHaveText('HTTP 500');
});
