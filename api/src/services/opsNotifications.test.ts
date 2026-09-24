import { describe, it, expect } from 'vitest';
import { FakeEmailAdapter } from '../adapters/email';
import { sendQuoteAssigned, teamPaidEmail, teamCancelledEmail, teamRefundedEmail, type AssignedQuote } from './opsNotifications';
import { sampleBooking } from './__fixtures__/sampleBookings';

const quote = (over: Partial<AssignedQuote> = {}): AssignedQuote => ({
  id: 'q1',
  reference: 'CH-QT-ABC123',
  status: 'draft',
  customerName: 'Maya',
  totalCents: 4048,
  currency: 'USD',
  request: { tool: {}, engine: {} },
  ...over,
});

describe('sendQuoteAssigned', () => {
  it('states the real total for a priced quote', async () => {
    const email = new FakeEmailAdapter();
    await sendQuoteAssigned(quote(), 'op@x.com', 'f@x.com', email, 'https://ops.example');
    const msg = email.sent[0];
    expect(msg.to).toBe('op@x.com');
    expect(msg.html).toContain('$40.48');
    expect(msg.text).toContain('$40.48');
    expect(msg.html).not.toContain('Not priced yet');
  });

  // Hand it over cold (spec 2026-07-29): a shell is assigned BEFORE it is priced, so mailing the
  // colleague "Total: $0.00" would tell them the quote is worthless. The queue already says
  // "Not priced yet"; the email must agree.
  it('says "Not priced yet" instead of $0.00 for an unpriced shell', async () => {
    const email = new FakeEmailAdapter();
    await sendQuoteAssigned(
      quote({ totalCents: 0, customerName: null, request: { shell: true } }),
      'op@x.com',
      'f@x.com',
      email,
      'https://ops.example',
    );
    const msg = email.sent[0];
    expect(msg.html).toContain('Not priced yet');
    expect(msg.text).toContain('Not priced yet');
    expect(msg.html).not.toContain('$0.00');
    expect(msg.text).not.toContain('$0.00');
  });
});

// ---------------------------------------------------------------------------
// Ride Board: ops hears when a seat is held (spec 2026-09-22). Until this, the only way to
// learn a traveller had started or joined a shared ride was to open the dashboard.
// ---------------------------------------------------------------------------
import { sendRideSeatHeld } from './opsNotifications';
import type { RideList, RideMember } from '../domain/rideList';

const ride = (over: Partial<RideList> = {}): RideList => ({
  id: '11111111-1111-4111-8111-111111111111',
  code: 'EM-4821',
  corridorId: 'ella-mirissa',
  fromPlace: 'Ella',
  toPlace: 'Mirissa',
  date: '2026-08-14',
  slot: 'morning',
  lockedTime: null,
  minSeats: 3,
  capacity: 6,
  seatPrice: 2400,
  status: 'gathering',
  note: null,
  cutoffAt: new Date('2026-08-12T01:30:00.000Z'), // 07:00 Colombo
  createdBy: 'sub-1',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  ...over,
});

const member = (over: Partial<RideMember> = {}): RideMember => ({
  id: 'm1',
  listId: '11111111-1111-4111-8111-111111111111',
  position: 2,
  sub: 'sub-2',
  firstName: 'Léa',
  country: 'FR',
  email: 'lea@example.com',
  photoUrl: null,
  preferredTime: null,
  seats: 1,
  preapprovalRef: 'tok',
  status: 'held',
  joinedAt: new Date('2026-08-02T00:00:00.000Z'),
  ...over,
});

