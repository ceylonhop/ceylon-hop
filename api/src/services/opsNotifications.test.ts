import { describe, it, expect } from 'vitest';
import { FakeEmailAdapter } from '../adapters/email';
import { sendQuoteAssigned, type AssignedQuote } from './opsNotifications';

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
