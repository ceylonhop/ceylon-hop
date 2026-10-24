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
  // `view` may be an array: successive /bookings/view responses, the last one repeating (boot, then a re-read).
  let n = 0;
  await page.route((u) => u.pathname.endsWith('/bookings/view'), (r) => {
    const v = Array.isArray(view) ? view[Math.min(n++, view.length - 1)] : view;
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(v) });
  });
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

// booking.js lets a single keep its time after "Decide later" on the date (toggleFlexDate leaves
// state.dep alone), so a paid booking can hold a time and no date. The server refuses a changed
// time (already_set): show it fixed and ask only for the date.
test('a time already set is shown fixed; only the date is asked for, and the time goes back unchanged', async ({ page }) => {
  let body = null;
  await stub(page, { ...BASE, time: '09:00' }, async (r) => {
    body = JSON.parse(r.request().postData());
    const view = { ...BASE, date: DAY, endDate: DAY, time: '09:00', scheduleSetBy: 'customer' };
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ view, emailed: true }) });
  });
  await page.goto(PAGE);
  await expect(page.locator('#pickup')).toContainText('Add your pick-up date');
  await expect(page.locator('#pickup')).not.toContainText('date & time');
  await page.locator('#pkopen').click();
  await expect(page.locator('#pktime')).toHaveCount(0);
  await expect(page.locator('#pkdk')).toHaveCount(0);
  await expect(page.locator('#pickup .pk-fixed')).toHaveText('9:00 am');
  await expect(page.locator('#pksave')).toHaveText('Choose a date');
  await pickDate(page, DAY);
  await expect(page.locator('#pksave')).toHaveText(/^Save \w{3} \d{1,2} \w{3} · 9:00 am$/);
  await page.locator('#pksave').click();
  expect(body).toEqual({ date: DAY, time: '09:00' });
  await expect(page.locator('#pickup')).toContainText('Pick-up set');
});

test('the team got there first: says so and shows their value', async ({ page }) => {
  await stub(page, [BASE, { ...BASE, date: DAY, endDate: DAY, time: '10:00', scheduleSetBy: 'staff' }], (r) => r.fulfill({ status: 409, contentType: 'application/json',
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
  // A disabled button says what is missing, even when the page's own clock thought the time was fine.
  await expect(page.locator('#pksave')).toHaveText('Too soon to set here');
  await expect(page.locator('#pksave')).toBeDisabled();
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

const SAVED = { ...BASE, date: DAY, endDate: DAY, time: '09:00', scheduleSetBy: 'customer' };
async function fillAndSave(page) {
  await page.locator('#pkopen').click();
  await pickDate(page, DAY);
  await page.locator('#pktime').selectOption('09:00');
  await page.locator('#pksave').click();
}

test('the reply was lost but the save went through: the re-read says so', async ({ page }) => {
  await stub(page, [BASE, SAVED], (r) => r.abort());
  await page.goto(PAGE);
  await fillAndSave(page);
  await expect(page.locator('#pickup')).toContainText('Pick-up set');
  await expect(page.locator('#pickup')).toContainText('9:00 am');
  await expect(page.locator('#pkfail')).toHaveCount(0);
});

test('the reply was lost and nothing was saved: says nothing changed and keeps the choice', async ({ page }) => {
  await stub(page, BASE, (r) => r.abort());
  await page.goto(PAGE);
  await fillAndSave(page);
  await expect(page.locator('#pkfail')).toBeVisible();
  await expect(page.locator('#pkfail')).toContainText('nothing has changed');
  await expect(page.locator('#pktime')).toHaveValue('09:00');
  await expect(page.locator('#pksave')).toBeEnabled();
});

test('already_set but the customer set it (another tab): shows Pick-up set, not the team message', async ({ page }) => {
  await stub(page, [BASE, SAVED], (r) => r.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: 'already_set', current: { date: DAY, time: '09:00' } }) }));
  await page.goto(PAGE);
  await fillAndSave(page);
  await expect(page.locator('#pickup')).toContainText('Pick-up set');
  await expect(page.locator('body')).not.toContainText('Our team has already set');
});

test('nothing_to_set (a retry after a lost reply that did save) lands on Pick-up set', async ({ page }) => {
  await stub(page, [BASE, SAVED], (r) => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'nothing_to_set' }) }));
  await page.goto(PAGE);
  await fillAndSave(page);
  await expect(page.locator('#pickup')).toContainText('Pick-up set');
  await expect(page.locator('#pkfail')).toHaveCount(0);
});

test('Save stays locked while a save is in flight, even if an input changes', async ({ page }) => {
  let posts = 0;
  await stub(page, BASE, async (r) => {
    posts++;
    await new Promise((res) => setTimeout(res, 500));
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ view: SAVED, emailed: true }) });
  });
  await page.goto(PAGE);
  await page.locator('#pkopen').click();
  await pickDate(page, DAY);
  await page.locator('#pktime').selectOption('09:00');
  await page.locator('#pksave').click();
  await page.locator('#pktime').evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })));
  await expect(page.locator('#pksave')).toBeDisabled();
  await expect(page.locator('#pickup')).toContainText('Pick-up set');
  expect(posts).toBe(1);
});
