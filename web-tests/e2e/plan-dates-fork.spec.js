import { test, expect } from '@playwright/test';

/* The WHEN step used to open straight onto a list of empty date fields. A blank leg date has
   always MEANT "flexible" — booking renders it as "Date flexible" and the quote goes out with no
   date — but nothing on screen said so, so the fields read as unfilled mandatory ones. Clarity
   sessions (owner, 2026-09-13) showed customers opening a leg's calendar, finding no way out of
   it, and stalling on a step they could have walked straight past.
   The step now asks the answerable question FIRST: do you know your dates, or not? plan.js's
   datesMode + renderDatesStep. */

import { futureIsoDate } from '../dates.js';
import { blockLiveApi } from './_stubs.js';

test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

const STOPS = 'Colombo Airport (CMB)|Sigiriya|Kandy';
const D_A = futureIsoDate(28);

// The custom datepicker turns each leg's input into a hidden field, so drive it the way the app
// does rather than by clicking the calendar.
async function setLegDate(page, legIndex, iso) {
  await page.$eval(
    `.date-row[data-i="${legIndex}"] input`,
    (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); },
    iso,
  );
  await page.waitForTimeout(150);
}

async function forwardToDates(page) {
  await page.goto(`/plan.html?stops=${encodeURIComponent(STOPS)}&pax=2&vehicle=car`);
  await page.locator('#request-btn').click();
  await expect(page.locator('#dates-wrap')).toBeVisible();
}

test('the step opens on the question, not on a list of empty date fields', async ({ page }) => {
  await forwardToDates(page);

  await expect(page.locator('#dates-fork')).toBeVisible();
  await expect(page.locator('#fork-known')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#fork-later')).toHaveAttribute('aria-pressed', 'false');

  // No date field is put in front of anyone who hasn't said they have dates.
  await expect(page.locator('#dates-list')).toBeHidden();
});

test('"I know my dates" reveals the list; "later" replaces it with the confirmation', async ({ page }) => {
  await forwardToDates(page);

  await page.locator('#fork-known').click();
  await expect(page.locator('#dates-list')).toBeVisible();
  await expect(page.locator('#dates-list .date-row')).toHaveCount(2);
  await expect(page.locator('#dates-flex-note')).toBeHidden();
  await expect(page.locator('#fork-known')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#fork-later').click();
  await expect(page.locator('#dates-list')).toBeHidden();
  await expect(page.locator('#dates-flex-note')).toBeVisible();
  await expect(page.locator('#dates-flex-note')).toContainText(/WhatsApp/i);
  await expect(page.locator('#fork-later')).toHaveAttribute('aria-pressed', 'true');
});

test('the fork is never a gate — Continue still reaches booking with no dates at all', async ({ page }) => {
  await forwardToDates(page);

  // Untouched fork: exactly today's behaviour, straight through with no dates.
  const cont = page.locator('#dates-continue');
  await expect(cont).not.toHaveClass(/cta-disabled/);
  await cont.click();
  await page.waitForURL('**/booking.html?**');

  const q = new URL(page.url()).searchParams;
  expect((q.get('dates') || '').replace(/,/g, '')).toBe(''); // every leg flexible
});

test('"I\'ll decide my dates later" carries through to booking as a flexible trip', async ({ page }) => {
  await forwardToDates(page);
  await page.locator('#fork-later').click();
  await page.locator('#dates-continue').click();
  await page.waitForURL('**/booking.html?**');

  await expect(page.locator('.tr-chip.muted', { hasText: 'Date flexible' }).first()).toBeVisible();
});

test('arriving back on ?step=dates skips the fork — that customer has already answered it', async ({ page }) => {
  // booking.html's "Back to planner" / "Add your dates →" both land here.
  await page.goto(`/plan.html?step=dates&stops=${encodeURIComponent(STOPS)}&pax=2&vehicle=car`);

  await expect(page.locator('#dates-list')).toBeVisible();
  await expect(page.locator('#dates-list .date-row')).toHaveCount(2);
  await expect(page.locator('#fork-known')).toHaveAttribute('aria-pressed', 'true');
});

test('a dated leg can be made flexible again', async ({ page }) => {
  await forwardToDates(page);
  await page.locator('#fork-known').click();

  // Blank is the flexible state and carries no furniture of its own (owner decision 2026-09-19:
  // the "Flexible for now" chip was removed) — an undated leg is just an undated leg.
  const row = page.locator('.date-row[data-i="0"]');
  await expect(row.locator('input')).toHaveValue('');
  await expect(row.locator('.dr-clear')).toHaveCount(0);   // nothing to clear yet

  await setLegDate(page, 0, D_A);
  await expect(row.locator('input')).toHaveValue(D_A);

  // Until now a picked date could not be unpicked: the datepicker hides the native input and
  // its popover has no clear action, so a mis-tap was permanent.
  await row.locator('.dr-clear').click();
  await expect(row.locator('input')).toHaveValue('');
  await expect(row.locator('.dr-clear')).toHaveCount(0);   // and it is back to flexible
});

test('switching to "later" clears dates, and switching back restores them', async ({ page }) => {
  await forwardToDates(page);
  await page.locator('#fork-known').click();
  await setLegDate(page, 0, D_A);

  await page.locator('#fork-later').click();
  await expect(page.locator('#dates-flex-note')).toBeVisible();
  // Nothing is left dated behind the customer's back — booking must not receive a date from
  // someone who has just been told nothing is locked in.
  await expect(page.locator('.date-row[data-i="0"] input')).toHaveValue('');

  // ...but the work isn't thrown away either.
  await page.locator('#fork-known').click();
  await expect(page.locator('.date-row[data-i="0"] input')).toHaveValue(D_A);
});
