import { test, expect } from '@playwright/test';

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
  { page: '/index.html', id: 'why-photo',      ratio: 4 / 3.2 },
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
