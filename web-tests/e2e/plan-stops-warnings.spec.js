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
      // Kandy → Nuwara Eliya → Ella stays under 6 h, so no long-day ask gates Next
      await card.locator('.leg-via').fill('Nuwara Eliya');
      await page.locator('.place-option', { hasText: 'Nuwara Eliya' }).first().click();
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

    test('a ≥ 6 h leg asks; Keep enables Next and reaches booking as ack; Split makes two legs', async ({ page }) => {
      // CMB → Ella → Arugam Bay is well over 6 h on the modelled km/42 clock.
      const go = () => page.goto('/plan.html?stops=' + enc('Colombo Airport (CMB)|Ella|Arugam Bay') + '&nights=0,0,0&through=0&pax=2&vehicle=car');
      await go();
      const card = page.locator('#rail .leg-card').first();
      const ask = card.locator('.leg-warn.long-day');
      await expect(ask).toContainText('Long day on the road');
      // the ask's hour figure is the one the card header shows (e.g. "470 km · 8h")
      const meta = await card.locator('.leg-meta').innerText();
      const n = meta.match(/(\d+)h/)[1];
      await expect(ask).toContainText(`about ${n} hours`);
      await expect(ask.locator('.dw-split')).toContainText('end this leg at Ella');
      await expect(page.locator('#request-btn')).toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator('#route-incomplete-hint')).toContainText('Answer the note on Leg 1');
      // pressing the (aria-disabled) Next must not open a place list over the ask, nor turn it red
      await page.locator('#request-btn').click({ force: true });
      await expect(page.locator('.place-menu')).toHaveCount(0);
      await expect(card).not.toHaveClass(/leg-bad/);
      await ask.locator('.dw-keep').click();
      await expect(card.locator('.leg-warn')).toHaveCount(0);
      await expect(page.locator('#request-btn')).toHaveAttribute('aria-disabled', 'false');
      await page.locator('#request-btn').click();
      await page.locator('#dates-continue').click();
      await page.waitForURL('**/booking.html?**');
      expect(new URL(page.url()).searchParams.get('ack')).toBe('0');

      await go();
      await page.locator('.leg-warn.long-day .dw-split').click();
      await expect(page.locator('#rail .leg-card')).toHaveCount(2);
      await expect(page.locator('#rail .leg-card').nth(0).locator('.leg-to')).toHaveValue('Ella');
      await expect(page.locator('#rail .leg-card').nth(1).locator('.leg-from')).toHaveValue('Ella');
      await expect(page.locator('#rail .leg-card').nth(1).locator('.leg-to')).toHaveValue('Arugam Bay');
      await expect(page.locator('#rail .leg-via')).toHaveCount(0);
    });

    test('editing a kept leg asks again', async ({ page }) => {
      await page.goto('/plan.html?stops=' + enc('Colombo Airport (CMB)|Ella|Arugam Bay') + '&nights=0,0,0&through=0&ack=0&pax=2&vehicle=car');
      await expect(page.locator('.leg-warn.long-day')).toHaveCount(0);
      const via = page.locator('#rail .leg-via');
      await via.fill('Kandy');
      await page.locator('.place-option', { hasText: 'Kandy' }).first().click();
      await expect(page.locator('.leg-warn.long-day')).toHaveCount(1);
    });
  });
}
