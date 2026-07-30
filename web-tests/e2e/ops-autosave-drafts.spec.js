import { test, expect } from '@playwright/test';

// Autosave shells (spec 2026-07-29): "+ New quote" creates the row up front, so an ops agent can
// assign the ticket on the call — before anything is priceable — and never presses Save.
test.skip(process.env.CH_E2E_API !== '1', 'ops autosave-draft e2e needs the API — run with CH_E2E_API=1');

const OPS = (process.env.OPS_BASE || 'http://localhost:8787') + '/ops';
const FOUNDER_EMAIL = 'founder@e2e.test';

// Copied from ops-ui.spec.js — see that file for why requestSubmit() beats a click here.
async function login(page, email) {
  await page.goto(OPS);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#login')).toHaveClass(/show/);
  await page.fill('#devloginemail', email);
  await page.evaluate(() => document.getElementById('devloginform').requestSubmit());
  await expect(page.locator('#login')).not.toHaveClass(/show/);
  await expect(page.locator('#approot')).toBeVisible({ timeout: 10000 });
}

test.describe('ops autosave drafts', () => {
  test('a brand-new quote is assignable with no Save click', async ({ page }) => {
    await login(page, FOUNDER_EMAIL);
    await page.locator('[data-qnew]').click();

    const assign = page.locator('#assignSel');
    await expect(assign).toBeEnabled({ timeout: 10000 }); // enabled once the shell row lands
    await expect(page.locator('#ch-savestate')).toContainText('Not priced yet');

    // Reassign to someone else purely through the picker — no Save is ever pressed.
    const others = assign.locator('option:not([value=""])');
    await expect(others.first()).toBeAttached();
    const target = await others.last().getAttribute('value');
    await assign.selectOption(target);
    await expect(assign).toHaveValue(target);
  });

  test('the queue marks the shell as not priced', async ({ page }) => {
    await login(page, FOUNDER_EMAIL);
    await page.locator('[data-qnew]').click();
    await expect(page.locator('#assignSel')).toBeEnabled({ timeout: 10000 });

    await page.goto(OPS); // back to the queue
    await expect(page.locator('.qrow .qtotal-unpriced').first()).toHaveText('Not priced yet');
  });

  test('submitting a shell is blocked and names the price', async ({ page }) => {
    await login(page, FOUNDER_EMAIL);
    await page.locator('[data-qnew]').click();
    await expect(page.locator('#assignSel')).toBeEnabled({ timeout: 10000 });

    await page.locator('[data-action="submitForReview"]').click();
    await expect(page.locator('.ch-blockers')).toContainText('has not been priced yet');
  });
});
