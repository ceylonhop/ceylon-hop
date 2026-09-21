import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

// plan.html pings the live API on load (0e0f077) — keep the suite offline.
test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

// A press on a leg's button is mousedown → BLUR of the field being edited → mouseup → click.
// When that field's text has moved, the blur fires its 'change', whose handler render()s the
// whole rail — replacing the pressed button between mousedown and click, so the click never
// lands and the button reads as dead. Seen live 2026-09-20 on the ↕ swap arrow.
//
// These must be REAL mouse presses: dispatchEvent('click') skips the blur entirely and passes
// against the broken code.

async function openPlanner(page) {
  // Minimal Google Maps stub so plan.js's map/places wiring initialises offline.
  await page.addInitScript(() => {
    const places = {
      AutocompleteSessionToken: function () {},
      AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) },
    };
    const Route = {
      computeRoutes: async () => ({ routes: [{ legs: [{ distanceMeters: 100000, durationMillis: 5400000 }] }] }),
    };
    window.google = {
      maps: { importLibrary: async (n) => ({ routes: { Route }, places }[n] || {}), event: { trigger() {} } },
    };
  });
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=' + encodeURIComponent('Colombo|Kandy|Ella') + '&pax=2&vehicle=car');
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);
}

// The arrow straddles the divider between the two fields. Both fields are position:relative
// and the drop-off one comes later in the DOM, so it painted over the arrow's lower half: a
// press there hit the field — or its <label>, which focuses the drop-off input instead.
test('the whole swap arrow is pressable, including the half over the drop-off field', async ({ page }) => {
  await openPlanner(page);
  const leg = page.locator('#rail .leg-card').first();

  for (const y of [6, 24]) {
    const hit = await leg.locator('.rb-swap').evaluate((b, dy) => {
      const r = b.getBoundingClientRect();
      return b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + dy));
    }, y);
    expect(hit, `press at y=${y} of the 30px arrow reaches the button`).toBe(true);
  }

  await leg.locator('.rb-swap').click({ position: { x: 15, y: 24 } });
  const swapped = page.locator('#rail .leg-card').first();
  await expect(swapped.locator('.leg-from')).toHaveValue('Kandy');
  await expect(swapped.locator('.leg-to')).toHaveValue('Colombo');
});

test('the swap arrow works when pressed straight after editing a field', async ({ page }) => {
  await openPlanner(page);
  const leg = page.locator('#rail .leg-card').first();

  // Retype the drop-off and do NOT pick from the menu — the edit is still uncommitted when
  // the arrow is pressed, so the press itself is what blurs the field.
  await leg.locator('.leg-to').fill('Galle');
  await leg.locator('.rb-swap').click();

  const swapped = page.locator('#rail .leg-card').first();
  await expect(swapped.locator('.leg-from')).toHaveValue('Galle');
  await expect(swapped.locator('.leg-to')).toHaveValue('Colombo');
});

test('the remove button works when pressed straight after editing a field', async ({ page }) => {
  await openPlanner(page);
  const leg = page.locator('#rail .leg-card').first();

  await leg.locator('.leg-to').fill('Galle');
  await leg.locator('.leg-rm').click();

  await expect(page.locator('#rail .leg-card')).toHaveCount(1);
});

// The edit's re-render is only HELD for the press, never dropped: a press that is dragged off
// the button never clicks, so nothing else would repaint the rail from the committed edit.
test('an edit still re-renders when the press is dragged off the button', async ({ page }) => {
  await openPlanner(page);
  const leg = page.locator('#rail .leg-card').first();

  await leg.locator('.leg-to').fill('Galle');
  // render() writes state into the value ATTRIBUTE; typing only moves the property.
  await expect(leg.locator('.leg-to')).toHaveAttribute('value', 'Kandy');

  // hover() scrolls the arrow into view and proves the pointer is really over it — raw
  // boundingBox coordinates landed on <html> and the test passed against broken code.
  await leg.locator('.rb-swap').hover({ position: { x: 15, y: 6 } });
  await page.mouse.down();
  await leg.locator('.leg-head').hover();
  await page.mouse.up();

  const after = page.locator('#rail .leg-card').first();
  await expect(after.locator('.leg-to')).toHaveAttribute('value', 'Galle');
  await expect(after.locator('.leg-from')).toHaveValue('Colombo'); // and it did NOT swap
});
