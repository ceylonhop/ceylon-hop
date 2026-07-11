import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact } from './_stubs.js';

// Mobile sticky-bar contract (spec: docs/superpowers/specs/2026-07-09-mobile-booking-sticky-bar-design.md).
// ≤880px: slim context strip on top, sticky total+CTA bar at bottom, summary card = bottom sheet.
// Desktop ≥881px: exactly today's layout (aside column, in-page buttons).

const MOBILE = { width: 390, height: 844 };

// The cookie banner is bottom-fixed above the bar (z 9999) and intercepts taps in fresh
// sessions; seed a prior "denied" choice so these tests behave like a returning visitor.
async function gotoMobile(page, opts) {
  await page.addInitScript(() => { try { localStorage.setItem('ceylonhop_consent', 'denied'); } catch (e) {} });
  await gotoBooking(page, opts);
}

test.describe('mobile sticky bar', () => {
  test.use({ viewport: MOBILE });

  test('strip + bar visible, panel starts high, total mirrors summary', async ({ page }) => {
    await gotoMobile(page); // private CMB->Hikkaduwa, no date => When step active
    await expect(page.locator('#mstrip')).toBeVisible();
    await expect(page.locator('#mbar')).toBeVisible();
    const panel = await page.locator('.stepcard.panel.active').boundingBox();
    expect(panel.y).toBeLessThan(480); // step content on the first screen
    const strip = await page.locator('#mstrip').boundingBox();
    expect(strip.height).toBeLessThanOrEqual(90);
    const sumTotal = (await page.locator('#sum-total').textContent()).trim();
    await expect(page.locator('#mbar-amt')).toHaveText(sumTotal);
    // route reassurance present in the strip
    await expect(page.locator('#ms-route')).toContainText('→');
  });

  test('bar CTA proxies the active panel button and advances the step', async ({ page }) => {
    await gotoMobile(page); // When step: #n2 "Continue" is enabled for private
    await expect(page.locator('.panel.active[data-panel="1"]')).toBeVisible();
    await page.locator('#mbar-cta').click();
    await expect(page.locator('.panel.active[data-panel="2"]')).toBeVisible();
  });

  test('bar CTA mirrors label and disabled state on the payment step', async ({ page }) => {
    await gotoBooking(page);
    await page.evaluate(() => window.goStep(4));
    await expect(page.locator('#mbar-cta')).toContainText('Continue to secure payment');
    // terms unchecked => real #pay-btn disabled state must be mirrored exactly
    const realDisabled = await page.locator('#pay-btn').isDisabled();
    expect(await page.locator('#mbar-cta').isDisabled()).toBe(realDisabled);
  });

  test('changing the price (extras toggle) updates the bar total live', async ({ page }) => {
    // Private prices are per vehicle, so pax steppers don't move the total — the
    // sightseeing extra (+$10) is the deterministic price-changing interaction.
    await gotoMobile(page);
    await page.evaluate(() => window.goStep(3));
    const before = (await page.locator('#mbar-amt').textContent()).trim();
    await page.locator('[data-addon="sightseeing"]').click();
    await expect(page.locator('#mbar-amt')).not.toHaveText(before);
    const sumTotal = (await page.locator('#sum-total').textContent()).trim();
    await expect(page.locator('#mbar-amt')).toHaveText(sumTotal);
  });

  test('sheet opens from total button and strip, shows perks + WhatsApp, closes via scrim and Escape', async ({ page }) => {
    await gotoMobile(page);
    await page.locator('#mbar-total').click();
    const aside = page.locator('.layout > aside');
    await expect(aside).toHaveClass(/open/);
    await expect(page.locator('.s-perks')).toBeVisible();
    await expect(page.locator('#s-wa')).toBeVisible();
    const sum = await page.locator('#summary').boundingBox();
    expect(sum.x).toBeGreaterThanOrEqual(0);
    // click the scrim ABOVE the sheet (the sheet caps at 78dvh, so the top band is
    // always exposed scrim; Playwright's default center-click can land on the sheet)
    await page.locator('#mbar-scrim').click({ position: { x: 195, y: 60 } });
    await expect(aside).not.toHaveClass(/open/);
    await page.locator('#mstrip').click();
    await expect(aside).toHaveClass(/open/);
    await page.keyboard.press('Escape');
    await expect(aside).not.toHaveClass(/open/);
  });

  test('focusing a details input hides the bar; blur restores it', async ({ page }) => {
    await gotoBooking(page);
    await page.evaluate(() => window.goStep(4));
    await page.locator('#f-first').focus();
    await expect(page.locator('#mbar')).toBeHidden();
    await page.locator('#f-first').blur();
    await expect(page.locator('#mbar')).toBeVisible();
  });

  test('the sticky bar + strip are hidden on the confirmation screen (no re-trigger of payment)', async ({ page }) => {
    await gotoMobile(page); // default fake gateway → simulate path → boarding pass
    await fillContact(page);
    // fillContact leaves a details field focused, which hides the bar (keyboard-avoidance);
    // blur to restore it, then use the bar's CTA (the in-panel pay button is hidden on mobile).
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await expect(page.locator('#mbar-cta')).toBeVisible();
    await page.locator('#mbar-cta').click();
    await expect.poll(() => page.locator('#pass-ref').textContent(), { timeout: 8000 }).toMatch(/CH-/);
    // the pay CTA must not float over the boarding pass where a stray tap re-books/charges
    await expect(page.locator('#mbar')).toBeHidden();
    await expect(page.locator('#mstrip')).toBeHidden();
  });
});

test('desktop is unchanged: no strip/bar, aside column, in-page primary button', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoBooking(page);
  await expect(page.locator('#mstrip')).toBeHidden();
  await expect(page.locator('#mbar')).toBeHidden();
  const aside = await page.locator('.layout > aside').boundingBox();
  const panel = await page.locator('.stepcard.panel.active').boundingBox();
  expect(aside.x).toBeGreaterThan(panel.x + 100); // right column, not stacked
  await expect(page.locator('.panel.active .nav-btns .btn')).toBeVisible();
});
