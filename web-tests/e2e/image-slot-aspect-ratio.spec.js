import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

// index.html/why.html/tours.html ping the live API on load (0e0f077) — keep the suite offline.
test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

// <image-slot>'s :host used to hard-set `height:160px`. Call sites size their slots with
// `width:100%;aspect-ratio:4/3` and never override height — and an explicit height BEATS
// aspect-ratio (which only computes a *missing* dimension), so ~15 slots across the site
// silently collapsed to a 160px letterbox and hard-cropped their photo.
//
// The unit test guards the CSS contract at source level; jsdom has no layout engine, so this
// is the test that can actually see the rendered box.

const CASES = [
  { page: '/about.html', id: 'about-gal-0',    ratio: 4 / 3 },
  { page: '/about.html', id: 'about-team-0',   ratio: 4 / 4.4 },
  { page: '/about.html', id: 'about-train',    ratio: 4 / 3.2 },
  { page: '/why.html',   id: 'why-jetty',      ratio: 4 / 3.4 },
  { page: '/why.html',   id: 'why-driver',     ratio: 4 / 4.6 },
  { page: '/blog.html',  id: 'blog-post-0',    ratio: 16 / 10 },
  { page: '/blog.html',  id: 'blog-feature',   ratio: 16 / 10 },
];

// Slots sized by their own CSS (height:100% / fixed band heights) must NOT be disturbed by
// the component default — these are the regression guards for the fix itself.
const UNCHANGED = [
  { page: '/tours.html', id: 'tour-photo-classic-hop', ratio: 16 / 10 },
  { page: '/blog.html',  id: 'blog-hero',              ratio: 4 / 1 },
];

async function box(page, id) {
  return page.$eval(`#${id}`, el => {
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
}

for (const { page: path, id, ratio } of [...CASES, ...UNCHANGED]) {
  test(`${id} renders at its intended aspect ratio (${path})`, async ({ page }) => {
    await page.goto(path);
    await page.waitForSelector(`#${id}`);
    const { w, h } = await box(page, id);

    expect(h, `${id} has zero height`).toBeGreaterThan(0);
    // The 160px collapse is the specific failure this guards against.
    expect(h, `${id} collapsed to the old 160px default`).not.toBe(160);
    expect(w / h).toBeCloseTo(ratio, 1);
  });
}

// #why-photo is deliberately NOT a fixed-ratio slot. On desktop it stretches to the height of
// the copy column beside it so the "Not a tour" band doesn't leave a void above and below a
// centred image. That only holds because the asset is PORTRAIT (1200x1800) — a landscape source
// in a frame this tall gets its sides cropped off, which is what a 4/3.2 asset did here before.
test('why-photo stretches to the copy column on desktop (/index.html)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/index.html');
  await page.waitForSelector('#why-photo');

  const { photo, copy } = await page.evaluate(() => {
    const [, right] = document.querySelector('.split').children;
    return {
      photo: document.querySelector('#why-photo').getBoundingClientRect().height,
      copy: right.getBoundingClientRect().height,
    };
  });

  expect(photo, 'why-photo has zero height').toBeGreaterThan(0);
  expect(photo, 'why-photo collapsed to the old 160px default').not.toBe(160);
  expect(Math.abs(photo - copy), 'why-photo should match the copy column').toBeLessThan(4);
});

// The source must stay portrait, or the desktop stretch silently starts cropping the subject.
test('why-photo source is portrait (/index.html)', async ({ page }) => {
  await page.goto('/index.html');
  const ratio = await page.evaluate(async () => {
    const src = document.querySelector('#why-photo').getAttribute('src');
    const im = new Image();
    await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = src; });
    return im.naturalWidth / im.naturalHeight;
  });
  expect(ratio, 'why-photo source must be taller than it is wide').toBeLessThan(1);
});

// Below the 860px split breakpoint the slot falls back to a fixed portrait ratio.
test('why-photo keeps a portrait ratio on mobile (/index.html)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/index.html');
  await page.waitForSelector('#why-photo');
  const { w, h } = await box(page, 'why-photo');
  expect(h).toBeGreaterThan(0);
  expect(w / h).toBeCloseTo(4 / 4.6, 1);
});
