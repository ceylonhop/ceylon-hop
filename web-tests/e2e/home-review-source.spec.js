import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

test('homepage review source rows are accessible links with mobile-sized targets', async ({ page }) => {
  await page.goto('/index.html');

  const sources = page.locator('#reviews .rev .who');
  await expect(sources).toHaveCount(3);

  const first = sources.first();
  await expect(first).toHaveAttribute('href', /tripadvisor\.com/);
  await expect(first).toHaveAttribute('target', '_blank');
  await expect(first).toHaveAttribute('rel', /noopener/);
  await expect(first).toContainText('Marie-Eve W');
  await expect(first).toContainText('Review on Tripadvisor');
  await expect(first.locator('a')).toHaveCount(0);

  await page.setViewportSize({ width: 320, height: 844 });
  const target = await first.boundingBox();
  expect(target).toBeTruthy();
  expect(target.height).toBeGreaterThanOrEqual(44);

  await first.focus();
  await expect(first).toBeFocused();
  const focusStyle = await first.evaluate((el) => {
    const style = getComputedStyle(el);
    return { outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth) };
  });
  expect(focusStyle.outlineStyle).not.toBe('none');
  expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(2);

  expect(await page.locator('body').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});
