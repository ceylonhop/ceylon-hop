import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true },
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
];
test.beforeEach(async ({ page }) => {
  await blockLiveApi(page);
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
});
const enc = (s) => encodeURIComponent(s);

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: vp.viewport, hasTouch: !!vp.hasTouch, isMobile: !!vp.isMobile });

    test('same place twice in a row blocks Next with a red note; fixing it clears', async ({ page }) => {
      await page.goto('/plan.html?stops=' + enc('Kandy|Sigiriya / Dambulla|Sigiriya / Dambulla') + '&nights=0,0,0&through=0&pax=2&vehicle=car');
      const card = page.locator('#rail .leg-card').first();
      await expect(card).toHaveClass(/leg-bad/);
      await expect(card.locator('.leg-warn.stop')).toContainText('Same place twice in a row');
      await expect(card.locator('.leg-meta')).toContainText('Fix the route');
      await expect(card.locator('.add-via')).toBeDisabled();
      await expect(page.locator('#request-btn')).toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator('#route-incomplete-hint')).toContainText('Fix Leg 1 to continue');
      // pressing Next flags the leg; the duplicate keeps its red border past the flag's 2.2 s flash
      // aria-disabled reads as disabled to Playwright's actionability check; force sends the real click
      await page.locator('#request-btn').click({ force: true });
      await page.waitForTimeout(2600);
      await expect(card).toHaveClass(/leg-bad/);
      await expect(card.locator('.leg-warn.stop')).toHaveCount(1);
      // the flag focuses the From field, whose place list then covers the stop row
      await page.keyboard.press('Escape');
      const via = card.locator('.rb-field.via');
      await via.hover();
      await via.locator('.stop-rm').click();
      await expect(card).not.toHaveClass(/leg-bad/);
      await expect(page.locator('#request-btn')).toHaveAttribute('aria-disabled', 'false');
    });

    test('a round trip through a stop is allowed and priced', async ({ page }) => {
      await page.goto('/plan.html?stops=' + enc('Kandy|Sigiriya / Dambulla|Kandy') + '&nights=0,0,0&through=0&pax=2&vehicle=car');
      const card = page.locator('#rail .leg-card').first();
      await expect(card.locator('.leg-warn')).toHaveCount(0);
      await expect(card.locator('.leg-meta')).toContainText('km');
      await expect(page.locator('#request-btn')).toHaveAttribute('aria-disabled', 'false');
    });

    test('an empty stop row gates Next and never reaches the hand-off', async ({ page }) => {
      await page.goto('/plan.html?stops=' + enc('Kandy|Ella') + '&pax=2&vehicle=car');
      const card = page.locator('#rail .leg-card').first();
      await card.locator('.add-via').click();
      await expect(page.locator('#request-btn')).toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator('#route-incomplete-hint')).toContainText('Add a pick-up and drop-off to every leg to continue');
      await card.locator('.leg-via').fill('Sigiriya');
      await page.locator('.place-option', { hasText: 'Sigiriya' }).first().click();
      await expect(page.locator('#request-btn')).toHaveAttribute('aria-disabled', 'false');
      const via = card.locator('.rb-field.via');
      await via.hover();
      await via.locator('.stop-rm').click();
      await expect(card.locator('.rb-field.via')).toHaveCount(0);
      await card.locator('.add-via').click();
      await expect(card.locator('.rb-field.via')).toHaveCount(1);
      await expect.poll(() => new URL(page.url()).searchParams.get('stops')).toBe('Kandy|Ella');
      expect(new URL(page.url()).searchParams.get('through')).toBeNull();
    });
  });
}
