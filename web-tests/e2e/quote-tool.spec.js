import { test, expect } from '@playwright/test';

// The internal quoting tool is served by the API (not the static site).
const TOOL = 'http://localhost:8787/admin/quote';

// Spec 1: Timeline autocomplete → auto-distance → priced summary → save
test('timeline autocomplete → priced LKR summary → save reference toast', async ({ page }) => {
  await page.goto(TOOL);
  // Wait for the page to fully initialise (rate card fetch + render complete)
  await page.waitForLoadState('networkidle');

  // Fill first leg: "From" field (first .ch-tl-title with data-field="pickupLocation")
  // Use click + keyboard.type() so individual key events fire the input listener
  const fromInput = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  await fromInput.click();
  await page.keyboard.type('Kand', { delay: 40 });
  // Wait for autocomplete menu to appear (220ms debounce + network)
  await expect(page.locator('.ch-ac-menu').first()).toBeVisible({ timeout: 5000 });
  // Click the Kandy item — pick binds on mousedown
  await page.locator('.ch-ac-menu .ch-ac-item', { hasText: 'Kandy' }).first().click();

  // Fill second leg: "Destination" field (first .ch-tl-title with data-field="dropoffLocation")
  const toInput = page.locator('.ch-tl-title[data-field="dropoffLocation"]').first();
  await toInput.click();
  await page.keyboard.type('Ella', { delay: 40 });
  await expect(page.locator('.ch-ac-menu').first()).toBeVisible({ timeout: 5000 });
  await page.locator('.ch-ac-menu .ch-ac-item', { hasText: 'Ella' }).first().click();

  // Wait for auto-distance to resolve and estimate to populate
  // The km hero tile and the quote total line should appear
  await expect(page.locator('.ch-km.hero')).toBeVisible({ timeout: 8000 });
  const heroText = await page.locator('.ch-km.hero b').textContent();
  expect(heroText).not.toBe('0');

  // Quote total (strong line) should contain LKR
  await expect(page.locator('.ch-line.strong .ch-line-val').first()).toContainText('LKR', { timeout: 8000 });

  // Fill customer name and explicitly blur so the change→render cycle completes
  // before clicking Save (avoids stale-element races with the render cycle)
  const nameInput = page.locator('#f-customerName');
  await nameInput.fill('E2E Port');
  await nameInput.press('Tab'); // commit the change + triggers re-render
  await page.waitForTimeout(200); // let render() settle

  // Click header Save button
  await page.locator('#btnSave').click();

  // Toast should appear containing the reference (starts with Q-)
  // Wait for the .ch-toast-msg to be populated with a Q- reference
  const toastMsg = page.locator('.ch-toast-msg');
  await expect(toastMsg).toContainText('Q-', { timeout: 8000 });
});

// Spec 2: Car + 4 bags triggers the luggage flag
test('car + 4 bags raises the luggage flag', async ({ page }) => {
  await page.goto(TOOL);
  await page.waitForLoadState('networkidle');

  // Select Car in the vehicle dropdown
  const vehicleSel = page.locator('#f-vehicleType');
  await vehicleSel.selectOption('car');

  // Set bags to 4
  const bagsInput = page.locator('#f-luggageCount');
  await bagsInput.fill('4');
  await bagsInput.dispatchEvent('change');

  // A flag with "luggage" (case-insensitive) should be visible
  await expect(
    page.locator('.ch-flag', { hasText: /luggage/i }).first()
  ).toBeVisible({ timeout: 5000 });
});
