import { test, expect } from '@playwright/test';

// /trip/ index coverage. A later task adds more tests to this same file — keep it tidy.
//
// Fix 1: the hero's `.fares` card is designed to overlap the hero's bottom edge (negative
// margin-bottom, like the prototype and the home booking widget), but `.hero` itself computed
// `overflow:hidden` (needed only to contain the absolutely-positioned hero photo), which clipped
// the card's own bottom — slicing the submit button and hiding the fine print beneath it.

/** True if the element at `sel`'s own bottom edge (centre-x, 2px above its bottom) is that
    element itself or one of its descendants — i.e. nothing else is painted over it there.
    Deliberately does NOT use scrollIntoView(): that walks up to the NEAREST scrollable
    ancestor first, and `.hero{overflow:hidden}` (needed only to clip its own background photo)
    qualifies as one — so scrollIntoView on a clipped descendant silently scrolls `.hero`'s own
    hidden internal scrollport to reveal it, which "fixes" the exact bug this checks for before
    the hit test ever runs. A real visitor never does that (there is no scrollbar and nothing
    drives it); the only real scroll they can do is the page's own, so that's the only kind used
    here — and only far enough to keep the test point on-screen at all. */
async function hitTestsSelf(page, sel) {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    const margin = 10;
    let rect = el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - margin || rect.top < margin) {
      window.scrollBy(0, rect.top - margin);
      rect = el.getBoundingClientRect();
    }
    const x = rect.left + rect.width / 2;
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.bottom - 2));
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit));
  }, sel);
}

for (const vp of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
  test(`hero card's submit button and fine print are not clipped at ${vp.width}x${vp.height}`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto('/trip/?api=off');

    expect(await hitTestsSelf(page, '.fares button[type="submit"]'), 'submit button clipped').toBe(true);
    expect(await hitTestsSelf(page, '.fares p.fine'), 'fine print clipped').toBe(true);

    const overflowsX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflowsX, 'page scrolls sideways').toBe(false);
  });
}

test('the "Leaving from" label never truncates at 1280x900', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/trip/?api=off');
  const clipped = await page.evaluate(() => {
    const el = document.querySelector('.fromsticky .lbl');
    return el.scrollWidth > el.clientWidth;
  });
  expect(clipped, 'the "Leaving from" label is truncated').toBe(false);
});
