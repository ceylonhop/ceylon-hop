// The customer's receipt for a paid add-on request (spec 2026-11-14 §6.4, §7.5).
import { describe, it, expect } from 'vitest';
import { sendAddOnPaid, type AddOnPaidEmail } from './notifications';
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

const MANAGE = 'https://ceylonhop.com/manage.html?t=tok';
const one: AddOnPaidEmail = {
  requestId: 'r1',
  totalCents: 1000,
  currency: 'USD',
  lines: [{ label: 'Sightseeing stops (up to 3h) — Kandy → Ella', amountCents: 1000, travelDate: '2026-11-18' }],
};
const two: AddOnPaidEmail = {
  requestId: 'r2',
  totalCents: 2900,
  currency: 'USD',
  lines: [
    { label: 'Sightseeing stops (up to 3h) — Kandy → Ella', amountCents: 1000, travelDate: '2026-11-18' },
    { label: 'Wait for Safari — Yala → Galle', amountCents: 1900, travelDate: null },
  ],
};

async function sendOne(paid: AddOnPaidEmail = one, b: Booking = booking, links: { manage?: string } = { manage: MANAGE }) {
  const email = new FakeEmailAdapter();
  const outcome = await sendAddOnPaid(b, paid, email, links);
  expect(email.sent).toHaveLength(1);
  return { m: email.sent[0]!, outcome };
}

describe('sendAddOnPaid', () => {
  it('names the one add-on in the subject and says what was paid', async () => {
    const { m, outcome } = await sendOne();
    expect(outcome).toMatchObject({ delivered: true });
    expect(m.to).toBe('anna@example.com');
    expect(m.subject).toBe('Add-on confirmed: Sightseeing stops (up to 3h) — Kandy → Ella · CH-K7M2Q');
    expect(m.html).toContain('Thanks, Anna. Your add-on is confirmed');
    expect(m.html).toContain('Sightseeing stops (up to 3h) — Kandy → Ella');
    expect(m.html).toMatch(/Wed,? 18 Nov 2026/);
    expect(m.html).toContain('Paid');
    expect(m.html).toContain('$10.00');
    expect(m.html).toContain(`href="${MANAGE}"`);
    expect(m.html).toContain('Booking CH-K7M2Q');
    expect(m.html).toContain('https://wa.me/94779669662');
  });

  it('says "Add-ons confirmed" for several lines, lists each and the total', async () => {
    const { m } = await sendOne(two);
    expect(m.subject).toBe('Add-ons confirmed · CH-K7M2Q');
    expect(m.html).toContain('Thanks, Anna. Your add-ons are confirmed');
    expect(m.html).toContain('Sightseeing stops (up to 3h) — Kandy → Ella');
    expect(m.html).toContain('$10.00');
    expect(m.html).toContain('Wait for Safari — Yala → Galle');
    expect(m.html).toContain('$19.00');
    expect(m.html).toContain('$29.00');
  });

  it('mirrors it all in the plain-text part', async () => {
    const { m } = await sendOne(two);
    expect(m.text).toContain('Hi Anna,');
    expect(m.text).toContain('Reference: CH-K7M2Q');
    expect(m.text).toMatch(/Sightseeing stops \(up to 3h\) — Kandy → Ella · Wed,? 18 Nov 2026: \$10\.00/);
    expect(m.text).toContain('Wait for Safari — Yala → Galle: $19.00');
    expect(m.text).toContain('Paid: $29.00');
    expect(m.text).toContain(`View your booking: ${MANAGE}`);
  });

  it('tells the customer the driver will be told, and that the trip itself has not changed', async () => {
    const { m } = await sendOne();
    for (const part of [m.html, m.text]) {
      expect(part).toContain('We’ve received your payment. Our team will tell your driver.');
      expect(part).toContain('Nothing else about your trip has changed.');
    }
  });

  it('leaves the button out when there is no manage link', async () => {
    const { m } = await sendOne(one, booking, {});
    expect(m.html).not.toContain('View your booking');
    expect(m.text).not.toContain('View your booking');
  });

  it('HTML-escapes the customer’s name and the line labels', async () => {
    const { m } = await sendOne(
      { ...one, lines: [{ label: 'Waiting fee — <i>Kandy</i> → Ella', amountCents: 1000, travelDate: null }] },
      { ...booking, input: { ...booking.input, customer: { ...customer, firstName: '<b>Anna</b>' } } } as Booking,
    );
    expect(m.html).not.toContain('<b>Anna</b>');
    expect(m.html).toContain('&lt;b&gt;Anna&lt;/b&gt;');
    expect(m.html).not.toContain('<i>Kandy</i>');
  });

  it('keys the email ledger on the request, so each receipt of a booking is its own row', async () => {
    const { m } = await sendOne();
    expect(m.tracking).toMatchObject({
      bookingId: 'b1', kind: 'add_on_paid', templateKey: 'add-on-paid', source: 'payment_webhook', actorType: 'provider',
      trackingKey: 'b1:add_on_paid:r1',
    });
    expect((await sendOne(two)).m.tracking?.trackingKey).toBe('b1:add_on_paid:r2');
  });

  it('uses no em dash of its own: only the fixed line label carries one', async () => {
    const { m } = await sendOne({ ...two, lines: two.lines.map((l) => ({ ...l, label: l.label.replace(' — ', ', ') })) });
    expect(m.subject).not.toContain('—');
    // The shared footer and the plain-text banner are older copy and keep theirs.
    const body = m.html.slice(m.html.indexOf('Thanks, Anna'), m.html.indexOf('Booking CH-K7M2Q'));
    expect(body).not.toMatch(/—|&mdash;/);
  });
});
