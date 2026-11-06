import { test, expect } from '@playwright/test';

/* "I know my dates" with some legs left blank used to continue on a button that promised
   nothing about it: a blank leg is fine (it goes to booking as "Date flexible" and we confirm on
   WhatsApp), but the customer had no way to tell whether they'd missed one or whether it was
   allowed. Owner call (2026-11-01): change the button's copy, not a popup — the CTA says what
   it is about to do, and a note counts the blanks. plan.js: renderDatesStep. */

import { futureIsoDate } from '../dates.js';
import { blockLiveApi } from './_stubs.js';

test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

const STOPS = 'Colombo Airport (CMB)|Sigiriya|Kandy';   // two legs
const D_A = futureIsoDate(28);
const D_B = futureIsoDate(30);

async function setLegDate(page, legIndex, iso) {
  await page.$eval(
    `.date-row[data-i="${legIndex}"] input`,
    (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); },
    iso,
  );
  await page.waitForTimeout(150);
}

async function openKnown(page) {
  await page.goto(`/plan.html?stops=${encodeURIComponent(STOPS)}&pax=2&vehicle=car`);
  await page.locator('#request-btn').click();
  await expect(page.locator('#dates-wrap')).toBeVisible();
  await page.locator('#fork-known').click();
  await expect(page.locator('#dates-list .date-row')).toHaveCount(2);
}

test('the CTA says it is continuing without every date while any leg is blank', async ({ page }) => {
  await openKnown(page);
  const cta = page.locator('#dates-continue');
  const hint = page.locator('#dates-missing-hint');

  // nothing dated yet: the customer said they know their dates, so blanks are worth naming
  await expect(cta).toHaveText(/continue without all dates/i);
  await expect(hint).toBeVisible();
  await expect(hint).toContainText(/2 dates/i);
  await expect(hint).toContainText(/WhatsApp/i);

  await setLegDate(page, 0, D_A);
  await expect(cta).toHaveText(/continue without all dates/i);
  await expect(hint).toContainText(/1 date /i);

  // every leg dated: back to the plain CTA, note gone
  await setLegDate(page, 1, D_B);
  await expect(cta).toHaveText(/continue to select service/i);
  await expect(hint).toBeHidden();

  // clear one again: the copy follows the dates, not the order they were entered
  await page.locator('.date-row[data-i="1"] .dr-clear').click();
  await expect(cta).toHaveText(/continue without all dates/i);
  await expect(hint).toBeVisible();
});

test('"I\'ll decide my dates later" keeps the plain CTA — that choice already says so', async ({ page }) => {
  await openKnown(page);
  await page.locator('#fork-later').click();
  await expect(page.locator('#dates-flex-note')).toBeVisible();
  await expect(page.locator('#dates-continue')).toHaveText(/continue to select service/i);
  await expect(page.locator('#dates-missing-hint')).toBeHidden();
});

test('the CTA still continues with blanks — it is a label, not a gate', async ({ page }) => {
  await openKnown(page);
  await setLegDate(page, 0, D_A);
  await page.locator('#dates-continue').click();
  await expect(page).toHaveURL(/booking\.html/);
});
