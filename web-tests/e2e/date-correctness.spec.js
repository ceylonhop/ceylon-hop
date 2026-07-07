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
