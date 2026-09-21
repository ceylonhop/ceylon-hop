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
      // behavior:'instant' matters: site.css sets html{scroll-behavior:smooth} globally, so a
      // plain scrollBy(x,y) animates and the very next getBoundingClientRect() below still
      // reads the PRE-scroll position — silently testing the wrong point instead of failing.
      window.scrollBy({ top: rect.top - margin, left: 0, behavior: 'instant' });
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

// Fix 2: the trust strip (`.trust ul`) had no width reservation for the `.fares` card
// overlapping down into it (the prototype's `.trust ul{max-width:calc(100% - 440px)}` was
// dropped in the port), so at desktop widths the row ran full-width and its last item slid
// UNDER the card instead of wrapping to a second line — "WhatsApp support 7 days" read as
// "WhatsApp supp" because the card (z-index:2) painted over the rest of it.
async function trustItemOcclusion(page) {
  return page.evaluate(() => {
    const margin = 10;
    // Same reasoning as hitTestsSelf above: a real minimal page-level scroll per item (never
    // scrollIntoView, and never against .hero's own overflow:hidden ancestor), forced instant
    // (site.css: html{scroll-behavior:smooth} would otherwise animate it, leaving the very next
    // getBoundingClientRect() read stale) so a point that is merely below the fold at a short
    // viewport isn't mistaken for occlusion. .fares moves with the rest of the page, so it's
    // re-measured after each item's scroll too.
    return [...document.querySelectorAll('.trust li')].map((li) => {
      let r = li.getBoundingClientRect();
      if (r.bottom > window.innerHeight - margin || r.top < margin) {
        window.scrollBy({ top: r.top - margin, left: 0, behavior: 'instant' });
        r = li.getBoundingClientRect();
      }
      const fares = document.querySelector('.fares').getBoundingClientRect();
      const cy = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
      const cx = r.left + r.width / 2;
      const rx = Math.min(window.innerWidth - 1, Math.max(0, r.right - 2));
      const centre = document.elementFromPoint(cx, cy);
      const rightEdge = document.elementFromPoint(rx, cy);
      const selfAtCentre = !!centre && (centre === li || li.contains(centre));
      const selfAtRightEdge = !!rightEdge && (rightEdge === li || li.contains(rightEdge));
      const overlapsFares = r.left < fares.right && r.right > fares.left && r.top < fares.bottom && r.bottom > fares.top;
      return { text: li.textContent, selfAtCentre, selfAtRightEdge, overlapsFares };
    });
  });
}

for (const vp of [{ width: 1280, height: 900 }, { width: 1024, height: 800 }, { width: 375, height: 812 }]) {
  test(`trust strip items stay fully readable, never under the hero card, at ${vp.width}x${vp.height}`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto('/trip/?api=off');
    const items = await trustItemOcclusion(page);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.selfAtCentre, `"${item.text}" occluded at its centre`).toBe(true);
      expect(item.selfAtRightEdge, `"${item.text}" occluded at its right edge`).toBe(true);
      expect(item.overlapsFares, `"${item.text}" horizontally/vertically overlaps the fares card`).toBe(false);
    }
  });
}
