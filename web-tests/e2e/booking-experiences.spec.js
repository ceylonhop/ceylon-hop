import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact, pickPlace } from './_stubs.js';
import { futureIsoDate } from '../dates.js';

// Partner experiences on booking.html step 3 (spec 2026-10-06 D9/D10/D16/D17). The page asks
// GET /experiences/near for what is close to the drop-off, shows cards, and an "I'm interested" tap
// only records an id: it never touches the price, and never blocks the booking.

const photo = (stem) => ({
  small: `https://ceylonhop.com/img/${stem}-900.jpg`,
  large: `https://ceylonhop.com/img/${stem}-1800.jpg`,
});
const exp = (o) => ({
  id: '11111111-1111-4111-8111-111111111111', slug: 'x', name: 'X', partnerName: 'P', areaLabel: 'Sigiriya',
  summary: 'Summary', details: 'Some details.', priceCents: 3500, currency: 'USD', priceUnit: 'per_person',
  durationText: '90 min', openWeekdays: [0, 1, 2, 3, 4, 5, 6], startTimes: ['09:00'], photos: [], aboutKm: 4, ...o,
});
// The three staging placeholders, in the public shape (toPublicExperience + aboutKm).
const MASSAGE = exp({
  id: '11111111-1111-4111-8111-111111111111', slug: 'placeholder-ayurvedic-massage', name: 'Ayurvedic massage',
  partnerName: 'Atherya Spa', summary: 'A 90-minute Ayurvedic massage with herbal oils.', priceCents: 3500,
  durationText: '90 min', startTimes: ['09:00', '11:00', '14:00', '16:00'], photos: [photo('guides/sigiriya/ayurveda')], aboutKm: 4,
});
const COOKING = exp({
  id: '22222222-2222-4222-8222-222222222222', slug: 'placeholder-village-cooking-lesson', name: 'Village cooking lesson',
  partnerName: 'Suwee', summary: 'Cook a Sri Lankan village meal with a local family.', priceCents: 2500,
  durationText: '3 hrs', openWeekdays: [1, 2, 3, 4, 5, 6], startTimes: ['10:00', '16:00'],
  photos: [photo('guides/sigiriya/family-food'), photo('guides/sigiriya/village')], aboutKm: 6,
});
const SAFARI = exp({
  id: '33333333-3333-4333-8333-333333333333', slug: 'placeholder-elephant-jeep-safari', name: 'Elephant jeep safari',
  partnerName: 'Sample jeep partner', summary: 'A jeep safari to see wild elephants.', priceCents: 4500, priceUnit: 'per_group',
  durationText: '3-4 hrs', startTimes: ['14:00'], photos: [photo('guides/sigiriya/elephants')], aboutKm: 9,
});
const SIGIRIYA = { place: 'Sigiriya', items: [MASSAGE, COOKING, SAFARI] };

const PRIVATE = 'mode=private&from=cmb-airport&to=sigiriya&price=121&vehicle=car';
const NEAR = futureIsoDate(30);
const TRIP = `mode=trip&stops=Sigiriya%7CKandy&nights=1,0&dates=${NEAR},${NEAR}&kms=100,100&pax=2&vehicle=car&start=${NEAR}`;

const block = (page) => page.locator('#experiences-block');
const goStep3 = (page) => page.evaluate(() => window.goStep(3));

test.beforeEach(async ({ page }) => {
  // The CDN photos are not part of the offline suite; a missing photo hides itself (onerror).
  await page.route('https://ceylonhop.com/img/**', (r) => r.abort());
});

