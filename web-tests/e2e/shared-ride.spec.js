import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// Shared rides run a fixed weekly schedule — seats depart only on set weekdays (Wed & Sat).
// The booking calendar must mirror the backend (POST /bookings/shared rejects off-schedule
// dates with 400 not_a_service_day): only the service weekdays are selectable, and the UI
// must stop advertising the service as "daily". The service days arrive via ?days= (search
// builds it from the corridor).
const SHARED_QUERY =
  'mode=shared&from=cmb-airport&to=kandy&price=19&times=07:30&corridor=airport-cultural&days=3,6&pax=1';

test('shared calendar only offers the service weekdays (Wed & Sat)', async ({ page }) => {
  await gotoBooking(page, { query: SHARED_QUERY });

  // Step to a fully-future month so nothing is greyed merely for being in the past — then
  // every non-selectable weekday is non-selectable purely by the shared-service rule.
  const cells = await page.evaluate(() => {
    window.calMove(1);
    return [...document.querySelectorAll('#cal .cal-day')].map((c) => ({
      dow: c.dataset.dow,
      selectable: !!c.getAttribute('onclick'),
      noSvc: c.classList.contains('no-svc'),
    }));
  });

  const selectable = cells.filter((c) => c.selectable);
  expect(selectable.length).toBeGreaterThan(0);
  // Every selectable day is a Wednesday (3) or Saturday (6)…
  for (const c of selectable) expect(['3', '6']).toContain(c.dow);
  // …and both service days are actually offered.
  expect(selectable.some((c) => c.dow === '3')).toBe(true);
  expect(selectable.some((c) => c.dow === '6')).toBe(true);

  // A non-service weekday (Monday) is marked no-svc and is not selectable.
  const mondays = cells.filter((c) => c.dow === '1');
  expect(mondays.length).toBeGreaterThan(0);
  for (const c of mondays) {
    expect(c.noSvc).toBe(true);
    expect(c.selectable).toBe(false);
  }
});

test('a non-service weekday cannot be picked on a shared ride', async ({ page }) => {
  await gotoBooking(page, { query: SHARED_QUERY });

  const res = await page.evaluate(() => {
    window.calMove(1);
    const bad = [...document.querySelectorAll('#cal .cal-day')].find(
      (c) => c.dataset.dow === '1' && c.textContent.trim(),
    );
    bad.click(); // a non-service day: should carry no click handler and never select
    return { hadOnclick: !!bad.getAttribute('onclick'), selected: !!document.querySelector('.cal-day.sel') };
  });

  expect(res.hadOnclick).toBe(false);
  expect(res.selected).toBe(false);
});

test('the shared booking UI advertises the schedule as Wed & Sat, not daily', async ({ page }) => {
  await gotoBooking(page, { query: SHARED_QUERY });

  const card = await page.locator('.shared-route').innerText();
  expect(card.toLowerCase()).toContain('wed & sat');
  expect(card.toLowerCase()).not.toContain('daily');

  const s2sub = await page.locator('#s2-sub').innerText();
  expect(s2sub.toLowerCase()).not.toContain('daily');
});
