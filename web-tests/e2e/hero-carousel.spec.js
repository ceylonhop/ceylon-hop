import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

/*
  The hero photo is an <image-slot>: its image lives as a blob in image-slots.state.json and
  is dropped in by hand, not referenced from img/. The carousel is built from three such
  slots so the hero stays editable exactly as it was.

  The rule that makes this safe to ship half-filled: a slot with no image is not a slide. Only
  one photo exists today, so the hero must look and behave precisely as it does now — no dots,
  no rotation, no empty placeholder stacked over the photo — and become a carousel the moment
  a second photo is dropped in.

  Slots are filled here by setting the author-controlled `src` attribute, which is the same
  path a dropped image takes to data-filled (image-slot.js _render()).
*/

const PX =
  'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';

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

test.beforeEach(async ({ page }) => {
  await blockLiveApi(page);
  await page.goto('/index.html');
});

test('one photo is not a carousel', async ({ page }) => {
  // the shipped state: only #hero-photo carries an image
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
  await expect(slides(page).nth(1)).toBeHidden();
  await expect(slides(page).nth(2)).toBeHidden();
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
