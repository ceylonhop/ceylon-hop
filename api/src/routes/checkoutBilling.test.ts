import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { isoToday } from '../domain/dateRules';
import { FakePaymentAdapter, type PaymentAdapter, type CreateCheckoutArgs } from '../adapters/payments';

// Billing on PUBLIC booking creation (booking.html step 4). The pay page has collected billing
// since 2026-08-01 via /quotes/pay/start; the website checkout collected nothing, so every
// website booking reached PayHere with no address, no city and — the strongest AVS signal an
// issuer checks — no postcode. Same gateway, same money, half the data.

const SOON = isoToday('Asia/Colombo', new Date(Date.now() + 30 * 86_400_000));
const SOON2 = isoToday('Asia/Colombo', new Date(Date.now() + 34 * 86_400_000));

// Shared seats run Wed (3) and Sat (6) only, so a literal date here would rot into a
// service-day rejection. Same rule as the seat-hold tests.
function futureServiceDay(): string {
  for (let i = 14; i < 60; i++) {
    const iso = isoToday('Asia/Colombo', new Date(Date.now() + i * 86_400_000));
    const wd = new Date(`${iso}T00:00:00Z`).getUTCDay();
    if (wd === 3 || wd === 6) return iso;
  }
  throw new Error('no service day found');
}

const customer = {
  firstName: 'Maya',
  lastName: 'Silva',
  email: 'maya@example.com',
  whatsapp: '+34600000000',
  country: 'Spain',
};

const billing = {
  address: '31 River Court, Apt 105',
  city: 'Jersey City',
  state: 'NJ',
  postcode: '07310',
  country: 'United States',
};

const single = {
  from: 'Colombo Airport (CMB)',
  to: 'Ella',
  date: SOON,
  vehicleType: 'car',
  adults: 2,
  children: 0,
  bags: 2,
  customer,
};

// Captures what the payment adapter is actually handed — the only place that proves the
// billing details left the building, rather than merely being stored.
function spyAdapter(): { adapter: PaymentAdapter; seen: () => CreateCheckoutArgs | null } {
  const inner = new FakePaymentAdapter();
  let seen: CreateCheckoutArgs | null = null;
  const adapter: PaymentAdapter = {
    provider: inner.provider,
    createCheckout: (args) => {
      seen = args;
      return inner.createCheckout(args);
    },
    parseWebhook: (raw) => inner.parseWebhook(raw),
  };
  return { adapter, seen: () => seen };
}

// The gateway customer block, or a failure that says what actually went wrong — an
// optional-chained `undefined` here would read as "the field is missing" when the real
// story is "createCheckout was never called at all".
function gatewayCustomer(args: CreateCheckoutArgs | null): NonNullable<CreateCheckoutArgs['customer']> {
  if (!args) throw new Error('the payment adapter was never asked for a checkout');
  if (!args.customer) throw new Error('the checkout carried no customer block');
  return args.customer;
}

async function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('billing details on public booking creation', () => {
  it('forwards the billing address, city, state and postcode the website collected', async () => {
    const spy = spyAdapter();
    const app = createApp({ adapter: spy.adapter });
    const res = await post(app, '/bookings/single', { ...single, billing, termsAccepted: true });
    expect(res.status).toBe(201);
    const b = await res.json();

    const co = await app.request(`/bookings/${b.id}/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.checkoutToken}` },
    });
    expect(co.status).toBe(200);

    const gw = gatewayCustomer(spy.seen());
    expect(gw.address).toBe('31 River Court, Apt 105');
    expect(gw.city).toBe('Jersey City');
    expect(gw.state).toBe('NJ');
    expect(gw.postcode).toBe('07310');
    // Billing country wins over the lead passenger's phone-derived country.
    expect(gw.country).toBe('United States');
  });

  it('uses the cardholder name when the payer says it differs from the lead passenger', async () => {
    const spy = spyAdapter();
    const app = createApp({ adapter: spy.adapter });
    const res = await post(app, '/bookings/single', {
      ...single,
      billing: { ...billing, firstName: 'Jordan', lastName: 'Reyes' },
      termsAccepted: true,
    });
    const b = await res.json();
    await app.request(`/bookings/${b.id}/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.checkoutToken}` },
    });

    const gw = gatewayCustomer(spy.seen());
    expect(gw.firstName).toBe('Jordan');
    expect(gw.lastName).toBe('Reyes');
    // The receipt and the driver's details still go to the lead passenger.
    expect(gw.email).toBe('maya@example.com');
  });

  it('still omits the gateway address fields when no billing was collected', async () => {
    const spy = spyAdapter();
    const app = createApp({ adapter: spy.adapter });
    const res = await post(app, '/bookings/single', { ...single, termsAccepted: true });
    const b = await res.json();
    await app.request(`/bookings/${b.id}/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.checkoutToken}` },
    });

    const gw = gatewayCustomer(spy.seen());
    expect(gw.address).toBeUndefined();
    expect(gw.city).toBeUndefined();
    expect(gw.country).toBe('Spain');
  });

  it('rejects a half-filled billing object rather than banking a partial address', async () => {
    const app = createApp();
    const res = await post(app, '/bookings/single', {
      ...single,
      billing: { address: '31 River Court', country: 'United States' }, // no city
      termsAccepted: true,
    });
    expect(res.status).toBe(400);
  });

  it('accepts billing on a trip booking', async () => {
    const spy = spyAdapter();
    const app = createApp({ adapter: spy.adapter });
    const res = await post(app, '/bookings/trip', {
      stops: ['Colombo Airport (CMB)', 'Kandy', 'Ella'],
      nights: [2, 2],
      dates: [SOON, SOON2],
      pax: 2,
      vehicleType: 'car',
      serviceType: 'private',
      customer,
      billing,
      termsAccepted: true,
    });
    expect(res.status).toBe(201);
    const b = await res.json();
    await app.request(`/bookings/${b.id}/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.checkoutToken}` },
    });
    expect(gatewayCustomer(spy.seen()).city).toBe('Jersey City');
  });

  it('accepts billing on a shared-seat booking', async () => {
    const spy = spyAdapter();
    const app = createApp({ adapter: spy.adapter });
    const res = await post(app, '/bookings/shared', {
      corridorId: 'hill-line',
      date: futureServiceDay(),
      time: '08:00',
      seats: 2,
      bags: 2,
      customer,
      billing,
      termsAccepted: true,
    });
    expect(res.status).toBe(201);
    const b = await res.json();
    await app.request(`/bookings/${b.id}/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.checkoutToken}` },
    });
    expect(gatewayCustomer(spy.seen()).city).toBe('Jersey City');
  });
});
