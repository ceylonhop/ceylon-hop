import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

const list = {
  code: 'GM-2468', corridorId: 'south-coast', from: 'Galle', to: 'Mirissa',
  date: '2099-01-01', slot: 'morning', lockedTime: null, minSeats: 3, capacity: 6,
  seatPrice: 1400, status: 'gathering', note: null,
  cutoffAt: '2098-12-30T00:00:00.000Z', committed: 1,
  members: [{ position: 1, firstName: 'Ana', country: 'DE', photoUrl: null, seats: 1, isStarter: true, isYou: false }],
};


async function stubSignedInBoard(page, joinHandler) {
  await page.route((u) => isApiRequest(new URL(u.href)), async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/board/me') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        me: { firstName: 'Roshen', country: 'LK', photo: null },
      }) });
    }
    if (path === '/board' && req.method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lists: [list] }) });
    }
    if (path === `/board/${list.code}` && req.method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) });
    }
    if (path === `/board/${list.code}/join`) return joinHandler(route);
    if (path === '/board/mine') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lists: [] }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test('a self-service join requires billing details and posts the approval to PayHere', async ({ page }) => {
  let joins = 0;
  await stubSignedInBoard(page, async (route) => {
    joins++;
    const body = route.request().postDataJSON();
    expect(body.payment).toEqual({
      phone: '+44 7700 900123', city: 'London', address: '12 River Street',
    });
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({
      status: 'payment_required',
      payment: {
        provider: 'payhere-tokenized', orderId: 'RBPA-test',
        checkoutUrl: 'https://sandbox.payhere.lk/pay/preapprove',
        fields: { merchant_id: '1234567', order_id: 'RBPA-test', hash: 'SIGNED_SERVER_HASH' },
      },
    }) });
  });

  let payHereBody = '';
  await page.route('https://sandbox.payhere.lk/pay/preapprove', async (route) => {
    payHereBody = route.request().postData() || '';
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>PayHere card approval</h1>' });
  });

  await page.goto('/board.html');
  await page.locator(`[data-view="${list.code}"]`).click();
  await page.locator('[data-detail-join]').last().click();
  await expect(page.locator('#sign-btn')).toBeVisible();

  await page.locator('#sign-btn').click();
  await expect(page.locator('#toast')).toContainText('Add your billing details');
  expect(joins).toBe(0);

  await page.fill('#pay-phone', '+44 7700 900123');
  await page.fill('#pay-city', 'London');
  await page.fill('#pay-address', '12 River Street');
  await page.locator('#sign-btn').click();

  await expect(page.getByRole('heading', { name: 'PayHere card approval' })).toBeVisible();
  const posted = new URLSearchParams(payHereBody);
  expect(posted.get('merchant_id')).toBe('1234567');
  expect(posted.get('order_id')).toBe('RBPA-test');
  expect(posted.get('hash')).toBe('SIGNED_SERVER_HASH');
  expect(joins).toBe(1);
});

test('the PayHere return shows success only after the API reports signed approval', async ({ page }) => {
  const joined = {
    ...list,
    committed: 2,
    members: [
      ...list.members,
      { position: 2, firstName: 'Roshen', country: 'LK', photoUrl: null, seats: 1, isStarter: false, isYou: true },
    ],
  };
  let polls = 0;
  await page.route((u) => isApiRequest(new URL(u.href)), async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/board/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ me: { firstName: 'Roshen', country: 'LK', photo: null } }) });
    if (path === '/board') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lists: [list] }) });
    if (path === '/board/mine') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lists: [] }) });
    if (path === '/board/payments/RBPA-test') {
      polls++;
      const body = polls === 1 ? { status: 'pending' } : { status: 'succeeded', list: joined, manageToken: 'manage-token' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/board.html?ridePayment=RBPA-test');
  await expect(page.locator('#done-head')).toHaveText("Your name’s on the list.", { timeout: 10000 });
  expect(polls).toBeGreaterThanOrEqual(2);
  await expect(page).not.toHaveURL(/ridePayment/);
});
