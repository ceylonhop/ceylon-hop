import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

/*
  goBook() disables the hero CTA and swaps in a spinner immediately before assigning
  location.href. The browser then stores that live DOM in the back/forward cache, so pressing
  Back replays it verbatim — no script re-runs, and nothing ever puts the button back. The
  traveller returns to a homepage whose primary CTA is greyed out and still spinning
  "Opening your trip…", with no way to search again short of a manual reload.

  WHAT THIS SPEC DOES NOT DO: it does not perform a real bfcache restore. Playwright keeps a
  CDP client attached to every page, and an attached debugger makes a document ineligible for
  the back/forward cache — so page.goBack() here always re-executes the document, and a
  re-executed page runs update() on load and looks healthy. Both `ignoreDefaultArgs:
  ['--disable-back-forward-cache']` and a stamp probe (window flag set before navigating,
  checked after Back) were tried; the stamp never survives, confirming re-execution.

  So these tests assert the CONTRACT instead: put the button into the exact state goBook()
  leaves it in, fire the pageshow event a restore would fire, and require the page to recover.
  That is precisely the handler the fix adds, and it fails against the unfixed code. The bug
  itself — that a restored DOM is never repaired — is only reproducible in a real browser.
*/

async function openHero(page, { multi = false } = {}) {
  await blockLiveApi(page);
  await page.goto('/index.html');
  if (multi) await page.locator('#tab-multi').click();
  await page.locator('#q-from').fill('Colombo Airport (CMB)');
  await page.locator('#q-to').fill('Ella');
  if (multi) await page.locator('#mid-stops .mid-stop input').last().fill('Kandy');
}

// Freeze the CTA the way goBook() does, then hand the page back as a bfcache restore would.
async function restoreFromBfcache(page, spinnerLabel) {
  await page.evaluate((label) => {
    const btn = document.getElementById('go-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> ' + label;
  }, spinnerLabel);

  // sanity: the frozen state really is on screen before we test the recovery
  const go = page.locator('#go-btn');
  await expect(go).toBeDisabled();
  await expect(go.locator('.spin')).toHaveCount(1);

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
}

test('a restored homepage repairs its frozen CTA', async ({ page }) => {
  await openHero(page);
  await restoreFromBfcache(page, 'Finding your prices…');

  const go = page.locator('#go-btn');
  await expect(go).toBeEnabled();
  await expect(go).toHaveText('See prices & book');
  // the spinner element itself must be gone, not merely hidden behind new text
  await expect(go.locator('.spin')).toHaveCount(0);
});

test('a restored multi-stop form comes back as the planner CTA, not the single-leg one', async ({ page }) => {
  await openHero(page, { multi: true });
  await restoreFromBfcache(page, 'Opening your trip…');

  const go = page.locator('#go-btn');
  await expect(go).toBeEnabled();
  await expect(go).toHaveText('Plan this trip');
  await expect(go.locator('.spin')).toHaveCount(0);
});