describe('sendRideSeatHeld', () => {
  it('tells ops who joined which ride, how full it is, and where to open it', async () => {
    const email = new FakeEmailAdapter();
    await sendRideSeatHeld(
      { to: 'ops@x.com', list: ride(), member: member(), committed: 2, kind: 'joined' },
      email,
      'https://ops.example',
    );
    const msg = email.sent[0];
    expect(msg.to).toBe('ops@x.com');
    expect(msg.audience).toBe('ops');
    expect(msg.subject).toMatch(/^Seat taken: Ella → Mirissa, Fri, 14 Aug 2026 \(2 of 3 seats\)/);
    expect(msg.html).toContain('EM-4821');
    expect(msg.html).toContain('Léa');
    expect(msg.html).toContain('FR');
    expect(msg.html).toContain('lea@example.com');
    expect(msg.html).toContain('2 of 3 needed');
    expect(msg.html).toContain('6 max');
    expect(msg.html).toContain('morning');
    // Cutoff in Colombo time — the clock ops runs on.
    expect(msg.html).toContain('12 Aug 2026 at 07:00');
    expect(msg.html).toContain('https://ops.example/ops?booking=board:EM-4821');
    expect(msg.text).toContain('https://ops.example/ops?booking=board:EM-4821');
    expect(msg.text).toContain('lea@example.com');
  });

  it('calls a started list a new ride and a seat change a change', async () => {
    const email = new FakeEmailAdapter();
    await sendRideSeatHeld(
      { to: 'ops@x.com', list: ride(), member: member({ position: 1 }), committed: 1, kind: 'started' },
      email,
      'https://ops.example',
    );
    await sendRideSeatHeld(
      { to: 'ops@x.com', list: ride(), member: member({ seats: 2 }), committed: 3, kind: 'changed' },
      email,
      'https://ops.example',
    );
    expect(email.sent[0].subject).toMatch(/^New shared ride: Ella → Mirissa/);
    expect(email.sent[1].subject).toMatch(/^Seats changed: Ella → Mirissa/);
    expect(email.sent[1].html).toContain('2 seats');
  });

  it('says the van is viable once the minimum is met, and not before', async () => {
    const email = new FakeEmailAdapter();
    await sendRideSeatHeld({ to: 'ops@x.com', list: ride(), member: member(), committed: 2, kind: 'joined' }, email, '');
    await sendRideSeatHeld({ to: 'ops@x.com', list: ride(), member: member(), committed: 3, kind: 'joined' }, email, '');
    expect(email.sent[0].html).not.toMatch(/viable/i);
    expect(email.sent[1].html).toMatch(/viable/i);
    expect(email.sent[1].text).toMatch(/viable/i);
  });

  it('escapes the traveller name and falls back to prose when there is no ops base URL', async () => {
    const email = new FakeEmailAdapter();
    await sendRideSeatHeld(
      { to: 'ops@x.com', list: ride(), member: member({ firstName: '<b>Léa</b>' }), committed: 2, kind: 'joined' },
      email,
      '',
    );
    const msg = email.sent[0];
    expect(msg.html).not.toContain('<b>Léa</b>');
    expect(msg.html).toContain('&lt;b&gt;Léa&lt;/b&gt;');
    expect(msg.html).not.toContain('?booking=board:');
    expect(msg.html).toMatch(/ops dashboard/i);
  });
});

// ── Team "Paid:" email (owner, 2026-09-23) ─────────────────────────────────
// The paid mail used to be a monospace alert dump with no vehicle and no head-count. The owner
// forwards it from Gmail on the "Paid:" subject prefix, so that prefix is load-bearing.
describe('teamPaidEmail', () => {
  it('a transfer: vehicle + passengers in the subject and the body', () => {
    const m = teamPaidEmail(sampleBooking('single'), 'https://ops.example');
    expect(m.subject.startsWith('Paid: ')).toBe(true);
    expect(m.subject).toContain('Colombo Fort → Kandy');
    expect(m.subject).toContain('AC car · 2 pax');
    expect(m.subject).toContain('LKR 18500.00');
    for (const part of [m.html, m.text]) {
      expect(part).toContain('AC car');
      expect(part).toContain('Passengers');
      expect(part).toContain('2 adults');
      expect(part).toContain('Priya Fernando');
      expect(part).toContain('+94771234567');
      expect(part).toContain('CH-7QK2P');
      expect(part).toContain('Sightseeing stops');
    }
  });

  it('a chauffeur trip: vehicle, head-count and days', () => {
    const m = teamPaidEmail(sampleBooking('trip'), 'https://ops.example');
    expect(m.subject.startsWith('Paid: ')).toBe(true);
    expect(m.subject).toContain('AC van · 3 pax');
    expect(m.subject).toContain('Colombo Airport → … → Ella');
    expect(m.html).toContain('Chauffeur-guide');
    expect(m.html).toContain('7 days');
  });

  it('a shared seat: seats instead of a vehicle', () => {
    const m = teamPaidEmail(sampleBooking('shared'), 'https://ops.example');
    expect(m.subject.startsWith('Paid: ')).toBe(true);
    expect(m.subject).toContain('2 seats');
    expect(m.subject).not.toContain('AC ');
    expect(m.html).toContain('Seats');
    expect(m.html).not.toContain('>Vehicle<');
  });

  it('a deposit says what landed and what is still owed', () => {
    const b = { ...sampleBooking('single'), amountDueNow: 185_000 };
    const m = teamPaidEmail(b, '');
    expect(m.subject).toContain('LKR 1850.00');
    expect(m.text).toContain('Balance due');
    expect(m.text).toContain('LKR 16650.00');
  });

  it('links straight to the booking sheet, or says where to look without a base URL', () => {
    expect(teamPaidEmail(sampleBooking('single'), 'https://ops.example/').html).toContain('https://ops.example/ops?booking=sample-id');
    const bare = teamPaidEmail(sampleBooking('single'), '');
    expect(bare.html).not.toContain('/ops?booking='); // the WhatsApp link is still there, and should be
    expect(bare.text).toContain('Bookings');
  });

  it('escapes what the customer typed', () => {
    const b = sampleBooking('single');
    const evil = { ...b, input: { ...b.input, customer: { ...b.input.customer, firstName: '<img src=x>' } } } as typeof b;
    expect(teamPaidEmail(evil, '').html).not.toContain('<img src=x>');
  });
});

