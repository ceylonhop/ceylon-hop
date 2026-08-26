import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

test('homepage blog cards open their matching articles', async ({ page }) => {
  await page.goto('/index.html');

  const cards = page.locator('#blog > a.bcard');
  await expect(cards).toHaveCount(3);
  const hrefs = await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
  expect(hrefs).toEqual([
    'why-we-started-ceylon-hop/',
    'ultimate-tuk-tuk-guide-to-getting-around-in-sri-lanka/',
    'best-time-to-visit-sri-lanka-a-month-by-month-guide/',
  ]);

  await expect(page.getByRole('link', { name: 'Read the blog' }))
    .toHaveAttribute('href', 'blog.html');
});
