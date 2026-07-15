import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

test('search prices on real distance and carries that price into booking', async ({ page }) => {
  // reuse the stub harness (installs Maps/PayHere stubs + API mocks for the booking nav)
  await gotoBooking(page, { path: '/search.html', query: 'from=cmb-airport&to=ella&pax=2' });

  // CMB -> Ella private car on real distance (335km):
  // Core fare is $141 after the clamped per-leg buffer; final-price finishing gives $139.
  const selectLink = page.locator('a[href*="price=139"][href*="rawPrice=141"][href*="vehicle=car"]').first();
  await expect(selectLink).toBeVisible();
  await expect(page.getByText('$139').first()).toBeVisible();

  await selectLink.click();
  await page.waitForURL('**/booking.html**');
  // booking holds the quoted price on load
  await expect(page.locator('#sum-total')).toHaveText('$139');
});

test('search choices stay locked until Edit, then Update applies (Kayak/Expedia pattern)', async ({ page }) => {
  await gotoBooking(page, { path: '/search.html', query: 'from=cmb-airport&to=ella&pax=2' });

  // Locked by default: the edit form is collapsed, a read-only summary is shown.
  await expect(page.locator('#srch-bar')).toBeHidden();
  await expect(page.locator('#srch-locked')).toBeVisible();
  await expect(page.locator('#sl-route')).not.toBeEmpty();
  await expect(page.locator('#sl-meta')).toContainText('2 travelers');

  // Click Edit → the form reveals, pre-filled with the current search.
  await page.locator('#sl-edit').click();
  await expect(page.locator('#srch-bar')).toBeVisible();
  await expect(page.locator('#srch-locked')).toBeHidden();
  await expect(page.locator('#e-from')).toHaveValue('Colombo Airport (CMB)');
  await expect(page.locator('#e-to')).toHaveValue('Ella');
  await expect(page.locator('#e-pax')).toHaveValue('2');

  // Cancel collapses back to the locked summary without changing anything.
  await page.locator('#sl-cancel').click();
  await expect(page.locator('#srch-bar')).toBeHidden();
  await expect(page.locator('#srch-locked')).toBeVisible();

  // Edit again, change the drop-off, and Update → a deliberate new search navigation.
  await page.locator('#sl-edit').click();
  await page.locator('#e-to').fill('Kand');
  await expect(page.locator('.place-option', { hasText: 'Kandy' }).first()).toBeVisible();
  await page.locator('.place-option', { hasText: 'Kandy' }).first().click();
  await page.locator('#srch-bar button[type="submit"]').click();
  await page.waitForURL('**/search.html?**to=kandy**');
  // The new search loads locked again.
  await expect(page.locator('#srch-bar')).toBeHidden();
  await expect(page.locator('#srch-locked')).toBeVisible();
});

test('search edit bar shows Google suggestions for non-local places without covering Cancel', async ({ page }) => {
  await gotoBooking(page, { path: '/search.html', query: 'from=cmb-airport&to=trincomalee&pax=1' });

  await page.locator('#sl-edit').click();
  await page.locator('#e-to').fill('madampalla');

  const googleOption = page.locator('.place-option', { hasText: 'madampalla Result 1' }).first();
  await expect(googleOption).toBeVisible();
  await expect(googleOption).toContainText('Google');

  await page.locator('#sl-cancel').click();
  await expect(page.locator('#srch-bar')).toBeHidden();
  await expect(page.locator('#srch-locked')).toBeVisible();
});

test('search edit bar sends 6-plus traveler groups to WhatsApp for a custom quote', async ({ page }) => {
  await page.route('https://wa.me/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>WhatsApp</title>' }));
  await gotoBooking(page, { path: '/search.html', query: 'from=cmb-airport&to=trincomalee&pax=1' });

  await page.locator('#sl-edit').click();
  await page.locator('#e-pax').selectOption('6');
  await page.locator('#srch-bar button[type="submit"]').click();

  await page.waitForURL('https://wa.me/94779669662?text=*');
  const url = new URL(page.url());
  const text = decodeURIComponent(url.searchParams.get('text') || '');
  expect(text).toContain('group transfer quote');
  expect(text).toContain('Route: Colombo Airport (CMB) to Trincomalee');
  expect(text).toContain('Travelers: 6+');
});

test('mobile search result avoids repeating the route hero above prices', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoBooking(page, { path: '/search.html', query: 'from=cmb-airport&to=sigiriya&pax=1' });

  await expect(page.locator('#srch-locked')).toBeVisible();
  await expect(page.locator('#sl-route')).toContainText('Colombo Airport (CMB)');
  await expect(page.locator('#sl-route')).toContainText('Sigiriya / Dambulla');
  await expect(page.locator('#sl-meta')).toContainText('~152 km');
  await expect(page.locator('#sl-meta')).toContainText('approx');
  await expect(page.locator('#route-title')).toBeHidden();
  await expect(page.locator('#route-meta')).toBeHidden();
  await expect(page.locator('#add-stops')).toBeVisible();
  await expect(page.locator('.opt-private')).toBeVisible();

  const summaryBox = await page.locator('#srch-locked').boundingBox();
  const privateBox = await page.locator('.opt-private').boundingBox();
  expect(summaryBox).not.toBeNull();
  expect(privateBox).not.toBeNull();
  expect(privateBox.y).toBeLessThan(620);
});

