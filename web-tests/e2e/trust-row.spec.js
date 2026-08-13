import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

// index.html pings the live API on load (0e0f077) — keep the suite offline.
test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

/*
  The homepage trust strip carries five items and has almost no slack.

  It broke on the brand-book pass: Poppins sets ~11.6% wider than the Hanken Grotesk it
  replaced, so the row went from needing ~1145px to ~1243px against a 1152px inner
  .wrap. It had only ever fitted by about 7px, so the swap pushed it over at EVERY
  desktop width — four items on one line and the fifth orphaned underneath, still
  justified apart because justify-content was space-between.

  Two things are asserted here, because fixing only one lets the bug back in:
    1. at desktop it genuinely fits on ONE line, with measurable headroom; and
    2. at every narrower width it degrades into an even grid, with no label wrapping
       to two lines inside its cell.

  A future copy change ("Free cancellation 24h before" is the tightest label) or another
  type change should fail here rather than in a screenshot.
*/

const geometry = (page) =>
  page.evaluate(() => {
    const row = document.querySelector('.trust-row');
    const cs = getComputedStyle(row);
    const kids = [...row.children];
    const content = row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const used =
      kids.reduce((a, k) => a + k.getBoundingClientRect().width, 0) +
      (kids.length - 1) * parseFloat(cs.gap || 0);
    const tops = [...new Set(kids.map((k) => Math.round(k.getBoundingClientRect().top)))];
    const wrappedLabels = kids.filter((k) => {
      const lh = parseFloat(getComputedStyle(k).lineHeight) || 20;
      return k.getBoundingClientRect().height > lh * 1.6;
    }).length;
    return {
      items: kids.length,
      visualRows: tops.length,
      display: cs.display,
      justify: cs.justifyContent,
      contentBox: Math.round(content),
      needed: Math.round(used),
      headroom: Math.round(content - used),
      wrappedLabels,
      paddingLeft: parseFloat(cs.paddingLeft),
      overflows: row.scrollWidth > row.clientWidth + 1,
    };
  });

async function open(page, width) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/index.html');
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('.trust-row .item').first()).toBeVisible();
}

test('the trust strip fits on one line at desktop, with real headroom', async ({ page }) => {
  await open(page, 1440);
  const g = await geometry(page);

  expect(g.items, 'five trust items').toBe(5);
  expect(g.visualRows, 'must be a single line at desktop').toBe(1);
  expect(g.justify).toBe('space-between');
  // The regression shipped with ~1px of slack and then none at all. Demand a real margin
  // so the next copy or type tweak does not silently re-break it.
  expect(g.headroom, `only ${g.headroom}px of slack (needs ${g.needed} of ${g.contentBox})`)
    .toBeGreaterThanOrEqual(24);
});

test('the trust strip keeps the page gutter', async ({ page }) => {
  await open(page, 1440);
  const g = await geometry(page);
  // .trust-row is `class="wrap trust-row"`, and a `padding: X 0` shorthand silently
  // cancels .wrap's 0 24px gutter — which ran the strip edge-to-edge, out of line with
  // every other section. It must use padding-block.
  expect(g.paddingLeft, 'the strip must line up with the rest of the page').toBeGreaterThan(0);
});

for (const width of [1159, 1100, 1000, 951, 950, 900, 800, 761]) {
  test(`the trust strip degrades to an even grid at ${width}px`, async ({ page }) => {
    await open(page, width);
    const g = await geometry(page);
    expect(g.display, 'an even grid, not a ragged wrapped flex row').toBe('grid');
    expect(g.wrappedLabels, 'no label may wrap to two lines inside its cell').toBe(0);
    expect(g.overflows, 'must not scroll horizontally above the mobile breakpoint').toBe(false);
  });
}

test('the trust strip becomes a scroll strip on mobile', async ({ page }) => {
  await open(page, 375);
  const g = await geometry(page);
  expect(g.visualRows, 'one scrollable line, not a stack').toBe(1);
  expect(g.overflows, 'scrolls horizontally by design below 760px').toBe(true);
});
