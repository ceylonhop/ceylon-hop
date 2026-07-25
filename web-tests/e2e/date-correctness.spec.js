import { test, expect } from '@playwright/test';
import { fillContact } from './_stubs.js';

test.use({ timezoneId: 'Asia/Colombo' });

async function bootBooking(page) {
  let capturedSingle = null;

  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.route('**/www.payhere.lk/**', (r) => r.abort());
  await page.route('**/*sandbox.payhere.lk/**', (r) => r.abort());
  await page.route('https://api.test/health', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{"status":"ok"}',
  }));
  await page.route('https://api.test/bookings/single', async (r) => {
    capturedSingle = JSON.parse(r.request().postData() || '{}');
    return r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'date-e2e',
        reference: 'CH-DATE1',
        status: 'draft',
        mode: 'single',
        total: 12100,
        amountDueNow: 12100,
        currency: 'USD',
      }),
    });
  });
  await page.route('https://api.test/bookings/date-e2e/checkout', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ checkoutUrl: 'https://example.test/fake-gateway', fields: {} }),
  }));

  await page.goto('/booking.html?api=https://api.test&mode=private&from=cmb-airport&to=hikkaduwa&price=121&vehicle=car');
  return { capturedSingle: () => capturedSingle };
}

test('selected booking date is displayed and submitted as the same local date', async ({ page }) => {
  const api = await bootBooking(page);

  await page.evaluate(() => window.pickDate(2026, 7, 18));
  await expect(page.locator('#sum-date')).toContainText('18 Aug 2026');

  await fillContact(page);
  await page.click('#pay-btn');
  await expect.poll(api.capturedSingle).toMatchObject({ date: '2026-08-18' });
});

test('reusable datepicker defaults to tomorrow as the earliest selectable date', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  // Use canonical place IDs, not display names: search.js resolves ?from/?to against
  // T.place(id) and now redirects an unresolvable `to` to 404.html (feat commit 10a84f8),
  // which would remove #e-date before we can read it. 'cmb-airport'/'kandy' are real IDs.
  await page.goto('/search.html?from=cmb-airport&to=kandy');

  const dates = await page.evaluate(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return {
      min: document.getElementById('e-date').min,
      tomorrow: iso(tomorrow),
    };
  });

  expect(dates.min).toBe(dates.tomorrow);
});

test('booking calendar rejects today and accepts tomorrow', async ({ page }) => {
  await bootBooking(page);

  const result = await page.evaluate(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const label = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

    window.pickDate(today.getFullYear(), today.getMonth(), today.getDate());
    const afterToday = document.getElementById('sum-date').textContent;

    window.pickDate(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate());
    const afterTomorrow = document.getElementById('sum-date').textContent;

    return {
      min: document.getElementById('cal').dataset.minDate,
      tomorrow: iso(tomorrow),
      todayLabel: label(today),
      tomorrowLabel: label(tomorrow),
      afterToday,
      afterTomorrow,
    };
  });

  expect(result.min).toBe(result.tomorrow);
  expect(result.afterToday).not.toContain(result.todayLabel);
  expect(result.afterTomorrow).toContain(result.tomorrowLabel);
});

test('booking calendar disables dates more than 12 months out', async ({ page }) => {
  await bootBooking(page);

  const maxIso = await page.locator('#cal').getAttribute('data-max-date');
  expect(maxIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  const futureEnabled = await page.evaluate(() => {
    const max = document.getElementById('cal').dataset.maxDate;
    const [y, m, d] = max.split('-').map(Number);
    window.pickDate(y, m - 1, d + 1);
    return document.getElementById('sum-date').textContent;
  });
  expect(futureEnabled).not.toContain(String(Number(maxIso.slice(-2)) + 1));
});

test('planner date handoff keeps the selected local date in the booking URL', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?step=dates&stops=Colombo%20Airport%20(CMB)%7CKandy');

  await page.$eval(
    '.date-row[data-i="0"] input',
    (el) => { el.value = '2026-08-08'; el.dispatchEvent(new Event('change', { bubbles: true })); },
  );
  await page.click('#dates-continue', { force: true });

  await expect(page).toHaveURL(/booking\.html/);
  expect(new URL(page.url()).searchParams.get('dates')).toBe('2026-08-08');
  expect(new URL(page.url()).searchParams.get('start')).toBe('2026-08-08');
});

test('a stale/past URL date does not skip the calendar and cannot be pre-selected', async ({ page }) => {
  // A shared/stale/hand-edited link can carry ?date= a past or same-day value. The booking
  // page must NOT trust it: the date step (panel 1) stays active and no date is pre-filled,
  // so the next-day rule cannot be bypassed by pre-seeding state.date. (booking.js window guard)
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/booking.html?mode=private&from=cmb-airport&to=hikkaduwa&price=121&vehicle=car&date=2020-01-01');

  await expect(page.locator('.panel[data-panel="1"]')).toHaveClass(/active/);
  await expect(page.locator('.panel[data-panel="2"]')).not.toHaveClass(/active/);
  await expect(page.locator('#sum-date')).not.toContainText('2020');
});

test('a valid in-window URL date still skips the calendar', async ({ page }) => {
  // The guard only drops out-of-window dates; a legitimately pre-chosen date (search page)
  // must keep skipping the date step straight to Pick-up & drop-off (panel 2).
  const d = new Date(); d.setDate(d.getDate() + 30);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto(`/booking.html?mode=private&from=cmb-airport&to=hikkaduwa&price=121&vehicle=car&date=${iso}`);

  await expect(page.locator('.panel[data-panel="2"]')).toHaveClass(/active/);
  await expect(page.locator('.panel[data-panel="1"]')).not.toHaveClass(/active/);
});
