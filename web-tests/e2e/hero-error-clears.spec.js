import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

/*
  goBook() paints "Where are you heading? Pick a drop-off." (and a red border) when the
  traveller presses the CTA with an empty field. That message was only ever cleared at the
  TOP of the next goBook() call — nothing watched the fields — so a traveller who then picked
  a drop-off kept looking at an error telling them to pick a drop-off, with the field they had
  just filled still outlined red, until they pressed the button a second time.

  The hero's update() already runs on every keystroke, on every autocomplete pick (choose()
  dispatches `change`) and on swap; it is the one place that sees the traveller act on the
  form, so that is where the stale complaint must go away.
*/

async function provokeDropOffError(page) {
  await blockLiveApi(page);
  await page.goto('/index.html');
  await page.locator('#q-from').fill('Sigiriya / Dambulla');
  await page.locator('#go-btn').click();
  const err = page.locator('#bk-error');
  await expect(err).toBeVisible();
  await expect(err).toContainText('Pick a drop-off');
  await expect(page.locator('.dropoff-field')).toHaveClass(/field-bad/);
  return err;
}

test('picking a drop-off from the menu clears the "pick a drop-off" error', async ({ page }) => {
  const err = await provokeDropOffError(page);

  const to = page.locator('#q-to');
  await to.pressSequentially('Colombo Air');
  await page.locator('.place-menu .place-option', { hasText: 'Colombo Airport' }).first().click();
  await expect(to).toHaveValue(/Colombo Airport/);

  await expect(err).toBeHidden();
  await expect(page.locator('.dropoff-field')).not.toHaveClass(/field-bad/);
});

test('typing a drop-off clears the error too', async ({ page }) => {
  const err = await provokeDropOffError(page);
  await page.locator('#q-to').fill('Ella');
  await expect(err).toBeHidden();
  await expect(page.locator('.dropoff-field')).not.toHaveClass(/field-bad/);
});

test('the error still appears on submit and the next submit re-validates', async ({ page }) => {
  await provokeDropOffError(page);
  // the traveller clears the pick-up instead: the first message goes, the next press names the new fault
  await page.locator('#q-from').fill('');
  await expect(page.locator('#bk-error')).toBeHidden();
  await page.locator('#go-btn').click();
  await expect(page.locator('#bk-error')).toContainText('picking you up');
  await expect(page.locator('.pickup-field')).toHaveClass(/field-bad/);
});
