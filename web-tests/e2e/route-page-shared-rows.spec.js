import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';
import { futureIsoDate } from '../dates.js';

/*
  Task B4: the "already going" rows on a shared /trip/ page (route-page.js's rowsHtml()).

  "5 of 3" reads like a bug because it is one: `got`/`minSeats` is an internal ratio, not a
  fact a traveller needs. What they need to know is (a) how many people are on this date and
  (b) whether that's enough to run. So the count and the running-state are now two separate,
  honestly worded things: "{n} going" (a fact) and a pill that says "Running" or "{need} more
  to run" (a verdict) — never glued together as "n of min".

  No board-stubbing e2e existed for route-page.js before this: route-pages.spec.js and
  route-page-layout.spec.js exercise /trip/ pages but never stub `/board`, and the unit tests
  (route-page-unified.test.js, trip-redesign.test.js) only ever look at the script-stripped,
  no-JS markup by design (route-page.js is explicitly a layer that must never be load-bearing).
  This file is the first to drive the live board fetch, reusing ride-board-rows.spec.js's
  stubbing pattern (isApiRequest) and the repo's futureIsoDate helper so list dates never rot
  into the past (see web-tests/dates.js).
*/

const member = (n) => ({ firstName: n, country: 'LK', photoUrl: null });

const RUNNING = {
  code: 'RB-RUN', corridorId: 'airport-cultural', date: futureIsoDate(20), slot: 'morning',
  status: 'gathering', minSeats: 3, committed: 5,
  members: ['Ann', 'Ben', 'Cal', 'Dee', 'Eve'].map(member),
};
const NEEDS_ONE = {
  code: 'RB-NEED', corridorId: 'airport-cultural', date: futureIsoDate(25), slot: 'afternoon',
  status: 'gathering', minSeats: 3, committed: 2,
  members: ['Fay', 'Gus'].map(member),
};
const BOUNDARY = {
  code: 'RB-EDGE', corridorId: 'airport-cultural', date: futureIsoDate(30), slot: 'morning',
  status: 'gathering', minSeats: 3, committed: 3,
  members: ['Hal', 'Ira', 'Jon'].map(member),
};
// Fix 1: the longest real row — an afternoon slot AND the "your date" tag, together — is the
// combination that exposed the bug (the tag's TEXT was invisible; only its chip border
// survived, and the slot word ellipsised on nearly every row at 375px).
const MARKED = {
  code: 'RB-MINE', corridorId: 'airport-cultural', date: futureIsoDate(15), slot: 'afternoon',
  status: 'gathering', minSeats: 3, committed: 2,
  members: ['Kim', 'Lee'].map(member),
};

/** Sets the traveller's chosen date the way the date-field's `input[type=date]` does: writes
 *  the value and fires `change` (route-page.js listens for that, not `input`). This is what
 *  makes a matching list's row exact/`.is-yours` and appends the "your date" tag. */
