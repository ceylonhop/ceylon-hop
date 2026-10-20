// The destination guide in a real browser, fully offline (the engine 404s, so Where next shows
// the catalogue fares — exactly what a customer sees when the API is slow).
import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

const URL = '/guides/nuwara-eliya/';

test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

test('renders with the site chrome and the right links', async ({ page }) => {
  await page.goto(URL);
  await expect(page).toHaveTitle(/Nuwara Eliya guide/);
  await expect(page.locator('header.nav a', { hasText: 'Routes & prices' })).toHaveAttribute('href', '../../trip/');
  await expect(page.locator('footer a', { hasText: 'Travel guide' })).toHaveAttribute('href', '../../blog.html');
  const book = page.locator('#here a.btn-cta');
  await expect(book).toHaveCount(3);
  await expect(book.first()).toHaveAttribute('href', '../../search.html?from=kandy&to=nuwara-eliya');
});

test('jump nav scrolls to the section and lights its chip', async ({ page }) => {
  await page.goto(URL);
  await page.locator('#jump a[href="#qa"]').click();
  await expect(page.locator('#jump a[href="#qa"]')).toHaveClass(/on/);
  await expect.poll(() => page.locator('#qa').evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(200);
});

test('FAQ tabs switch groups and "More" expands an Eat card', async ({ page }) => {
  await page.goto(URL);
  await page.locator('#qtabs button', { hasText: 'Good to know' }).click();
  await expect(page.locator('.groups .group.on .tips li').first()).toBeVisible();
  const card = page.locator('#eat .pl').first();
  await card.locator('.tg').click();
  await expect(card).toHaveClass(/open/);
  await expect(card.locator('.tg')).toHaveText('Less');
});

test('Where next shows four priced cards linking to trip pages', async ({ page }) => {
  await page.goto(URL);
  const cards = page.locator('#next a.rt-card');
  await expect(cards).toHaveCount(4);
  await expect(cards.first()).toHaveAttribute('href', /\.\.\/\.\.\/trip\/nuwara-eliya-to-(kandy|ella)\//);
  // The catalogue figure is baked in and, offline, is what stays (list-fares-pending is released by the timer).
  await expect(cards.first().locator('[data-list-fare]')).toHaveText(/^\$\d/);
});

test('on a phone the Where-next row scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(URL);
  const row = page.locator('#next .next');
  const scrollable = await row.evaluate(el => el.scrollWidth > el.clientWidth + 50);
  expect(scrollable).toBe(true);
  await row.scrollIntoViewIfNeeded();
  await expect(page.locator('#next .swipe-hint')).toBeVisible();
});
