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
  // Exact core fare is $140.88 after the clamped per-leg buffer; finishing drops the cents ($99.99
  // is far out of reach), giving $140.
  const selectLink = page.locator('a[href*="price=140"][href*="rawPrice=140.88"][href*="vehicle=car"]').first();
  await expect(selectLink).toBeVisible();
  await expect(page.getByText('$140').first()).toBeVisible();

  await selectLink.click();
  await page.waitForURL('**/booking.html**');
  // booking holds the quoted price on load
  await expect(page.locator('#sum-total')).toHaveText('$140');
});

test('search choices stay locked until Edit, then Update applies (Kayak/Expedia pattern)', async ({ page }) => {
  await gotoBooking(page, { path: '/search.html', query: 'from=cmb-airport&to=ella&pax=2' });

  // Collapsed by default: the edit form is hidden behind the button, and the route hero
  // states the search once.
  await expect(page.locator('#srch-bar')).toBeHidden();
  await expect(page.locator('#sl-edit')).toBeVisible();
  await expect(page.locator('#route-title')).not.toBeEmpty();
  await expect(page.locator('#route-meta')).toContainText('2 travellers');

  // Click Edit → the form reveals, pre-filled with the current search. The hero STAYS —
  // it is the page header now, not a summary the form replaces.
  await page.locator('#sl-edit').click();
  await expect(page.locator('#srch-bar')).toBeVisible();
  await expect(page.locator('#sl-edit')).toBeHidden();
  await expect(page.locator('#route-title')).toBeVisible();
  await expect(page.locator('#e-from')).toHaveValue('Colombo Airport (CMB)');
  await expect(page.locator('#e-to')).toHaveValue('Ella');
  await expect(page.locator('#e-pax')).toHaveValue('2');

  // Cancel collapses the form again without changing anything.
  await page.locator('#sl-cancel').click();
  await expect(page.locator('#srch-bar')).toBeHidden();
  await expect(page.locator('#sl-edit')).toBeVisible();

  // Edit again, change the drop-off, and Update → a deliberate new search navigation.
  await page.locator('#sl-edit').click();
  await page.locator('#e-to').fill('Kand');
  await expect(page.locator('.place-option', { hasText: 'Kandy' }).first()).toBeVisible();
  await page.locator('.place-option', { hasText: 'Kandy' }).first().click();
  await page.locator('#srch-bar button[type="submit"]').click();
  await page.waitForURL('**/search.html?**to=kandy**');
  // The new search loads collapsed again.
  await expect(page.locator('#srch-bar')).toBeHidden();
  await expect(page.locator('#sl-edit')).toBeVisible();
});

test('search states the route once — no locked summary bar, no route breadcrumb', async ({ page }) => {
  await gotoBooking(page, { path: '/search.html', query: 'from=cmb-airport&to=sigiriya&pax=2' });

  // The h1 is the only place "A → B" is spelled out. It used to appear three times: in the
  // breadcrumb trail, in a read-only .srch-locked bar, and here.
  await expect(page.locator('#srch-locked')).toHaveCount(0);
  await expect(page.locator('#route-title')).toContainText('Colombo Airport (CMB)');
  await expect(page.locator('#route-title')).toContainText('Sigiriya / Dambulla');
  await expect(page.locator('.breadcrumbs')).not.toContainText('Sigiriya');

  // Edit search opens the form inside the same route hero the button sits in. The button now
  // rides the h1 line (hard right) rather than a row of its own under the meta, so the form
  // lands a little further below it than it used to — but still within the hero, never the
  // screen-away placement of the old .srch-top strip.
  const btnBox = await page.locator('#sl-edit').boundingBox();
  await page.locator('#sl-edit').click();
  const formBox = await page.locator('#srch-bar').boundingBox();
  expect(formBox.y).toBeGreaterThan(btnBox.y - 8);
  expect(formBox.y - btnBox.y).toBeLessThan(260);
});