describe('teamCancelledEmail / teamRefundedEmail', () => {
  it('a paid shared seat: seats released, refund still owed, never a "Paid:" subject', () => {
    const m = teamCancelledEmail(sampleBooking('shared'), { by: 'r@x.com', reason: 'Duplicate', statusBefore: 'paid', refundedCents: 0 }, '');
    expect(m.subject.startsWith('Cancelled: ')).toBe(true);
    expect(m.subject).toContain('2 seats released');
    expect(m.text).toContain('Not refunded yet');
    expect(m.text).toContain('back on sale');
  });

  it('a full refund reads as full, and says how it was made', () => {
    const b = sampleBooking('single');
    const m = teamRefundedEmail(b, { amountCents: b.total, currency: b.currency, full: true, by: 'f@x.com', reason: 'Sick', gatewayRef: 'R1', viaApi: true }, '');
    expect(m.subject.startsWith('Refunded: ')).toBe(true);
    expect(m.subject).not.toContain('partial');
    expect(m.text).toContain('(full)');
    expect(m.text).toContain('PayHere (automatic)');
  });
});

// Owner 2026-09-23: one tap from the team email to a WhatsApp chat with the customer.
describe('Message on WhatsApp button', () => {
  it('sits next to the number on the paid email, html and text', () => {
    const m = teamPaidEmail(sampleBooking('single'), '');
    expect(m.html).toContain('href="https://wa.me/94771234567"');
    expect(m.html).toContain('Message on WhatsApp');
    expect(m.text).toContain('https://wa.me/94771234567');
  });

  it('normalises a spaced / dashed number to digits', () => {
    const b = sampleBooking('single');
    const spaced = { ...b, input: { ...b.input, customer: { ...b.input.customer, whatsapp: '+44 (0)7700-900 123' } } } as typeof b;
    expect(teamPaidEmail(spaced, '').html).toContain('https://wa.me/4407700900123');
  });

  it('shows no button for something that is not a phone number', () => {
    const b = sampleBooking('single');
    const junk = { ...b, input: { ...b.input, customer: { ...b.input.customer, whatsapp: 'n/a' } } } as typeof b;
    const m = teamPaidEmail(junk, '');
    expect(m.html).not.toContain('wa.me');
    expect(m.html).toContain('n/a');
  });

  it('is on the cancelled and refunded emails too (same customer block)', () => {
    const b = sampleBooking('single');
    expect(teamCancelledEmail(b, { by: 'x', reason: 'y', statusBefore: 'paid', refundedCents: 0 }, '').html).toContain('wa.me/94771234567');
    expect(teamRefundedEmail(b, { amountCents: 1, currency: b.currency, full: false, by: 'x', reason: 'y', gatewayRef: null, viaApi: false }, '').html).toContain('wa.me/94771234567');
  });
});

describe('sendRideSeatHeld — team email layout', () => {
  it('uses the same layout as the other team emails', async () => {
    const email = new FakeEmailAdapter();
    await sendRideSeatHeld({ to: 'ops@x.com', list: ride(), member: member(), committed: 2, kind: 'joined' }, email, '');
    await sendRideSeatHeld({ to: 'ops@x.com', list: ride(), member: member(), committed: 1, kind: 'started' }, email, '');
    expect(email.sent[0].html).toContain('SEAT HELD');
    expect(email.sent[0].html).toContain('Ella → Mirissa');
    expect(email.sent[0].html).toContain('background:#F6F4EE'); // the key-fact boxes
    expect(email.sent[1].html).toContain('NEW SHARED RIDE');
  });
});
