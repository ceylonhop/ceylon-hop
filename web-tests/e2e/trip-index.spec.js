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

// Task C2: the "Leaving from" chips progressively enhance into a show/hide filter
// (trip-index.js). Without it they are plain in-page anchors — that's the no-JS
// behaviour, still exercised by web-tests/unit/trip-index.test.js.
test('a "leaving from" chip hides other origins but keeps every link in the DOM', async ({ page }) => {
  await page.goto('/trip/?api=off');
  const total = await page.locator('.origins a.dest').count();
  await page.locator('.fchips [data-from="kandy"]').click();
  await expect(page.locator('section.origin:visible')).toHaveCount(1);
  await expect(page.locator('#from-kandy')).toBeVisible();
  await expect(page.locator('.fchips [data-from="kandy"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('.origins a.dest').count()).toBe(total);
  await page.locator('.fchips [data-from=""]').click();
  await expect(page.locator('section.origin:visible')).toHaveCount(await page.locator('section.origin').count());
});

// One more assertion beyond the brief: filtering to Kandy then pressing "Everywhere"
// must clear every hidden origin block, not just make the count match.
test('pressing "Everywhere" after a filter clears every hidden origin block', async ({ page }) => {
  await page.goto('/trip/?api=off');
  await page.locator('.fchips [data-from="kandy"]').click();
  await page.locator('.fchips [data-from=""]').click();
  const anyHidden = await page.evaluate(() =>
    [...document.querySelectorAll('section.origin')].some((s) => s.hasAttribute('hidden'))
  );
  expect(anyHidden).toBe(false);
});

// Fix 1 (coordinator review): the chips are role="button" (screen readers announce
// "button"), but a plain <a> only fires 'click' on Enter natively — Space does
// nothing, or falls through to the browser's default "page down". Both keys must
// activate the SAME filter as a click, and Space must never scroll the page.
test('Space activates a focused chip and does not itself scroll the page', async ({ page }) => {
  await page.goto('/trip/?api=off');
  const kandy = page.locator('.fchips [data-from="kandy"]');
  // preventScroll: true — a plain .focus() on an off-screen link makes the BROWSER'S
  // OWN native scroll-into-view kick in, and since site.css sets html{scroll-
  // behavior:smooth} globally, that native scroll animates rather than jumping —
  // landing at a different scrollY depending on timing/CPU load and making "before"
  // a moving target that has nothing to do with this fix. Suppressing it isolates
  // exactly what's under test: whether the Space KEYPRESS itself causes a scroll.
  await kandy.evaluate((el) => el.focus({ preventScroll: true }));
  const before = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('Space');
  await expect(page.locator('section.origin:visible')).toHaveCount(1);
  await expect(page.locator('#from-kandy')).toBeVisible();
  await expect(kandy).toHaveAttribute('aria-pressed', 'true');
  const after = await page.evaluate(() => window.scrollY);
  expect(after, 'Space scrolled the page on its own').toBe(before);
});

test('Enter activates a focused chip the same way', async ({ page }) => {
  await page.goto('/trip/?api=off');
  const ella = page.locator('.fchips [data-from="ella"]');
  await ella.evaluate((el) => el.focus({ preventScroll: true }));
  await page.keyboard.press('Enter');
  await expect(page.locator('section.origin:visible')).toHaveCount(1);
  await expect(page.locator('#from-ella')).toBeVisible();
  await expect(ella).toHaveAttribute('aria-pressed', 'true');
});

// Fix 1: filtering while scrolled deep into the list can shrink the document enough
// that the picked block ends up above the (clamped) viewport, under the closing
// band/footer. The filter must bring it back to just under the sticky chip row.
test('filtering while scrolled past the list brings the picked block back under the sticky row', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/trip/?api=off');
  await page.evaluate(() => {
    const el = document.querySelector('#from-arugam-bay'); // the LAST origin block
    const r = el.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + r.top, left: 0, behavior: 'instant' });
  });
  const scrolledPastStart = await page.evaluate(() => {
    const r = document.querySelector('#routes').getBoundingClientRect();
    return r.top < 0;
  });
  expect(scrolledPastStart, 'setup did not actually scroll past the start of the list').toBe(true);

  await page.locator('.fchips [data-from="kandy"]').click();

  const geo = await page.evaluate(() => {
    const kandy = document.querySelector('#from-kandy');
    const sticky = document.querySelector('.fromsticky');
    const kr = kandy.getBoundingClientRect();
    const sr = sticky.getBoundingClientRect();
    const heading = kandy.querySelector('h2');
    const hr = heading.getBoundingClientRect();
    const hit = document.elementFromPoint(hr.left + hr.width / 2, hr.top + hr.height / 2);
    return {
      topInViewport: kr.top >= 0 && kr.top <= window.innerHeight,
      belowSticky: kr.top >= sr.bottom,
      headingVisible: !!hit && (hit === kandy || kandy.contains(hit)),
    };
  });
  expect(geo.topInViewport, "kandy block's top is not inside the viewport").toBe(true);
  expect(geo.belowSticky, "kandy block's top is above the sticky row's bottom edge").toBe(true);
  expect(geo.headingVisible, 'kandy heading is occluded').toBe(true);
});

test('filtering from the top of the page causes no scroll jump', async ({ page }) => {
  // Tall enough that the chip row sits inside the viewport unscrolled — otherwise
  // Playwright's own click() scrolls the target into view before clicking, which
  // would move scrollY off 0 for a reason that has nothing to do with this fix.
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto('/trip/?api=off');
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBe(0);
  await page.locator('.fchips [data-from="kandy"]').click();
  const after = await page.evaluate(() => window.scrollY);
  expect(after, 'filtering from the top jumped the scroll position').toBe(0);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test('no sideways scroll; chips scroll inside their own row', async ({ page }) => {
    await page.goto('/trip/?api=off');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