test('home search uses popular route autocomplete and sends unknown places to planner', async ({ page }) => {
  await gotoBooking(page, { path: '/index.html', query: '' });

  await page.locator('#q-from').fill('CMB');
  await expect(page.locator('.place-option').first()).toContainText('Colombo Airport (CMB)');
  await expect(page.locator('.place-option').first()).toContainText('Popular Route');
  await page.locator('.place-option', { hasText: 'Colombo Airport (CMB)' }).first().click();

  await page.locator('#q-to').fill('Ella');
  await page.locator('.place-option', { hasText: 'Ella' }).first().click();
  await page.locator('#go-btn').click();
  await page.waitForURL('**/search.html?**from=cmb-airport**to=ella**');

  await page.goto('/index.html');
  await page.locator('#q-from').fill('Hilton Colombo');
  await expect(page.locator('.place-option', { hasText: 'Use exact place' })).toHaveCount(0);
  await page.locator('#q-to').fill('Ella');
  await page.locator('.place-option', { hasText: 'Ella' }).first().click();
  await page.locator('#go-btn').click();
  await page.waitForURL('**/plan.html?**stops=Hilton+Colombo%7CElla**');
});

test('home autocomplete ignores delayed Google results after a local place is selected', async ({ page }) => {
  await gotoBooking(page, { path: '/index.html', query: '', googleDelay: 550 });

  await page.locator('#q-to').fill('Kitulgala');
  await expect(page.locator('.place-option', { hasText: 'Searching Google' })).toBeVisible();
  await page.locator('.place-option', { hasText: 'Kitulgala' }).first().click();

  await expect(page.locator('#q-to')).toHaveValue('Kitulgala');
  await expect(page.locator('.place-menu')).toHaveCount(0);
  await page.waitForTimeout(700);
  await expect(page.locator('#q-to')).toHaveValue('Kitulgala');
  await expect(page.locator('.place-menu')).toHaveCount(0);
});

test('mobile home search keeps unselected booking tabs readable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoBooking(page, { path: '/index.html', query: '' });

  const inactiveTab = page.locator('#tab-multi');
  await expect(inactiveTab).toHaveAttribute('aria-selected', 'false');
  await expect(inactiveTab).toHaveCSS('color', 'rgb(44, 42, 43)');

  await inactiveTab.click();
  await expect(page.locator('#tab-single')).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('#tab-single')).toHaveCSS('color', 'rgb(44, 42, 43)');
});

test('home multi-stop toggle does not open autocomplete until the user types', async ({ page }) => {
  await gotoBooking(page, { path: '/index.html', query: '' });

  await page.locator('#tab-multi').click();
  await expect(page.locator('.mid-stop input')).toBeFocused();
  await expect(page.locator('.place-menu')).toHaveCount(0);

  await page.locator('.mid-stop input').fill('Colombo');
  await expect(page.locator('.place-menu')).toBeVisible();
  await expect(page.locator('.place-option').first()).toContainText('Colombo');
});

test('home autocomplete closes on scroll instead of floating detached', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoBooking(page, { path: '/index.html', query: '' });

  await page.locator('#q-to').fill('Ki');
  await expect(page.locator('.place-menu')).toBeVisible();

  await page.mouse.wheel(0, 420);
  await expect(page.locator('.place-menu')).toHaveCount(0);
});

test('home autocomplete is not clipped behind the trust bar', async ({ page }) => {
  await gotoBooking(page, { path: '/index.html', query: '' });
  await page.setViewportSize({ width: 1424, height: 768 });

  await page.locator('#q-to').fill('Kalpitiya');

  const menu = page.locator('.place-menu').first();
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  const trustTop = await page.locator('.trust-row').evaluate((el) => el.getBoundingClientRect().top);

  expect(box.y + box.height).toBeLessThanOrEqual(768);
  expect(box.y + box.height).toBeLessThan(trustTop);
});

test('a route with no shared service shows the "no shared seats" panel in the grid, beside the private card', async ({ page }) => {
  // Weligama -> Sigiriya has no daily shared corridor, so the shared slot shows the fallback panel.
  await gotoBooking(page, { path: '/search.html', query: 'from=weligama&to=sigiriya&pax=1' });

  await expect(page.getByText('No shared seats on this route')).toBeVisible();
  // It occupies the shared card's slot — a child of the two-up results grid, not a full-width block below it.
  await expect(page.locator('.opt-grid .noshare')).toBeVisible();
  // and the grid keeps its normal two-column layout (no single-column 'solo' fallback)
  await expect(page.locator('.opt-grid.solo')).toHaveCount(0);
});
