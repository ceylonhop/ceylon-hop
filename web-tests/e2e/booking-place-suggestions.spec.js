import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// Friend-reported 2026-08-27 (screenshot): typing "jaffn" into the exact drop-off field offered
// Jaffna, Jaffna Town West and Jaffna International Airport — and typing the final "a" collapsed
// the menu to a single row. Finishing the word took the airport away.
//
// booking.js's shouldAskGoogle skips the Google lookup when the typed text exactly matches ANY
// local row. site.js and plan.js — the other two copies of this picker — require that match to be
// a `source:'known'` CATALOGUE place (one with an id, and therefore baked pricing). "Jaffna" is
// not one: TRANSFERS.placeSuggestions returns it as {source:'extra', id:null}, a "Popular place".
// booking.js's looser test is the divergence, and it fires exactly on the places that most need
// Google — an id-less place carries no coordinates, so skipping the lookup also leaves the
// booking holding the raw typed string with no geo.
//
// What must NOT change: a real catalogue place (Negombo, Ella, Sigiriya) still short-circuits.
// Those are the 16-of-19 the guard was written for, and they keep their Google call unspent.

const rows = (page) => page.locator('#ac-to .ac-item:not(.loading)');

async function typeDropoff(page, text) {
  // the exact-spot fields live on the "Where" step (2), same as pickPlace() in _stubs.js
  await page.evaluate(() => window.goStep && window.goStep(2));
  await page.fill('#loc-to', text);
  // the local rows paint synchronously; the Google merge lands a microtask later
  await page.waitForTimeout(150);
}

test('finishing the name of a popular place does not take its suggestions away', async ({ page }) => {
  await gotoBooking(page);

  // Partway through the word: the local "Jaffna" plus what Google offers.
  await typeDropoff(page, 'jaffn');
  const partial = await rows(page).count();
  expect(partial).toBeGreaterThan(1);
  await expect(rows(page).filter({ hasText: 'Result 1' })).toHaveCount(1);

  // The whole word. The menu must not shrink — the Google rows that were on screen one
  // keystroke ago are still reachable.
  await typeDropoff(page, 'jaffna');
  await expect(rows(page).filter({ hasText: 'Result 1' })).toHaveCount(1);
  expect(await rows(page).count()).toBeGreaterThanOrEqual(partial);
});

test('a catalogue place still short-circuits the Google lookup', async ({ page }) => {
  await gotoBooking(page);

  // Negombo IS a catalogue place ({source:'known', id:'negombo'}). We already know exactly what
  // the customer means, so the lookup stays unspent and the menu is the single catalogue row.
  await typeDropoff(page, 'Negombo');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Negombo');
  await expect(rows(page).filter({ hasText: 'Result 1' })).toHaveCount(0);
});
