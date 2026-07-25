import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// Shared rides run a fixed schedule: seats depart on set weekdays (Wed & Sat) at a
// single scheduled time per corridor. The booking UI must make that limited
// availability obvious — the calendar only allows the service weekdays, and the
// departure is a read-only fact, NOT a time picker the traveller can choose from.
const SHARED_QUERY =
  'mode=shared&from=cmb-airport&to=kandy&price=19&times=07:30&corridor=airport-cultural&days=3,6&pax=1';

test('shared-ride calendar only offers the service weekdays (Wed & Sat)', async ({ page }) => {
  await gotoBooking(page, { query: SHARED_QUERY });

  // Move to a fully-future month so no cell is disabled merely for being in the past —
  // then every disabled day is disabled purely by the shared-service rule.
  const cells = await page.evaluate(() => {
    window.calMove(1);
    return [...document.querySelectorAll('#cal .cal-day')].map(c => ({
      dow: c.dataset.dow,
      off: c.classList.contains('off'),
    }));
  });

  const clickable = cells.filter(c => !c.off);
  expect(clickable.length).toBeGreaterThan(0);
  // Every selectable day is a Wednesday (3) or Saturday (6).
  for (const c of clickable) expect(['3', '6']).toContain(c.dow);
  // Both service days are actually offered.
  expect(clickable.some(c => c.dow === '3')).toBe(true);
  expect(clickable.some(c => c.dow === '6')).toBe(true);
});

test('a non-service weekday cannot be picked on a shared ride', async ({ page }) => {
  await gotoBooking(page, { query: SHARED_QUERY });

  const picked = await page.evaluate(() => {
    window.calMove(1);
    const bad = [...document.querySelectorAll('#cal .cal-day')]
      .find(c => c.dataset.dow !== '3' && c.dataset.dow !== '6' && c.textContent.trim());
    if (!bad) return { attempted: false };
    const before = document.querySelector('.cal-day.sel');
    bad.click(); // non-service day: should be inert (no onclick wired)
    return { attempted: true, hadOnclick: !!bad.getAttribute('onclick'), selectedAfter: !!document.querySelector('.cal-day.sel') && !before };
  });

  expect(picked.attempted).toBe(true);
  expect(picked.hadOnclick).toBe(false);      // non-service days carry no click handler
  expect(picked.selectedAfter).toBe(false);   // clicking one does not select it
});

test('shared-ride departure is a read-only fixed time, not a picker', async ({ page }) => {
  await gotoBooking(page, { query: SHARED_QUERY });

  const dep = await page.evaluate(() => {
    const sel = document.getElementById('dep-select');
    const card = document.getElementById('single-dep-card');
    return {
      selectDisplay: sel ? getComputedStyle(sel).display : 'missing',
      cardTag: card ? card.tagName : 'missing',
      cardText: card ? card.textContent : '',
    };
  });

  expect(dep.selectDisplay).toBe('none');   // the <select> picker is hidden
  expect(dep.cardTag).toBe('DIV');          // departure is a static element, not a control
  expect(dep.cardText).toContain('7:30');   // shows the corridor's scheduled time
});

test('shared-ride schedule reads "Wed & Sat", not "daily"', async ({ page }) => {
  await gotoBooking(page, { query: SHARED_QUERY });

  const srFoot = await page.evaluate(
    () => document.querySelector('.shared-route .sr-foot')?.innerText || '',
  );
  expect(srFoot).toContain('Wed & Sat');
  expect(srFoot.toLowerCase()).not.toContain('daily');
});
