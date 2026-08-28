import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

// Friend-reported 2026-08-27 (screenshot): "when trying to select text it moves the card".
//
// The whole .leg-card carried draggable="true", even though the card renders a ⠿ handle whose
// only job is to start a reorder. In Chrome a draggable ANCESTOR beats text selection inside a
// descendant <input>, so dragging across the pick-up field you had just typed into picked the
// card up instead of selecting the word — and dropped it somewhere else in the itinerary.
// Proven, before the fix, by flipping only that one attribute in the live page: the identical
// mouse sweep selected 0 characters with draggable="true" and 20 with it off.
//
// Note on the second test: Chromium does not raise native HTML5 drag events for synthetic input
// (neither a hand-rolled mouse sweep nor locator.dragTo() fires a single dragstart here), so the
// reorder itself cannot be driven by the mouse in this harness. What it CAN pin is the part the
// fix actually changed — whether the gesture arms the card — plus the reorder wiring, driven by
// dispatching the drag events the browser would have sent.

const STOPS = 'Colombo Airport (CMB)|Sigiriya|Kandy'; // Leg 1: CMB→Sigiriya, Leg 2: Sigiriya→Kandy

test.beforeEach(async ({ page }) => {
  await blockLiveApi(page);
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
});

const legOrder = (page) => page.$$eval('#rail .leg .leg-from', (els) => els.map((e) => e.value));

async function openPlanner(page) {
  await page.goto(`/plan.html?stops=${encodeURIComponent(STOPS)}&pax=2`);
  await expect(page.locator('#rail .leg')).toHaveCount(2);
}

test('dragging across a leg field selects its text instead of picking the card up', async ({ page }) => {
  await openPlanner(page);

  const before = await legOrder(page);
  const input = page.locator('.leg[data-i="0"] .leg-from');
  const box = await input.boundingBox();

  // A real drag-select: press inside the text, sweep right, release.
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();

  // Text got selected...
  const selected = await input.evaluate((el) => el.selectionEnd - el.selectionStart);
  expect(selected).toBeGreaterThan(0);

  // ...the card never armed itself for a drag...
  await expect(page.locator('.leg[data-i="0"] .leg-card')).toHaveJSProperty('draggable', false);

  // ...and the itinerary did not reorder itself underneath the customer.
  expect(await legOrder(page)).toEqual(before);
});

test('pressing the handle still arms the card, and the drag still reorders', async ({ page }) => {
  await openPlanner(page);

  const before = await legOrder(page);
  const card = page.locator('#rail .leg').first().locator('.leg-card');
  const handle = card.locator('.drag');

  // Press the handle: this is the gesture that means "move this card".
  const h = await handle.boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await expect(card).toHaveJSProperty('draggable', true);
  await page.mouse.up();

  // Drive the reorder with the drag events Chromium will not synthesise for us, so the
  // dragstart → ondragover → dragend → commitOrder() path is still exercised end to end.
  await page.evaluate(() => {
    const rail = document.getElementById('rail');
    const first = rail.querySelector('.leg .leg-card');
    const second = rail.querySelectorAll('.leg')[1];
    const dt = new DataTransfer();
    first.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const b = second.getBoundingClientRect();
    rail.dispatchEvent(new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer: dt, clientY: b.bottom - 2,
    }));
    first.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  });

  const after = await legOrder(page);
  expect(after).not.toEqual(before);                          // the order really moved
  expect([...after].sort()).toEqual([...before].sort());      // and nothing was lost
  await expect(card).toHaveJSProperty('draggable', false);    // disarmed again after the drop
});
