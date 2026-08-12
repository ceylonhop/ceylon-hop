import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// Resolve a design token to the rgb() string the browser reports, so these assertions
// track site.css instead of a frozen hex. They pinned rgb(44,42,43) — the pre-brand-book
// ink — and broke when --ink moved to the book's Bristol Black. The INTENT is "unselected
// options use the full ink, not a muted grey", which is a token relationship, not a hex.
const tokenColor = (page, name) => page.evaluate((n) => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const probe = document.createElement('div');
  probe.style.color = raw;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  return rgb;
}, name);

test('search prices on real distance and carries that price into booking', async ({ page }) => {
  // reuse the stub harness (installs Maps/PayHere stubs + API mocks for the booking nav)
  await gotoBooking(page, { path: '/search.html', query: 'from=cmb-airport&to=ella&pax=2' });

  // CMB -> Ella private car on real distance (335km):
  // Exact core fare is $140.88 after the clamped per-leg buffer; finishing gives $139.
  const selectLink = page.locator('a[href*="price=139"][href*="rawPrice=140.88"][href*="vehicle=car"]').first();
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
  await expect(page.locator('#sl-meta')).toContainText('2 travellers');

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
  expect(text).toContain('Travellers: 6+');
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

  const ink = await tokenColor(page, '--ink');
  const inactiveTab = page.locator('#tab-multi');
  await expect(inactiveTab).toHaveAttribute('aria-selected', 'false');
  await expect(inactiveTab).toHaveCSS('color', ink);

  await inactiveTab.click();
  await expect(page.locator('#tab-single')).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('#tab-single')).toHaveCSS('color', ink);
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

/* The results page compares a PER-SEAT price against a PER-VEHICLE one, so the party size is
   the only thing that decides which is actually cheaper. The homepage never asks for it
   (the hero is deliberately one question: from + to), and nothing links here with `pax` —
   so the page used to default it to 1 and then state a saving computed from that guess.
   For Kandy -> Ella that printed "Save ~64%", true for a solo traveller and nobody else:
   two people save ~29%, and three are $4 better off in the private car. It also announced
   "Seats for 1 traveller" as though the customer had said so.
   Unset now means unset — mirroring the planner's own traveller gate (plan.js). */
test('an unasked party size is not invented: no count, no savings claim, no pax handed on', async ({ page }) => {
  // exactly what the homepage produces — from + to, nothing else
  await gotoBooking(page, { path: '/search.html', query: 'from=kandy&to=ella' });

  // the shared card is present (Kandy -> Ella runs a corridor), but claims nothing about savings
  await expect(page.locator('.opt-shared')).toBeVisible();
  await expect(page.locator('.shared-save')).toHaveCount(0);
  await expect(page.getByText(/Save ~\d+%/)).toHaveCount(0);

  // no fabricated traveller count anywhere on the page
  await expect(page.getByText(/\b1 traveller\b/)).toHaveCount(0);

  // ...and the guess is not passed downstream to booking
  const hrefs = await page.locator('a[href*="booking.html"]').evaluateAll(
    (as) => as.map((a) => a.getAttribute('href')),
  );
  expect(hrefs.length).toBeGreaterThan(0);
  for (const h of hrefs) expect(h).not.toMatch(/[?&]pax=/);

  // the raw comparison the customer can make for themselves is untouched
  await expect(page.getByText('$21').first()).toBeVisible();       // per seat
  await expect(page.getByText('total, fixed').first()).toBeVisible(); // per vehicle
});

test('a party size the customer DID choose is still honoured end to end', async ({ page }) => {
  await gotoBooking(page, { path: '/search.html', query: 'from=kandy&to=ella&pax=2' });

  await expect(page.getByText('2 travellers').first()).toBeVisible();
  await expect(page.locator('.shared-save')).toBeVisible();
  await expect(page.locator('.shared-save')).toHaveText(/Save ~29%/);
  await expect(page.locator('a[href*="booking.html"][href*="pax=2"]').first()).toBeVisible();
});

/* Labels and placeholders have to agree about which field ends the journey. Adding a stop
   renames the drop-off field to "Stop 2", but its placeholder stayed "Where to?" — which
   reads as the last field — while the row that had actually become the drop-off invited
   "Where to next?". Filling the form top-to-bottom on the hint text alone put the
   destination in the middle. Whichever row is last says "Where to?" (the site's phrasing
   for a final stop, as used in single-transfer mode). */
test('multi-stop placeholders follow the labels: the LAST field is the one that ends the trip', async ({ page }) => {
  await gotoBooking(page, { path: '/index.html', query: '' });

  const qTo = page.locator('#q-to');
  const rows = page.locator('#mid-stops .mid-stop');
  const lastRow = rows.last();

  // single transfer: the drop-off is the last field and asks the terminal question
  await expect(page.locator('#q-to-label')).toHaveText('Drop-off');
  await expect(qTo).toHaveAttribute('placeholder', 'Where to?');

  // multi-stop seeds a row: q-to becomes an intermediate stop and must stop sounding final
  await page.locator('#tab-multi').click();
  await expect(page.locator('#q-to-label')).toHaveText('Stop 2');
  await expect(qTo).toHaveAttribute('placeholder', 'Where to next?');
  await expect(lastRow.locator('label')).toHaveText('Drop-off');
  await expect(lastRow.locator('input')).toHaveAttribute('placeholder', 'Where to?');

  // the terminal question travels to whichever row is last as stops are added...
  await page.locator('#add-stop').click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('input')).toHaveAttribute('placeholder', 'Add a place along the way…');
  await expect(lastRow.locator('label')).toHaveText('Drop-off');
  await expect(lastRow.locator('input')).toHaveAttribute('placeholder', 'Where to?');

  // ...and back again when one is removed
  await rows.first().locator('.rm').click();
  await expect(rows).toHaveCount(1);
  await expect(lastRow.locator('label')).toHaveText('Drop-off');
  await expect(lastRow.locator('input')).toHaveAttribute('placeholder', 'Where to?');

  // returning to a single transfer restores the terminal question to the drop-off
  await page.locator('#tab-single').click();
  await expect(page.locator('#q-to-label')).toHaveText('Drop-off');
  await expect(qTo).toHaveAttribute('placeholder', 'Where to?');
});
