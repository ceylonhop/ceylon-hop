// Runs the whole stubbed pipeline in-process and prints it in plain language.
// Usage: npm run demo   (no server, no DB, no real services)
import { createApp } from '../src/app';
import { FakePaymentAdapter } from '../src/adapters/payments';
import { FakeEmailAdapter } from '../src/adapters/email';

const adapter = new FakePaymentAdapter();
const email = new FakeEmailAdapter();
const app = createApp({ adapter, email });

const booking = {
  from: 'Colombo Airport',
  to: 'Ella',
  vehicleType: 'van',
  adults: 3,
  children: 1,
  bags: 4,
  customer: { name: 'Maya', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const json = async (res: Response | Promise<Response>) => (await res).json();

async function main() {
  console.log('1) Create a booking');
  const b = await json(
    app.request('/bookings/single', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(booking),
    }),
  );
  console.log(`   ${b.reference}  ${b.input.from} -> ${b.input.to}  ${usd(b.total)}  status=${b.status}\n`);

  console.log('2) Start checkout');
  const params = await json(app.request(`/bookings/${b.id}/checkout`, { method: 'POST' }));
  console.log(`   checkout url: ${params.checkoutUrl}`);
  const pending = await json(app.request(`/bookings/${b.id}`));
  console.log(`   booking status -> ${pending.status}\n`);

  console.log('3) Simulate a successful payment webhook');
  const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
  const wh = await app.request('/webhooks/payments', { method: 'POST', body });
  console.log(`   webhook responded: ${wh.status}\n`);

  const paid = await json(app.request(`/bookings/${b.id}`));
  console.log(`4) Booking status -> ${paid.status}`);
  console.log(`5) Confirmation emails sent: ${email.sent.length}`);
  if (email.sent[0]) {
    console.log(`   to: ${email.sent[0].to}`);
    console.log(`   subject: ${email.sent[0].subject}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
