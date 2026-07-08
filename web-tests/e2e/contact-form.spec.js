import { test, expect } from '@playwright/test';

test('contact form submits split phone fields while preserving WhatsApp', async ({ page }) => {
  let captured = null;

  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.route('**/www.payhere.lk/**', (r) => r.abort());
  await page.route('**/*sandbox.payhere.lk/**', (r) => r.abort());
  await page.route('https://api.test/health', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{"status":"ok"}',
  }));
  await page.route('https://api.test/bookings/single', (r) => {
    captured = JSON.parse(r.request().postData() || '{}');
    return r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'contact-e2e',
        reference: 'CH-CONTACT',
        status: 'draft',
        mode: 'single',
        total: 12100,
        amountDueNow: 12100,
        currency: 'USD',
      }),
    });
  });
  await page.route('https://api.test/bookings/contact-e2e/checkout', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ checkoutUrl: 'https://example.test/fake-gateway', fields: {} }),
  }));

  await page.goto('/booking.html?api=https://api.test&mode=private&from=cmb-airport&to=hikkaduwa&price=121&vehicle=car');
  await page.evaluate(() => window.goStep && window.goStep(4));
  await page.fill('#f-first', 'Maya');
  await page.fill('#f-last', 'Silva');
  await page.fill('#f-email', 'maya@example.com');
  await page.selectOption('#f-phone-code', '+94');
  await page.fill('#f-phone', '77 123 4567');
  await page.selectOption('#f-country', 'Sri Lanka');
  await page.check('#agree');

  await page.click('#pay-btn');

  await expect.poll(() => captured).toMatchObject({
    customer: {
      firstName: 'Maya',
      lastName: 'Silva',
      email: 'maya@example.com',
      phoneCountryCode: '+94',
      phoneNumber: '771234567',
      whatsapp: '+94771234567',
      country: 'Sri Lanka',
    },
  });
});

test('contact form offers a full country and calling-code list', async ({ page }) => {
  await page.goto('/booking.html?mode=private&from=cmb-airport&to=hikkaduwa&price=121&vehicle=car');
  await page.evaluate(() => window.goStep && window.goStep(4));

  await expect.poll(() => page.locator('#f-phone-code option').count()).toBeGreaterThan(150);
  await expect.poll(() => page.locator('#f-country option').count()).toBeGreaterThan(150);
  await expect(page.locator('#f-phone-code')).toContainText('Argentina +54');
  await expect(page.locator('#f-phone-code')).toContainText('South Africa +27');
  await expect(page.locator('#f-country')).toContainText('Zimbabwe');
});

test('contact validation rejects a missing phone number', async ({ page }) => {
  await page.goto('/booking.html?mode=private&from=cmb-airport&to=hikkaduwa&price=121&vehicle=car');
  await page.evaluate(() => window.goStep && window.goStep(4));
  await page.fill('#f-first', 'Maya');
  await page.fill('#f-last', 'Silva');
  await page.fill('#f-email', 'maya@example.com');
  await page.fill('#f-phone', '');
  await page.check('#agree');

  await page.click('#pay-btn');

  await expect(page.locator('#details-error')).toContainText('valid WhatsApp number');
  await expect(page.locator('#ph-overlay')).toBeHidden();
});
