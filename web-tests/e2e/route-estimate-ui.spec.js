import { test, expect } from '@playwright/test';
import { gotoBooking, pickPlace } from './_stubs.js';

const BROWSE_QUERY = [
  'mode=private',
  'from=cmb-airport',
  'to=hikkaduwa',
  'vehicle=car',
  'price=121',
  'estimateKm=144',
  'estimateMin=130',
  'estimateState=browse',
  'estimateId=cmb-airport%3Ehikkaduwa%3Areviewed-v1',
].join('&');

test('homepage popular transfers use the shared compact estimate and money format', async ({ page }) => {
  await page.goto('/index.html');

  const kandyElla = page.locator('#home-transfers .tcard', { hasText: 'Kandy' })
    .filter({ hasText: 'Ella' });
  await expect(kandyElla.locator('.tc-meta')).toHaveText('Approx. 135 km · 3h 45m');
  await expect(kandyElla.locator('.tc-meta')).not.toContainText('about 3h 47m');
  await expect(kandyElla.locator('.tc-meta')).not.toContainText('private, door to door');

  const airportKandy = page.locator('#home-transfers .tcard', { hasText: 'Colombo Airport' })
    .filter({ hasText: 'Kandy' });
  await expect(airportKandy.locator('.tc-price')).toContainText('from $49.99 fixed');

  await page.setViewportSize({ width: 320, height: 844 });
  await expect(kandyElla.locator('.tc-meta')).toHaveText('Approx. 135 km · 3h 45m');
  expect(await page.locator('body').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('search and booking show the same rounded browse estimate', async ({ page }) => {
  await gotoBooking(page, {
    path: '/search.html',
    query: 'from=cmb-airport&to=ella&pax=2',
  });

  await expect(page.locator('#route-meta')).toContainText('Approx. 335 km · 5h');
  await expect(page.locator('#route-meta')).not.toContainText('4h 57m');

  const href = await page.locator('.opt-private .veh-row').first().locator('a').getAttribute('href');
  const params = new URLSearchParams(href.split('?')[1]);
  expect(params.get('estimateKm')).toBe('335');
  expect(params.get('estimateMin')).toBe('297');
  expect(params.get('estimateState')).toBe('browse');
  expect(params.get('estimateId')).toBe('cmb-airport>ella:reviewed-v1');
});

test('booking keeps the selected browse estimate when the map finishes', async ({ page }) => {
  await gotoBooking(page, {
    query: BROWSE_QUERY,
    routeKm: 300,
    estimate: {
      respond: (intent) => ({
        totalCents: 12100,
        legs: [{
          from: intent.legs[0].from,
          to: intent.legs[0].to,
          distanceKm: 144,
          durationMin: 130,
        }],
      }),
    },
  });

  await expect(page.locator('#rm-bar')).toContainText('Approx. 145 km · 2h 15m');
  await expect(page.locator('#sum-route-estimate')).toHaveText('Approx. 145 km · 2h 15m');
  await expect(page.locator('#rm-bar')).not.toContainText('300 km');
});

test('a material exact-location update is visible, persistent, and announced politely', async ({ page }) => {
  await gotoBooking(page, {
    query: BROWSE_QUERY,
    pickGeo: { lat: 6.15, lng: 80.11 },
    estimate: {
      respond: (intent) => {
        const exact = /Result/.test(intent.legs[0].to);
        return {
          totalCents: 12100,
          legs: [{
            from: intent.legs[0].from,
            to: intent.legs[0].to,
            distanceKm: exact ? 161 : 144,
            durationMin: exact ? 180 : 130,
          }],
        };
      },
    },
  });

  await expect(page.locator('#rm-bar')).toContainText('Approx. 145 km · 2h 15m');
  await pickPlace(page, '#loc-to', 'ac-to', 'Hikkaduwa hotel', 1);

  const updated = 'Updated for your pickup and destination: approx. 160 km · 3h';
  await expect(page.locator('#rm-bar')).toContainText(updated);
  await expect(page.locator('#sum-route-estimate')).toHaveText(updated);
  await expect(page.locator('#route-estimate-status')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#route-estimate-status')).toHaveText(updated);
});

test('an unavailable exact-location estimate never leaves stale route figures behind', async ({ page }) => {
  await gotoBooking(page, {
    query: BROWSE_QUERY,
    pickGeo: { lat: 6.15, lng: 80.11 },
    estimate: {
      respond: (intent) => /Result/.test(intent.legs[0].to)
        ? { status: 503 }
        : {
            totalCents: 12100,
            legs: [{ from: 'Colombo Airport (CMB)', to: 'Hikkaduwa', distanceKm: 144, durationMin: 130 }],
          },
    },
  });

  await expect(page.locator('#rm-bar')).toContainText('Approx. 145 km · 2h 15m');
  await pickPlace(page, '#loc-to', 'ac-to', 'Hikkaduwa hotel', 1);

  const unavailable = 'We’ll confirm the journey time after reviewing your locations.';
  await expect(page.locator('#rm-bar')).toContainText(unavailable);
  await expect(page.locator('#sum-route-estimate')).toHaveText(unavailable);
  await expect(page.locator('#rm-bar')).not.toContainText('145 km');
});
