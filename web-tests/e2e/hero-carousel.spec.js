import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

/*
  The hero photo is an <image-slot> whose src is img/hero-photo.jpg (a plain <img> of the same
  file sits under it so the photo paints before JS — see hero-photo-lcp.test.js). The carousel
  is built from four such slots so the hero stays editable exactly as it was.

  Slides 2–4 ship with their file in data-src, not src: the carousel script copies it across
  only after the window load event, once the photo has downloaded, so they never compete with the
  first photo for bandwidth (hero-carousel-photos.test.js holds the markup to that).

  The rule that makes this safe: a slot with no image is not a slide. If the later photos never
  arrive (blocked, failed, data saver) the hero must look and behave precisely like the
  one-photo hero — no dots, no rotation, no empty placeholder stacked over the photo — and
  become a carousel the moment a second photo is there.

  Slots are filled here by setting the author-controlled `src` attribute, which is the same
  path a dropped image takes to data-filled (image-slot.js _render()).
*/

const PX =
  'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';

const LATE_PHOTOS = /\/img\/hero-photo-\d\.jpg$/;

const slides = (page) => page.locator('#pc-photos image-slot');
const dots = (page) => page.locator('#hero-dots button');

async function fill(page, ids) {
  await page.evaluate(
    ({ ids, px }) => ids.forEach((id) => document.getElementById(id).setAttribute('src', px)),
    { ids, px: PX },
  );
}

const activeIndex = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#pc-photos image-slot')].findIndex((s) =>
      s.classList.contains('hs-on'),
    ),
  );

test.describe('the four shipped photos', () => {
  test.beforeEach(async ({ page }) => {
    await blockLiveApi(page);
  });

  test('become a carousel once the page has loaded', async ({ page }) => {
    await page.goto('/index.html');
    await expect(dots(page)).toHaveCount(4);
    await expect(page.locator('#pc-photos')).toHaveClass(/hs-live/);
    expect(await activeIndex(page)).toBe(0);
  });

  test('are not fetched until the page has finished loading', async ({ page }) => {
    await page.goto('/index.html');
    await expect(dots(page)).toHaveCount(4);
    const t = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const late = performance.getEntriesByType('resource')
        .filter((r) => /\/img\/hero-photo-\d\.jpg$/.test(r.name));
      return {
        loadEnd: nav.loadEventEnd,
        files: [...new Set(late.map((r) => r.name.split('/').pop()))].sort(),
        starts: late.map((r) => r.startTime),
      };
    });
    // Each file appears twice here: the preload, then the slot's own <img>. This test
    // server sends no cache headers; the live site sends max-age, so the second is a cache hit.
    expect(t.files).toEqual(['hero-photo-2.jpg', 'hero-photo-3.jpg', 'hero-photo-4.jpg']);
    for (const start of t.starts) expect(start).toBeGreaterThanOrEqual(t.loadEnd);
  });

  test('are skipped entirely when the traveller has asked to save data', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true });
    });
    const fetched = [];
    page.on('request', (r) => { if (LATE_PHOTOS.test(r.url())) fetched.push(r.url()); });
    await page.goto('/index.html');
    await page.waitForLoadState('load');
    await page.waitForTimeout(2500); // past the idle callback's 2 s timeout
    expect(fetched).toEqual([]);
    await expect(page.locator('#hero-dots')).toBeHidden();
  });
});

// Below, the three later photos fail to load — the hero falls back to the one-photo state and
// the carousel's own rules are exercised with stand-in images.
test.describe('when the later photos fail to load', () => {
  test.beforeEach(async ({ page }) => {
    await blockLiveApi(page);
    await page.route(LATE_PHOTOS, (route) => route.abort());
    await page.goto('/index.html');
    await page.waitForLoadState('load');
  });

  test('one photo is not a carousel', async ({ page }) => {
    // only #hero-photo carries an image: the later photos failed, so they are not slides
    await expect(slides(page).first()).toHaveAttribute('data-filled', '');
    await expect(page.locator('#hero-dots')).toBeHidden();
    await expect(page.locator('#pc-photos')).not.toHaveClass(/hs-live/);

    // and the one real photo is fully visible, not faded out by carousel styling
    const opacity = await slides(page).first().evaluate((s) => getComputedStyle(s).opacity);
    expect(Number(opacity)).toBe(1);
  });

  test('an unfilled slot is never shown to a visitor', async ({ page }) => {
    // Empty slots draw an authoring placeholder. A visitor has no editing runtime, so they must
    // not be rendered at all — otherwise the hero photo sits under an empty dashed box.
    for (const n of [1, 2, 3]) await expect(slides(page).nth(n)).toBeHidden();
  });

  test('dropping a second photo turns the hero into a carousel', async ({ page }) => {
    await fill(page, ['hero-photo-2']);

    await expect(page.locator('#hero-dots')).toBeVisible();
    await expect(dots(page)).toHaveCount(2);
    await expect(page.locator('#pc-photos')).toHaveClass(/hs-live/);
    expect(await activeIndex(page)).toBe(0);
  });

  test('the carousel advances on its own', async ({ page }) => {
    await fill(page, ['hero-photo-2', 'hero-photo-3']);
    await expect(dots(page)).toHaveCount(3);
    expect(await activeIndex(page)).toBe(0);

    await expect.poll(() => activeIndex(page), { timeout: 9000, message: 'should advance to slide 2' })
      .toBe(1);
  });

  test('each photo stays up for 5 seconds', async ({ page }) => {
    // a fake clock, so the interval is measured exactly rather than raced against a real one
    await page.clock.install();
    await page.goto('/index.html');
    // install() alone leaves the fake clock ticking in real time, so the round trips below ate
    // into the 100 ms margin and the slide had already advanced. Freeze it; only runFor moves it.
    await page.clock.pauseAt(Date.now() + 60_000);
    await fill(page, ['hero-photo-2', 'hero-photo-3']);
    await expect(dots(page)).toHaveCount(3);
    expect(await activeIndex(page)).toBe(0);

    await page.clock.runFor(4900);
    expect(await activeIndex(page)).toBe(0);
    await page.clock.runFor(200);
    expect(await activeIndex(page)).toBe(1);
  });

  test('a dot jumps straight to its photo', async ({ page }) => {
    await fill(page, ['hero-photo-2', 'hero-photo-3']);
    await expect(dots(page)).toHaveCount(3);

    await dots(page).nth(2).click();
    expect(await activeIndex(page)).toBe(2);
    await expect(dots(page).nth(2)).toHaveAttribute('aria-current', 'true');
    await expect(dots(page).nth(0)).toHaveAttribute('aria-current', 'false');
  });

  test('under reduced motion nothing rotates on its own, but the photos stay reachable', async ({ page }) => {
    // page.emulateMedia, not test.use({reducedMotion}) — the fixture does not reach the page in
    // this setup (matchMedia still reports false), which would have made this test pass for the
    // wrong reason. The carousel reads matchMedia live on every start(), so emulating after load
    // is enough.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);

    await fill(page, ['hero-photo-2', 'hero-photo-3']);
    await expect(dots(page)).toHaveCount(3);
    expect(await activeIndex(page)).toBe(0);

    // give it more than one interval — it must not move by itself
    await page.waitForTimeout(7000);
    expect(await activeIndex(page)).toBe(0);

    // the dots remain the manual way through
    await dots(page).nth(1).click();
    expect(await activeIndex(page)).toBe(1);
  });
});