test.describe('the experiences block on step 3', () => {
  test('a private transfer to Sigiriya shows "While you’re in Sigiriya" with the three cards', async ({ page }) => {
    const { nearRequests } = await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);

    await expect(block(page)).toBeVisible();
    await expect(block(page).locator('h3')).toHaveText('While you’re in Sigiriya');
    await expect(block(page).locator('.xp-card')).toHaveCount(3);
    expect(nearRequests).toEqual([['Sigiriya@7.95,80.76']]);

    // The owner-approved box (spec D16), once, above the cards.
    await expect(block(page).locator('.xp-note')).toHaveCount(1);
    await expect(block(page).locator('.xp-note')).toHaveText(
      'Nothing to pay now. Tap “I’m interested” and our Ceylon Hop Pro team will reach out to help you schedule it. You pay the same price as booking direct — never more.',
    );

    const card = block(page).locator('.xp-card').first();
    await expect(card).toContainText('Ayurvedic massage');
    await expect(card).toContainText('Atherya Spa');
    await expect(card).toContainText('about 4 km away');
    await expect(card).toContainText('A 90-minute Ayurvedic massage with herbal oils.');
    await expect(card).toContainText('90 min');
    await expect(card).toContainText('Daily');
    await expect(card).toContainText('$35 pp');
    await expect(card).toContainText('Same as booking direct');
    await expect(block(page).locator('.xp-card').nth(1)).toContainText('Mon–Sat');
    await expect(block(page).locator('.xp-card').nth(2)).toContainText('$45 per group');
  });

  test('"Details & photos" opens an inline panel with the times, the days and every photo', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    const card = block(page).locator('.xp-card').nth(1);
    const more = card.locator('.xp-more');
    await expect(more).toHaveText('Details & photos');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(card.locator('.xp-panel')).toBeHidden();

    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(card.locator('.xp-panel')).toBeVisible();
    await expect(card.locator('.xp-panel')).toContainText('Open: Mon–Sat');
    await expect(card.locator('.xp-panel')).toContainText('Times: 10:00 · 16:00');
    await expect(card.locator('.xp-panel')).toContainText('Some details.');
    await expect(card.locator('.xp-panel img')).toHaveCount(2);
    await expect(card.locator('.xp-panel img').first()).toHaveAttribute('srcset', /900\.jpg 900w, .*1800\.jpg 1800w/);

    await more.click();
    await expect(card.locator('.xp-panel')).toBeHidden();
  });

  test('tapping "I’m interested" flips the button, shows the note and the summary box, and never moves the Total', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    const total = page.locator('#sum-total');
    const before = await total.textContent();
    expect(before).toMatch(/\$/);

    const card = block(page).locator('.xp-card').first();
    const btn = card.locator('.xp-btn');
    await expect(btn).toHaveText('I’m interested');
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(card.locator('.xp-after')).toBeHidden();
    await expect(page.locator('#sum-experiences')).toBeHidden();

    await btn.click();
    await expect(btn).toHaveText('✓ Interested');
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(card.locator('.xp-after')).toBeVisible();
    await expect(card.locator('.xp-after')).toHaveText(
      'Noted — you won’t be charged for this. Our Ceylon Hop Pro team will message you with details and available times. If you go ahead, we’ll send you a secure payment link.',
    );
    await expect(page.locator('#sum-experiences')).toBeVisible();
    await expect(page.locator('#sum-experiences')).toContainText('You’re interested in — not charged');
    await expect(page.locator('#sum-experiences')).toContainText('Ayurvedic massage');
    await expect(total).toHaveText(before);

    // A second tap takes it back.
    await btn.click();
    await expect(btn).toHaveText('I’m interested');
    await expect(card.locator('.xp-after')).toBeHidden();
    await expect(page.locator('#sum-experiences')).toBeHidden();
    await expect(total).toHaveText(before);
  });

  test('no button on the block says "free" or "no charge", tapped or not', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    const texts = async () => block(page).locator('button').allTextContents();
    for (const t of await texts()) expect(t).not.toMatch(/free|no charge/i);
    await block(page).locator('.xp-btn').first().click();
    for (const t of await texts()) expect(t).not.toMatch(/free|no charge/i);
  });
});

