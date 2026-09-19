import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// Spec 2026-09-19-shared-ride-by-day. Search sends a traveller whose date is not a Wed/Sat to
// the board to start their own ride: board.html?from=&to=&date=&start=1 opens the start form
// already filled in. And the form refuses, inline, a route + day the scheduled van already runs.

const FROM = 'Negombo', TO = 'Sigiriya / Dambulla';
const THU = '2099-08-13', SAT = '2099-08-15';
const link = (date) => '/board.html?from=' + encodeURIComponent(FROM) + '&to=' + encodeURIComponent(TO) + '&date=' + date + '&start=1';

async function stubApi(page, lists = []) {
  await page.route((u) => isApiRequest(new URL(u.href)), (route) => {
    const path = new URL(route.request().url()).pathname;
    const j = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/board/me') return j({ me: null });
    if (path === '/board') return j({ lists });
    if (path === '/board/dupe') return j({ list: null });
    return j({});
  });
}

test('the start link opens the start form with route and date filled in, then forgets itself', async ({ page }) => {
  await stubApi(page);
  await page.goto(link(THU));
  await expect(page.locator('#mstep-0')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#m-title')).toHaveText('Start a list');
  await expect(page.locator('#c-from')).toHaveValue('negombo');
  await expect(page.locator('#c-to')).toHaveValue('sigiriya');
  await expect(page.locator('#c-date')).toHaveValue(THU);
  await expect(page.locator('#c-est')).toContainText('$27.49');
  // a reload must not re-open the form: `start` is consumed, the route filter stays
  await expect(page).not.toHaveURL(/start=/);
  await expect(page).toHaveURL(/from=Negombo/);
  // and the fields stay editable
  await expect(page.locator('#c-date')).toBeEditable();
});

test('on a day the scheduled van runs, the form says so and offers the guaranteed seat instead', async ({ page }) => {
  await stubApi(page);
  await page.goto(link(SAT));
  const stop = page.locator('#sched-stop');
  await expect(stop).toBeVisible({ timeout: 15000 });
  await expect(stop).toContainText('We already run this on Saturdays');
  await expect(stop).toContainText('$27.49');
  await expect(stop).toContainText('7:30am'); // the site's clock style, not "07:30"
  await expect(page.locator('#c-continue')).toBeHidden();
  // the board's own terms ("once 3 seats are up") must not sit under an offer of a GUARANTEED seat
  await expect(page.locator('#mstep-0 .est')).toBeHidden();
  await expect(stop.locator('a')).toHaveAttribute('href', 'search.html?from=negombo&to=sigiriya&date=' + SAT);

  // pick a day the van does not run → the stop lifts and the form works again
  await page.locator('#c-date').fill(THU);
  await page.locator('#c-date').dispatchEvent('change');
  await expect(stop).toBeHidden();
  await expect(page.locator('#c-continue')).toBeVisible();
  await expect(page.locator('#mstep-0 .est')).toBeVisible();
});

test('"Start another van" opens the form with that ride\'s route — it used to open blank', async ({ page }) => {
  const m = (n, i) => ({ position: i + 1, firstName: n, country: 'AU', photoUrl: null, isStarter: i === 0 });
  const full = { code: 'FV-9', corridorId: 'airport-cultural', from: 'Colombo Airport (CMB)', to: 'Kandy', date: THU,
    slot: 'morning', lockedTime: '07:30', minSeats: 4, capacity: 6, seatPrice: 2050, status: 'confirmed', note: null,
    cutoffAt: '2099-08-11T00:00:00.000Z', committed: 6, members: ['Tom', 'Ela', 'Kim', 'Nat', 'Jo', 'Sam'].map(m) };
  await stubApi(page, [full]);
  await page.goto('/board.html');
  await page.locator('.rw[data-code="FV-9"] [data-again]').click({ timeout: 15000 });
  await expect(page.locator('#mstep-0')).toBeVisible();
  // the dropdowns hold place IDS and the To list is built from From — the old prefill wrote
  // place NAMES into them before the To list existed, so both stayed on "Choose…"
  await expect(page.locator('#c-from')).toHaveValue('cmb-airport');
  await expect(page.locator('#c-to')).toHaveValue('kandy');
  await expect(page.locator('#c-date')).toHaveValue(THU);
});
