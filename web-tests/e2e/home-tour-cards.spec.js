import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

test('homepage tour cards keep transport pricing and actions clear on mobile', async ({ page }) => {
  await page.goto('/index.html');

  const cards = page.locator('#home-tours .htour');
  await expect(cards).toHaveCount(3);

  const classic = cards.first();
  await expect(classic.locator('.ht-price-label')).toHaveText('Private transport');
  await expect(classic.locator('.ht-price-value')).toHaveText('From $357.45');
  await expect(classic.locator('.ht-foot')).not.toContainText('point-to-point');
  await expect(classic.locator('.ht-custom')).toContainText('Customise this route');
  await expect(classic.locator('.ht-custom')).not.toContainText('Open in the planner & make it yours');

  await page.setViewportSize({ width: 320, height: 844 });
  await classic.scrollIntoViewIfNeeded();

  const layout = await classic.evaluate((card) => {
    const price = card.querySelector('.ht-price-value').getBoundingClientRect();
    const action = card.querySelector('.tc-go').getBoundingClientRect();
    return {
      priceRight: price.right,
      actionLeft: action.left,
      priceHeight: price.height,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });

  expect(layout.priceRight).toBeLessThanOrEqual(layout.actionLeft);
  expect(layout.priceHeight).toBeLessThanOrEqual(30);
  expect(layout.scrollWidth).toBe(layout.clientWidth);
});
