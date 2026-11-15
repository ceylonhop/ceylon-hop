// The email that carries an add-on request's pay link to the customer (spec 2026-11-14 §7.5).
import { describe, it, expect } from 'vitest';
import { sendAddOnRequest, type AddOnRequestEmail } from './notifications';
import { FakeEmailAdapter } from '../adapters/email';
import type { Booking } from '../db/bookingRepo';

const customer = { firstName: 'Anna', lastName: 'Berg', email: 'anna@example.com', whatsapp: '+46700000000', country: 'Sweden' };

const booking: Booking = {
  mode: 'trip',
  id: 'b1',
  reference: 'CH-K7M2Q',
  status: 'paid',
  createdAt: new Date().toISOString(),
  total: 24000,
  currency: 'USD',
  channel: 'website',
  input: { stops: ['Kandy', 'Ella', 'Yala', 'Galle'], nights: [1, 1, 1, 0], dates: ['2026-11-18', '', '2026-11-22'], gaps: [1], pax: 2, vehicleType: 'car', serviceType: 'private', customer },
};

const PAY = 'https://ceylonhop.com/manage.html?t=tok#add-ons';
const request: AddOnRequestEmail = {
  requestId: 'r1',
  totalCents: 2900,
  currency: 'USD',
  lines: [
    { label: 'Sightseeing stops (up to 3h) — Kandy → Ella', amountCents: 1000, travelDate: '2026-11-18' },
    { label: 'Wait for Safari — Yala → Galle', amountCents: 1900, travelDate: '2026-11-22' },
  ],
  payBy: '2026-11-18',
  payLink: PAY,
};

async function sendOne(b: Booking = booking, r: AddOnRequestEmail = request) {
  const email = new FakeEmailAdapter();
  const outcome = await sendAddOnRequest(b, r, email);
  expect(email.sent).toHaveLength(1);
  return { m: email.sent[0]!, outcome };
}

describe('sendAddOnRequest', () => {
  it('says what to pay, for what, and links the pay page', async () => {
    const { m, outcome } = await sendOne();
    expect(outcome).toMatchObject({ delivered: true });
    expect(m.to).toBe('anna@example.com');
    expect(m.subject).toBe('An add-on for your trip: pay $29.00 to confirm · CH-K7M2Q');
    expect(m.html).toContain('Hi Anna, your add-on is ready to pay');
    // Every line with its leg, its date and its amount; then the total.
    expect(m.html).toContain('Sightseeing stops (up to 3h) — Kandy → Ella');
    expect(m.html).toMatch(/Wed,? 18 Nov 2026/);
    expect(m.html).toContain('$10.00');
    expect(m.html).toContain('Wait for Safari — Yala → Galle');
    expect(m.html).toMatch(/Sun,? 22 Nov 2026/);
    expect(m.html).toContain('$19.00');
    expect(m.html).toContain('To pay');
    expect(m.html).toContain('$29.00');
    // The button.
    expect(m.html).toContain(`href="${PAY}"`);
    expect(m.html).toContain('Pay $29.00 online');
    expect(m.html).toMatch(/Please pay by the end of Wed,? 18 Nov 2026\. If it isn’t paid by then, the add-on simply isn’t added and nothing is charged\./);
    expect(m.html).toContain('Your trip itself is already paid and confirmed. This only covers the add-on.');
    expect(m.html).toContain('Booking CH-K7M2Q');
    expect(m.html).toContain('https://wa.me/94779669662');
  });

  it('mirrors it all in the plain-text part', async () => {
    const { m } = await sendOne();
    expect(m.text).toContain('Hi Anna,');
    expect(m.text).toContain('Reference: CH-K7M2Q');
    expect(m.text).toMatch(/Sightseeing stops \(up to 3h\) — Kandy → Ella · Wed,? 18 Nov 2026: \$10\.00/);
    expect(m.text).toMatch(/Wait for Safari — Yala → Galle · Sun,? 22 Nov 2026: \$19\.00/);
    expect(m.text).toContain('To pay: $29.00');
    expect(m.text).toContain(`Pay $29.00 online: ${PAY}`);
    expect(m.text).toMatch(/Please pay by the end of Wed,? 18 Nov 2026\./);
    expect(m.text).toContain('Your trip itself is already paid and confirmed. This only covers the add-on.');
  });

  it('leaves the pay-by sentence out when the leg has no date yet', async () => {
    const { m } = await sendOne(booking, {
      ...request, payBy: null, totalCents: 1000,
      lines: [{ label: 'Waiting fee — Kandy → Ella', amountCents: 1000, travelDate: null }],
    });
    expect(m.html).not.toContain('Please pay by');
    expect(m.text).not.toContain('Please pay by');
    expect(m.html).toContain('Waiting fee — Kandy → Ella');
    expect(m.html).toContain('Pay $10.00 online');
  });

  // A pay-on-the-day trip is confirmed but not paid: the email must not say that it is.
  it('does not call a pay-on-the-day trip paid', async () => {
    const { m } = await sendOne({ ...booking, status: 'confirmed', paymentArrangement: 'on_the_day' } as Booking);
    expect(m.html).not.toContain('already paid');
    expect(m.text).not.toContain('already paid');
    expect(m.html).toContain('This only covers the add-on.');
    expect(m.text).toContain('This only covers the add-on.');
  });

  it('HTML-escapes the customer’s name and the line labels', async () => {
    const { m } = await sendOne(
      { ...booking, input: { ...booking.input, customer: { ...customer, firstName: '<b>Anna</b>' } } } as Booking,
      { ...request, lines: [{ label: 'Waiting fee — <i>Kandy</i> → Ella', amountCents: 2900, travelDate: null }] },
    );
    expect(m.html).not.toContain('<b>Anna</b>');
    expect(m.html).toContain('&lt;b&gt;Anna&lt;/b&gt;');
    expect(m.html).not.toContain('<i>Kandy</i>');
  });

  it('keys the email ledger on the request, so each request of a booking is its own row', async () => {
    const { m } = await sendOne();
    expect(m.tracking).toMatchObject({
      bookingId: 'b1', kind: 'add_on_request', templateKey: 'add-on-request', source: 'ops', actorType: 'staff',
      trackingKey: 'b1:add_on_request:r1',
    });
    const other = await sendOne(booking, { ...request, requestId: 'r2' });
    expect(other.m.tracking?.trackingKey).toBe('b1:add_on_request:r2');
  });

  it('uses no em dash of its own: only the fixed line label carries one', async () => {
    const { m } = await sendOne(booking, { ...request, lines: [{ label: 'Waiting fee', amountCents: 2900, travelDate: '2026-11-18' }] });
    expect(m.subject).not.toContain('—');
    // The shared footer and the plain-text banner are older copy and keep theirs.
    const body = m.html.slice(m.html.indexOf('Hi Anna'), m.html.indexOf('Booking CH-K7M2Q'));
    expect(body).not.toMatch(/—|&mdash;/);
  });
});