test.describe('the booking payload', () => {
  test('a single transfer sends experienceIds — ids only, no names or labels', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    await block(page).locator('.xp-btn').nth(0).click();
    await block(page).locator('.xp-btn').nth(2).click();
    await fillContact(page);
    const reqP = page.waitForRequest('**/bookings/single');
    await page.click('#pay-btn');
    const raw = (await reqP).postData();
    const body = JSON.parse(raw);

    expect(body.experienceIds).toEqual([MASSAGE.id, SAFARI.id]);
    for (const label of ['Ayurvedic', 'Atherya', 'Sigiriya@', 'placeholder-', 'jeep']) expect(raw).not.toContain(label);
    expect(Object.keys(body).filter((k) => /experience/i.test(k))).toEqual(['experienceIds']);
  });

  test('un-tapping everything leaves experienceIds out', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    const btn = block(page).locator('.xp-btn').first();
    await btn.click();
    await btn.click();
    await fillContact(page);
    const reqP = page.waitForRequest('**/bookings/single');
    await page.click('#pay-btn');
    expect('experienceIds' in JSON.parse((await reqP).postData())).toBe(false);
  });

  test('a trip sends experienceIds on /bookings/trip', async ({ page }) => {
    await gotoBooking(page, { query: TRIP, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    await block(page).locator('.xp-btn').nth(1).click();
    await fillContact(page);
    const reqP = page.waitForRequest('**/bookings/trip');
    await page.click('#pay-btn');
    expect(JSON.parse((await reqP).postData()).experienceIds).toEqual([COOKING.id]);
  });
});

test.describe('where the points come from', () => {
  test('a trip asks once for every overnight stop, by name', async ({ page }) => {
    const { nearRequests } = await gotoBooking(page, { query: TRIP, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    await expect(block(page).locator('h3')).toHaveText('While you’re in Sigiriya');
    expect(nearRequests).toHaveLength(1);
    expect(nearRequests[0]).toHaveLength(2);
    expect(nearRequests[0][0]).toMatch(/^Sigiriya@7\.95,80\.76$/);
    expect(nearRequests[0][1]).toMatch(/^Kandy@7\.29,80\.63$/);
  });

  test('a shared seat asks about the catalogue drop-off', async ({ page }) => {
    const { nearRequests } = await gotoBooking(page, {
      query: 'mode=shared&from=cmb-airport&to=sigiriya&price=19&times=07:30&corridor=airport-cultural&days=3,6&pax=1',
      experiences: { stops: [SIGIRIYA] },
    });
    await goStep3(page);
    await expect(block(page).locator('h3')).toHaveText('While you’re in Sigiriya');
    expect(nearRequests).toEqual([['Sigiriya@7.95,80.76']]);
  });

  test('leaving and re-entering step 3 does not ask again for the same stops', async ({ page }) => {
    const { nearRequests } = await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    await expect(block(page).locator('.xp-card')).toHaveCount(3);
    await page.evaluate(() => { window.goStep(2); window.goStep(3); });
    await page.locator('#ad-n').waitFor();
    expect(nearRequests).toHaveLength(1);
  });

  test('a drop-off picked from Google asks about that exact point, under the area’s name', async ({ page }) => {
    const { nearRequests } = await gotoBooking(page, { query: PRIVATE, pickGeo: { lat: 7.96, lng: 80.77 }, experiences: { stops: [SIGIRIYA] } });
    await pickPlace(page, '#loc-to', 'ac-to', 'Heritage', 0);
    await goStep3(page);
    await expect(block(page).locator('h3')).toHaveText('While you’re in Sigiriya');
    expect(nearRequests.at(-1)).toHaveLength(1);
    expect(nearRequests.at(-1)[0]).toMatch(/^Sigiriya@7\.9\d{1,2},80\.7\d{1,2}$/);
    expect(nearRequests.at(-1)[0]).not.toBe('Sigiriya@7.95,80.76');
  });
});

test.describe('never in the way (D17)', () => {
  test('an empty answer leaves the block hidden', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [] } });
    await goStep3(page);
    await page.waitForTimeout(300);
    await expect(block(page)).toBeHidden();
    await expect(page.locator('#sum-experiences')).toBeHidden();
  });

  test('a 500 hides the block and the booking still completes', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { status: 500 } });
    await goStep3(page);
    await page.waitForTimeout(300);
    await expect(block(page)).toBeHidden();
    // Step 3's own controls are untouched.
    await expect(page.locator('#n4')).toBeEnabled();
    await fillContact(page);
    const bookingP = page.waitForRequest('**/bookings/single');
    const checkoutP = page.waitForRequest('**/bookings/*/checkout');
    await page.click('#pay-btn');
    expect('experienceIds' in JSON.parse((await bookingP).postData())).toBe(false);
    await checkoutP;
  });

  test('an answer slower than 3 seconds is dropped; the block never appears', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA], delayMs: 3600 } });
    await goStep3(page);
    await page.waitForTimeout(4200);
    await expect(block(page)).toBeHidden();
  });

  test('a name from the API is text, never markup', async ({ page }) => {
    const evil = exp({ id: '44444444-4444-4444-8444-444444444444', name: '"><img src=x onerror="window.__xss=1">', partnerName: '<b>P</b>' });
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [{ place: 'Sigiriya', items: [evil] }] } });
    await goStep3(page);
    await expect(block(page).locator('.xp-card')).toHaveCount(1);
    await expect(block(page).locator('.xp-card')).toContainText('"><img src=x onerror="window.__xss=1">');
    await block(page).locator('.xp-btn').click();
    await expect(page.locator('#sum-experiences')).toContainText('<img src=x');
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(block(page).locator('.xp-partner')).toHaveText('<b>P</b>');
    await expect(block(page).locator('.xp-partner b')).toHaveCount(0);
  });
});

