import { test, expect } from '@playwright/test';

// The booking form has a dial-code selector + a phone field, split into phoneCountryCode /
// phoneNumber / whatsapp in the payload (customers table + PayHere). Two real inputs used to
// corrupt it: (a) a "+"-prefixed international number kept the SELECTOR's code (so the split
// disagreed with whatsapp), and (b) a number typed WITH the country code but no "+" doubled it
// ("+44" + "447911…" → "+44447911…"). Both must produce a consistent, correct split.

async function bootBooking(page) {
  let captured = null;
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.route('**/*payhere.lk/**', (r) => r.abort());
  await page.route('https://api.test/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' }));
  await page.route('https://api.test/bookings/single', async (r) => {
    captured = JSON.parse(r.request().postData() || '{}');
    return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'p-e2e', reference: 'CH-PHONE', status: 'draft', mode: 'single', total: 12100, amountDueNow: 12100, currency: 'USD' }) });
  });
  await page.route('https://api.test/bookings/p-e2e/checkout', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ checkoutUrl: 'https://example.test/fake', fields: {} }) }));
  await page.goto('/booking.html?api=https://api.test&mode=private&from=cmb-airport&to=hikkaduwa&price=121&vehicle=car');
  return { captured: () => captured };
}

async function submitWithPhone(page, { country, phone }) {
  await page.evaluate(() => window.pickDate(2026, 7, 18)); // any valid future date
  await page.evaluate(() => window.goStep && window.goStep(4));
  await page.fill('#f-first', 'Maya');
  await page.fill('#f-last', 'Fernandez');
  await page.fill('#f-email', 'maya@example.com');
  await page.selectOption('#f-country', country);
  await page.fill('#f-phone', phone);
  await page.check('#agree');
  await page.click('#pay-btn');
}

test('a "+"-prefixed number derives the split from what was typed, not the selector', async ({ page }) => {
  const api = await bootBooking(page);
  await submitWithPhone(page, { country: 'Sri Lanka', phone: '+44 7712 345678' });
  await expect.poll(api.captured).not.toBeNull();
  const c = api.captured().customer;
  expect(c.whatsapp).toBe('+447712345678');
  expect(c.phoneCountryCode).toBe('+44'); // NOT the selector's +94
  expect(c.phoneNumber).toBe('7712345678');
});

test('a number typed with the country code but no "+" is not doubled', async ({ page }) => {
  const api = await bootBooking(page);
  await submitWithPhone(page, { country: 'United Kingdom', phone: '44 7911 123456' });
  await expect.poll(api.captured).not.toBeNull();
  const c = api.captured().customer;
  expect(c.whatsapp).toBe('+447911123456'); // NOT +44447911123456
  expect(c.phoneCountryCode).toBe('+44');
  expect(c.phoneNumber).toBe('7911123456');
});

test('a plain national number still gets the selected dial code prefixed', async ({ page }) => {
  const api = await bootBooking(page);
  await submitWithPhone(page, { country: 'Sri Lanka', phone: '077 123 4567' });
  await expect.poll(api.captured).not.toBeNull();
  const c = api.captured().customer;
  expect(c.whatsapp).toBe('+94771234567'); // leading 0 dropped, +94 prefixed once
  expect(c.phoneCountryCode).toBe('+94');
  expect(c.phoneNumber).toBe('771234567');
});