test('the search page has no "start a new search" strip above the route', async ({ page }) => {
  await gotoBooking(page, { path: '/search.html', query: 'from=cmb-airport&to=ella&pax=1' });

  // The strip was a full-width white band holding one back link. The nav logo already goes
  // home, so it bought nothing and pushed the route — the reason the page exists — down.
  await expect(page.locator('.srch-top')).toHaveCount(0);
  await expect(page.getByText('Start a new search')).toHaveCount(0);
});

test('Edit search sits on the route title line, at the right edge', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoBooking(page, { path: '/search.html', query: 'from=cmb-airport&to=ella&pax=1' });

  const title = await page.locator('#route-title').boundingBox();
  const edit = await page.locator('#sl-edit').boundingBox();
  const meta = await page.locator('#route-meta').boundingBox();

  // same line as the title: their vertical spans overlap...
  expect(edit.y).toBeLessThan(title.y + title.height);
  expect(edit.y + edit.height).toBeGreaterThan(title.y);
  // ...and above the meta row it used to sit under
  expect(edit.y).toBeLessThan(meta.y);
  // hard right: past the horizontal midpoint of the title's own row
  expect(edit.x).toBeGreaterThan(title.x + title.width / 2);
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
  await expect(page.locator('#sl-edit')).toBeVisible();
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

test('mobile search states the route once and still puts prices above the fold', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoBooking(page, { path: '/search.html', query: 'from=cmb-airport&to=sigiriya&pax=1' });

  // Mobile used to hide this h1 and show a .srch-locked bar instead — the same "don't say it
  // twice" rule, solved in the opposite direction from desktop. Both keep the h1 now, which
  // means the hero has to stay small enough for the prices to clear the fold.
  await expect(page.locator('#route-title')).toContainText('Colombo Airport (CMB)');
  await expect(page.locator('#route-title')).toContainText('Sigiriya / Dambulla');
  await expect(page.locator('#route-meta')).toContainText('Approx. 150 km');
  await expect(page.locator('#route-meta')).toContainText('Approx. 150 km · 3h 15m');
  await expect(page.locator('#add-stops')).toBeVisible();
  await expect(page.locator('#sl-edit')).toBeVisible();
  await expect(page.locator('.opt-private')).toBeVisible();

  const heroBox = await page.locator('#route-title').boundingBox();
  const privateBox = await page.locator('.opt-private').boundingBox();
  expect(heroBox).not.toBeNull();
  expect(privateBox).not.toBeNull();
  expect(privateBox.y).toBeLessThan(620);
});

/*
  The autocomplete option row is a two-column grid whose badge column is `auto` + nowrap, so
  the BADGE decided how much room the place name got — and it won. "Popular Route" measured
  102px; add the menu/option padding and the gap and 156px of a row was spoken for before the
  name saw any of it. On the homepage hero, the widest field on the site, that left 179px for
  a name needing 187 and shipped "Colombo Airport (C…" — the busiest origin we sell, clipped
  in the primary search box. In the search page's 4-up edit grid the field is 225px and 13 of
  19 place names clipped.

  Pinned by MEASUREMENT, not by the rendered string: `textContent` is the full name whether or
  not the pixels fit, so no text assertion can see this. scrollWidth > clientWidth can.
*/
const clippedOptions = (page) => page.evaluate(() => {
  const menu = document.querySelector('.place-menu');
  if (!menu) return null;
  return [...menu.querySelectorAll('.place-option:not(.loading)')]
    .map((opt) => {
      const label = opt.querySelector('span');
      const badge = opt.querySelector('small');
      return {
        text: label.textContent,
        badge: badge ? badge.textContent : '',
        room: Math.ceil(label.getBoundingClientRect().width),
        needs: label.scrollWidth,
      };
    })
    .filter((o) => o.needs > o.room);
});