test.describe('phone layout', () => {
  test.use({ viewport: { width: 375, height: 760 } });

  test('375px: nothing overflows sideways, and price and button sit under the description', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    await expect(block(page).locator('.xp-card')).toHaveCount(3);
    const m = await page.evaluate(() => {
      const root = document.documentElement;
      const cards = [...document.querySelectorAll('#experiences-block .xp-card')];
      const c = cards[0];
      return {
        pageOverflow: root.scrollWidth - root.clientWidth,
        cardRightMax: Math.max(...cards.map((x) => x.getBoundingClientRect().right)),
        vw: window.innerWidth,
        descBottom: c.querySelector('.xp-sum').getBoundingClientRect().bottom,
        buyTop: c.querySelector('.xp-buy').getBoundingClientRect().top,
        buyLeft: c.querySelector('.xp-buy').getBoundingClientRect().left,
        cardLeft: c.getBoundingClientRect().left,
        btnH: c.querySelector('.xp-btn').getBoundingClientRect().height,
        btnRight: Math.max(...cards.map((x) => x.querySelector('.xp-btn').getBoundingClientRect().right)),
        cardInnerRight: Math.min(...cards.map((x) => x.getBoundingClientRect().right)),
      };
    });
    expect(m.pageOverflow).toBeLessThanOrEqual(0);
    expect(m.cardRightMax).toBeLessThanOrEqual(m.vw);
    expect(m.buyTop).toBeGreaterThanOrEqual(m.descBottom - 1);
    expect(m.buyLeft - m.cardLeft).toBeLessThan(40);
    expect(m.btnH).toBeGreaterThanOrEqual(44);
    expect(m.btnRight).toBeLessThanOrEqual(m.cardInnerRight);

    // The tap works here too, and the summary box lives in the mobile sheet (#summary).
    await block(page).locator('.xp-btn').first().click();
    await expect(page.locator('#summary #sum-experiences')).toHaveCount(1);
  });
});