async function pickDate(page, iso) {
  await page.evaluate((value) => {
    const input = document.querySelector('.ld-date');
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, iso);
}

async function stubBoard(page, lists) {
  await page.route((u) => isApiRequest(u), (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/board') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lists }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

/** Does the element's own text content occupy a single line box? Built as a Range over its
 *  contents rather than the element's own rect: inline children (the faces, the "your date"
 *  tag) each contribute their own client rect even on one visual line, so counting rects would
 *  over-count. Grouping distinct `top` values is what actually answers "does this wrap" — but
 *  an exact-match grouping is too strict once a padded inline chip is in the mix: the "your
 *  date" tag's own padding/line-height sits its rect ~5px off from the plain text beside it on
 *  the very same visual line (measured: text tops at 1689, the tag's at 1694-1695). A real wrap
 *  moves a whole line-height (~20px+) instead, so cluster tops within 10px as "the same line"
 *  rather than requiring them to round to the same integer. */
function oneLine(locator) {
  return locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()];
    const tops = rects.map((r) => r.top).sort((a, b) => a - b);
    let lines = tops.length ? 1 : 0;
    for (let i = 1; i < tops.length; i++) {
      if (tops[i] - tops[i - 1] > 10) lines++;
    }
    return { lines, rectCount: rects.length };
  });
}

test('a running date: the pill says Running, the count says "N going", no "n of min" anywhere', async ({ page }) => {
  await stubBoard(page, [RUNNING]);
  await page.goto('/trip/cmb-airport-to-sigiriya/');

  const row = page.locator('.ld-row[href*="RB-RUN"]');
  await expect(row).toBeVisible();
  await expect(row.locator('.ld-pill')).toHaveText('Running');
  await expect(row.locator('.ld-pill')).toHaveClass(/\bgo\b/);
  await expect(row.locator('.ld-count')).toHaveText('5 going');
  expect(await row.innerText()).not.toContain(' of ');
});

test('a date short of the minimum: the pill says how many more, not a fraction', async ({ page }) => {
  await stubBoard(page, [NEEDS_ONE]);
  await page.goto('/trip/cmb-airport-to-sigiriya/');

  const row = page.locator('.ld-row[href*="RB-NEED"]');
  await expect(row).toBeVisible();
  await expect(row.locator('.ld-pill')).toHaveText('1 more to run');
  await expect(row.locator('.ld-pill')).toHaveClass(/\bneed\b/);
  await expect(row.locator('.ld-count')).toHaveText('2 going');
});

test('exactly at the minimum: Running, not "3 of 3"', async ({ page }) => {
  await stubBoard(page, [BOUNDARY]);
  await page.goto('/trip/cmb-airport-to-sigiriya/');

  const row = page.locator('.ld-row[href*="RB-EDGE"]');
  await expect(row).toBeVisible();
  await expect(row.locator('.ld-pill')).toHaveText('Running');
  await expect(row.locator('.ld-count')).toHaveText('3 going');
});

test('no progress meter survives the redesign', async ({ page }) => {
  await stubBoard(page, [RUNNING, NEEDS_ONE, BOUNDARY]);
  await page.goto('/trip/cmb-airport-to-sigiriya/');
  await expect(page.locator('.ld-row')).toHaveCount(3);
  await expect(page.locator('.ld-meter')).toHaveCount(0);
});

test('at 375px, every row keeps its date on one line, its pill on the row, and the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await stubBoard(page, [RUNNING, NEEDS_ONE, BOUNDARY]);
  await page.goto('/trip/cmb-airport-to-sigiriya/');

  const rows = page.locator('.ld-row');
  const n = await rows.count();
  expect(n).toBe(3);
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const when = row.locator('.ld-when');
    const { lines, rectCount } = await oneLine(when);
    expect(rectCount, `.ld-when #${i} rendered no boxes at all`).toBeGreaterThan(0);
    expect(lines, `.ld-when #${i} wrapped onto ${lines} lines`).toBe(1);

    // the pill must still be ON the row (not pushed onto a line of its own below it)
    const rowBox = await row.boundingBox();
    const pillBox = await row.locator('.ld-pill').boundingBox();
    expect(pillBox.y, 'the pill dropped below the row').toBeLessThan(rowBox.y + rowBox.height);

    // and the row itself must not spill past its own container
    const overflow = await row.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, `row #${i} overflows its own box by ${overflow}px`).toBeLessThanOrEqual(1);
  }

  const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(docOverflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
});

test('Fix 1 — at 375px, the longest real row shows the whole date and slot, and the "your date" tag is actually visible', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await stubBoard(page, [MARKED]);
  await page.goto('/trip/cmb-airport-to-sigiriya/');
  await expect(page.locator('.ld-row')).toHaveCount(1);
  await pickDate(page, MARKED.date);

  const row = page.locator('.ld-row.is-yours');
  await expect(row).toBeVisible();
  const when = row.locator('.ld-when');

  // nothing ellipsised: the box is at least as wide as its own (unclipped) content
  const { scrollW, clientW, innerText } = await when.evaluate((el) => (
    { scrollW: el.scrollWidth, clientW: el.clientWidth, innerText: el.innerText }
  ));
  expect(scrollW, `.ld-when overflows its own box (scrollWidth ${scrollW} > clientWidth ${clientW})`).toBeLessThanOrEqual(clientW);
  // `innerText` (not textContent) so this reads what a traveller actually sees: below 480px
  // the slot word itself is shortened ('afternoon' -> 'pm', see the generator's .ld-slot-short
  // rule) as the last-resort fix for this exact row, once the reflow alone still fell ~6px
  // short of the full word's natural width. The date is never shortened.
  expect(innerText, '.ld-when dropped the slot entirely').toMatch(/pm|afternoon/);
  expect(innerText, '.ld-when lost the date').toMatch(/\d{1,2} \w{3}/);

  // the "your date" tag is genuinely rendered, not just a border with no text in it
  const tag = row.locator('.ld-tag');
  await expect(tag).toBeVisible();
  const tagBox = await tag.boundingBox();
  expect(tagBox.width, 'the "your date" tag has no visible width').toBeGreaterThan(0);
  expect(tagBox.height, 'the "your date" tag has no visible height').toBeGreaterThan(0);

  const { lines } = await oneLine(when);
  expect(lines, 'the date wrapped onto multiple lines').toBe(1);

  // the count and the pill now share a second line, below the date, rather than the date
  // being squeezed to make room for them beside it
  const whenBox = await when.boundingBox();
  const countBox = await row.locator('.ld-count').boundingBox();
  const pillBox = await row.locator('.ld-pill').boundingBox();
  expect(Math.abs(countBox.y - pillBox.y), 'the count and the pill are not on the same line').toBeLessThanOrEqual(2);
  expect(countBox.y, 'the count/pill line is not below the date').toBeGreaterThan(whenBox.y);
});