for (const spot of [
  { name: 'homepage hero', path: '/index.html', field: '#q-from', open: null },
  { name: 'search page edit form', path: '/search.html?from=cmb-airport&to=ella', field: '#e-from', open: '#sl-edit' },
]) {
  test(`local place names are not clipped by their own badge — ${spot.name}`, async ({ page }) => {
    await gotoBooking(page, { path: spot.path.split('?')[0], query: spot.path.split('?')[1] || '' });
    if (spot.open) await page.locator(spot.open).click();

    // "Colombo Airport (CMB)" is the longest place name we ship and the most-booked origin.
    await page.locator(spot.field).fill('Colombo Air');
    await expect(page.locator('.place-option', { hasText: 'Colombo Airport (CMB)' }).first()).toBeVisible();

    const clipped = await clippedOptions(page);
    // Google results are free-text addresses and are expected to ellipsize; local places are not.
    const clippedLocal = clipped.filter((o) => o.badge !== 'Google');
    expect(clippedLocal, `clipped local place names: ${JSON.stringify(clippedLocal)}`).toEqual([]);
  });
}

test('home search uses popular route autocomplete and keeps unknown places on the search page', async ({ page }) => {
  await gotoBooking(page, { path: '/index.html', query: '' });

  await page.locator('#q-from').fill('CMB');
  await expect(page.locator('.place-option').first()).toContainText('Colombo Airport (CMB)');
  await expect(page.locator('.place-option').first()).toContainText('Popular');
  await page.locator('.place-option', { hasText: 'Colombo Airport (CMB)' }).first().click();

  await page.locator('#q-to').fill('Ella');
  await page.locator('.place-option', { hasText: 'Ella' }).first().click();
  await page.locator('#go-btn').click();
  await page.waitForURL('**/search.html?**from=cmb-airport**to=ella**');

  // A place that isn't in the baked catalogue used to divert the WHOLE search to the itinerary
  // planner — so the same two points behaved differently depending on which places they were,
  // and someone who typed a real destination we don't have baked got a trip builder instead of
  // a price. A single leg is a single leg: it stays here, and search.js prices the unknown end
  // through the engine (web-tests/e2e/search-engine-price.spec.js covers the pricing itself).
  await page.goto('/index.html');
  await page.locator('#q-from').fill('Hilton Colombo');
  await expect(page.locator('.place-option', { hasText: 'Use exact place' })).toHaveCount(0);
  await page.locator('#q-to').fill('Ella');
  await page.locator('.place-option', { hasText: 'Ella' }).first().click();
  await page.locator('#go-btn').click();
  await page.waitForURL('**/search.html?**');
  const q = new URL(page.url()).searchParams;
  expect(q.get('from')).toBe('Hilton Colombo'); // unknown end travels as its name...
  expect(q.get('to')).toBe('ella');             // ...the known one still as its id
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
/* Kandy -> Ella was the fixture here because adjacency on the hill-line corridor gave it a
   shared card. It never was a product we sell, and the shared catalogue withdrew it — so
   these two moved to Negombo -> Sigiriya, a real catalogue leg ($27.49 a seat against a
   $65.50 private car). The point of both tests is the PARTY SIZE, not the route. */
test('an unasked party size is not invented: no count, no savings claim, no pax handed on', async ({ page }) => {
  // exactly what the homepage produces — from + to, nothing else
  await gotoBooking(page, { path: '/search.html', query: 'from=negombo&to=sigiriya' });

  // the shared card is present (we sell this leg), but claims nothing about savings
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
  await expect(page.getByText('$27.49').first()).toBeVisible();      // per seat
  await expect(page.getByText('total, fixed').first()).toBeVisible(); // per vehicle
});

test('a party size the customer DID choose is still honoured end to end', async ({ page }) => {
  await gotoBooking(page, { path: '/search.html', query: 'from=negombo&to=sigiriya&pax=2' });

  await expect(page.getByText('2 travellers').first()).toBeVisible();
  await expect(page.locator('.shared-save')).toBeVisible();
  // two sharing a $65.50 car pay $32.75 each against a $27.49 seat — ~16%
  await expect(page.locator('.shared-save')).toHaveText(/Save ~15%/);
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
