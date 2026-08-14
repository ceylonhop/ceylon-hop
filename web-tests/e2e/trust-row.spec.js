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

  It used to answer that by degrading into a 3-column and then a 2-column grid — but a grid
  of five items IS the two-row stack, just tidied up, and that stack is what the strip is
  meant to avoid. The row now stays ONE line at every width: it scales type, icons and gaps
  together from 1159px down to 1041px, and below that hands over to the horizontal scroll
  strip (still one line, just swipeable).

  1040 is where the shrinking stops being honest. Measured against this copy, five items need
  ~926px at .70rem with 20px icons; the pre-webfont fallback sets ~3.7% wider on Linux and
  Android (~960px) against a 992px content box at 1040. Below that the type would have to go
  under 11px — smaller than anything else on the site — so the strip takes over instead.

  Three things are asserted, because fixing only one lets the bug back in:
    1. at desktop it genuinely fits on ONE line, with measurable headroom;
    2. through the scaling band it stays one line, unwrapped and un-overflowing; and
    3. at NO width does it become a grid or gain a second visual row.

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

// The scaling band: still a real one-line row, so it must fit its box, not merely avoid
// wrapping by overflowing out of it.
for (const width of [1159, 1140, 1120, 1080, 1060, 1041]) {
  test(`the trust strip shrinks to stay on one line at ${width}px`, async ({ page }) => {
    await open(page, width);
    const g = await geometry(page);
    expect(g.display, 'one flex line — the grids that split five items 3+2 are gone').toBe('flex');
    expect(g.visualRows, 'one line, never a second row').toBe(1);
    expect(g.wrappedLabels, 'no label may wrap to two lines').toBe(0);
    expect(g.overflows, 'shrinking must fit the box, not spill out of it').toBe(false);
    expect(g.headroom, `${g.headroom}px of slack (needs ${g.needed} of ${g.contentBox})`)
      .toBeGreaterThanOrEqual(0);
  });
}

// Below the band the strip swipes. Still one line — the point of the whole exercise.
for (const width of [1040, 1000, 900, 800, 600, 375]) {
  test(`the trust strip is a one-line scroll strip at ${width}px`, async ({ page }) => {
    await open(page, width);
    const g = await geometry(page);
    expect(g.visualRows, 'one scrollable line, not a stack').toBe(1);
    expect(g.wrappedLabels, 'no label may wrap to two lines').toBe(0);
    expect(g.overflows, 'scrolls horizontally by design below the scaling band').toBe(true);
  });
}

// The regression this file exists for, stated directly: no width may produce the 3+2 stack.
test('no width turns the strip into a grid or a second row', async ({ page }) => {
  for (const width of [1440, 1300, 1200, 1160, 1159, 1100, 1041, 1040, 950, 800, 700, 500, 375]) {
    await open(page, width);
    const g = await geometry(page);
    expect(g.display, `grid at ${width}px`).not.toBe('grid');
    expect(g.visualRows, `${g.visualRows} visual rows at ${width}px`).toBe(1);
  }
});
