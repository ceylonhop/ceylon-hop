import { test, expect } from '@playwright/test';
import { futureIsoDate } from '../dates.js';

// Phase 4: a customer who booked with "Decide later" fills the blank pickup ONCE on the manage
// page. Offline: /bookings/view and /bookings/view/schedule are stubbed.

const PAGE = '/manage.html?t=test-token';
const BASE = {
  reference: 'CH-K7Q2M', status: 'paid', mode: 'single', firstName: 'Sam',
  from: 'Kandy', to: 'Ella', date: 'to confirm', endDate: 'to confirm', time: 'to confirm',
  travellers: 2, vehicleType: 'car', totalCents: 12400, balanceDueCents: 0, amountDueNowCents: 0, currency: 'USD',
};
const DAY = futureIsoDate(30);

async function stub(page, view, schedule) {
  // By pathname: the older specs' '**/bookings/view*' glob would also swallow /view/schedule.
  await page.route((u) => u.pathname.endsWith('/bookings/view'), (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(view) }));
  await page.route((u) => u.pathname.endsWith('/bookings/view/schedule'), schedule);
  await page.route('https://www.googletagmanager.com/**', (r) => r.fulfill({ status: 200, body: '' }));
}
// The datepicker keeps a real <input type=date>: set it the way a day click does.
async function pickDate(page, iso) {
  await page.locator('#pkdate').evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, iso);
}

test('a booking with nothing set asks for it, and saves exactly what the button names', async ({ page }) => {
  let sent = null;
  await stub(page, BASE, async (r) => {
    sent = { body: JSON.parse(r.request().postData()), auth: r.request().headers().authorization };
    const view = { ...BASE, date: DAY, endDate: DAY, time: '09:00', scheduleSetBy: 'customer' };
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ view, emailed: true }) });
  });
  await page.goto(PAGE);
  await expect(page.locator('.pp-sub')).toHaveText('Pick-up date not set yet');
  await expect(page.locator('#pickup')).toContainText('Add your pick-up date & time');
  await page.locator('#pkopen').click();
  await expect(page.locator('#pksave')).toHaveText('Choose a date');
  await expect(page.locator('#pksave')).toBeDisabled();
  await pickDate(page, DAY);
  await expect(page.locator('#pksave')).toHaveText('Choose a pick-up time');
  await expect(page.locator('#pktime option').nth(1)).toHaveText('12:00 am · Night pickup');
  await page.locator('#pktime').selectOption('09:00');
  await expect(page.locator('#pksave')).toHaveText(/^Save \w{3} \d{1,2} \w{3} · 9:00 am$/);
  await page.locator('#pksave').click();
  expect(sent).toEqual({ body: { date: DAY, time: '09:00' }, auth: 'Bearer test-token' });
  await expect(page.locator('#pickup')).toContainText('Pick-up set');
  await expect(page.locator('.fact', { hasText: 'Pick-up time' })).toContainText('9:00 am');
  await expect(page.locator('body')).not.toContainText('set by you');
});

test('an airport arrival is asked for a landing time in 15-minute steps', async ({ page }) => {
  await stub(page, { ...BASE, from: 'Colombo Airport (CMB)' }, (r) => r.abort());
  await page.goto(PAGE);
  await page.locator('#pkopen').click();
  await expect(page.locator('#pickup')).toContainText('When does your flight land?');
  await pickDate(page, DAY);
  await page.locator('#pktime').selectOption('08:45');
  await expect(page.locator('#pksave')).toHaveText(/^Save landing .* · 8:45 am$/);
});

test('"Don\'t know yet" saves the date alone', async ({ page }) => {
  let body = null;
  await stub(page, BASE, async (r) => {
    body = JSON.parse(r.request().postData());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ view: { ...BASE, date: DAY, endDate: DAY }, emailed: true }) });
  });
  await page.goto(PAGE);
  await page.locator('#pkopen').click();
  await pickDate(page, DAY);
  await page.locator('#pkdk').check();
  await expect(page.locator('#pksave')).toHaveText(/· time later$/);
  await page.locator('#pksave').click();
  expect(body).toEqual({ date: DAY, time: null });
});

test('the reminder link (#pickup) lands with the form already open', async ({ page }) => {
  await stub(page, BASE, (r) => r.abort());
  await page.goto(PAGE + '#pickup');
  await expect(page.locator('#pkdate')).toBeAttached();
  await expect(page.locator('#pickup')).toBeInViewport();
});

test('a date ops already set is shown fixed; only the time is asked for', async ({ page }) => {
  await stub(page, { ...BASE, date: DAY, endDate: DAY, scheduleSetBy: 'staff' }, (r) => r.abort());
  await page.goto(PAGE);
  await expect(page.locator('#pickup')).toContainText('Add your pick-up time');
  await expect(page.locator('#pickup')).toContainText('set by our team');
  await expect(page.locator('#pkdate')).toHaveCount(0);
  await expect(page.locator('#pkdk')).toHaveCount(0);
});

test('the team got there first: says so and shows their value', async ({ page }) => {
  await stub(page, BASE, (r) => r.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: 'already_set', current: { date: DAY, time: '10:00' } }) }));
  await page.goto(PAGE);
  await page.locator('#pkopen').click();
  await pickDate(page, DAY);
  await page.locator('#pktime').selectOption('09:00');
  await page.locator('#pksave').click();
  await expect(page.locator('#pickup')).toContainText('Our team has already set your pick-up');
  await expect(page.locator('#pickup')).toContainText('10:00 am');
});

test('too soon (server says so): explains and offers WhatsApp', async ({ page }) => {
  await stub(page, BASE, (r) => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'too_soon' }) }));
  await page.goto(PAGE);
  await page.locator('#pkopen').click();
  await pickDate(page, DAY);
  await page.locator('#pktime').selectOption('09:00');
  await page.locator('#pksave').click();
  await expect(page.locator('#pkerr')).toBeVisible();
  await expect(page.locator('#pkerr')).toContainText('12 hours');
});

test('a failed save says nothing changed and keeps the choice', async ({ page }) => {
  await stub(page, BASE, (r) => r.fulfill({ status: 500, body: '' }));
  await page.goto(PAGE);
  await page.locator('#pkopen').click();
  await pickDate(page, DAY);
  await page.locator('#pktime').selectOption('09:00');
  await page.locator('#pksave').click();
  await expect(page.locator('#pkfail')).toContainText('nothing has changed');
  await expect(page.locator('#pktime')).toHaveValue('09:00');
  await expect(page.locator('#pksave')).toBeEnabled();
});

test('no card on a booking the customer cannot edit, or once both are set', async ({ page }) => {
  for (const view of [{ ...BASE, status: 'cancelled' }, { ...BASE, status: 'payment_pending' }, { ...BASE, date: DAY, endDate: DAY, time: '09:00' }]) {
    await stub(page, view, (r) => r.abort());
    await page.goto(PAGE);
    await expect(page.locator('.ticket')).toBeVisible();
    await expect(page.locator('#pickup')).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});
