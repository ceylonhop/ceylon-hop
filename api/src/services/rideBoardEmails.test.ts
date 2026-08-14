import { describe, it, expect } from 'vitest';
import { sendRideConfirmed, sendRideCancelled, sendRideAtRisk } from './rideBoardEmails';
import { FakeEmailAdapter } from '../adapters/email';
import type { RideList } from '../domain/rideList';

// ============================================================================
// Why this file exists: the three Ride Board senders are the only thing a
// traveller ever sees when their pooled ride confirms, is called off, or their
// card fails — yet they were previously exercised only indirectly by the cutoff
// sweep (rideBoardCutoff.test.ts), which asserts that *an* email was sent, not
// what it says. These tests pin the contract that actually matters to a human:
// right recipient, a subject, the route, the date, the locked departure time,
// the traveller's first name, money in major units (never raw cents), and — for
// the called-off email — the product's core promise that nobody was charged.
// Copy is deliberately NOT pinned sentence-by-sentence so wording can evolve.
// ============================================================================

const list: RideList = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'EM-4821',
  corridorId: 'ella-mirissa',
  fromPlace: 'Ella',
  toPlace: 'Mirissa',
  date: '2026-08-14',
  slot: 'morning',
  lockedTime: '08:00',
  minSeats: 3,
  capacity: 6,
  seatPrice: 2400, // cents — must render as $24.00, never "2400"
  status: 'confirmed',
  note: 'Happy to share bags',
  cutoffAt: new Date('2026-08-12T01:30:00.000Z'),
  createdBy: 'sub-1',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
};

// The other two email systems escape every interpolation (notifications.ts and
// opsEmail.ts both carry an esc()); these templates interpolate the traveller's
// first name and the place names raw. Both are user-influenced — a first name is
// whatever was typed at signup — and an email body is exactly where a stray
// <script> or <img onerror> must become inert text.
describe('escaping', () => {
  it('renders a hostile first name and place name as text, not markup', async () => {
    const email = new FakeEmailAdapter();
    const hostile: RideList = { ...list, fromPlace: 'Ella<script>alert(1)</script>', toPlace: 'Mirissa "&" more' };
    await sendRideConfirmed(email, {
      to: 'maya@example.com', firstName: '<img src=x onerror=alert(1)>Maya', list: hostile, lockedTime: '08:00',
    });
    const html = email.sent[0].html;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('sendRideConfirmed', () => {
  it('emails the traveller the route, date, locked time and seat price — once', async () => {
    const email = new FakeEmailAdapter();
    await sendRideConfirmed(email, { to: 'maya@example.com', firstName: 'Maya', list, lockedTime: '08:00' });

    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m.to).toBe('maya@example.com');
    expect(m.subject).toBeTruthy();
    expect(m.subject).toContain('Ella → Mirissa');
    expect(m.subject.toLowerCase()).toContain('confirmed');
    expect(m.html).toContain('Maya');
    expect(m.html).toContain('Ella → Mirissa');
    expect(m.html).toContain('2026-08-14');
    expect(m.html).toContain('08:00');
    expect(m.html).toContain('$24.00');
  });

  it('uses the passed locked time, not whatever is stored on the list', async () => {
    const email = new FakeEmailAdapter();
    await sendRideConfirmed(email, { to: 'maya@example.com', firstName: 'Maya', list, lockedTime: '09:00' });
    expect(email.sent[0].html).toContain('09:00');
    expect(email.sent[0].text).toContain('09:00');
  });

  it('renders money in major units — never raw cents', async () => {
    const email = new FakeEmailAdapter();
    await sendRideConfirmed(email, { to: 'maya@example.com', firstName: 'Maya', list, lockedTime: '08:00' });
    const m = email.sent[0];
    expect(m.html).not.toMatch(/\b2400\b/);
    expect(m.text).not.toMatch(/\b2400\b/);
    expect(m.text).toContain('$24.00');
  });

  it('ships a plain-text alternative carrying the same key facts', async () => {
    const email = new FakeEmailAdapter();
    await sendRideConfirmed(email, { to: 'maya@example.com', firstName: 'Maya', list, lockedTime: '08:00' });
    const t = email.sent[0].text ?? '';
    expect(t).toContain('Maya');
    expect(t).toContain('Ella → Mirissa');
    expect(t).toContain('2026-08-14');
    expect(t).not.toContain('<'); // genuinely plain text
  });
});

describe('sendRideCancelled', () => {
  it('tells the traveller the ride is off and that they were NOT charged', async () => {
    const email = new FakeEmailAdapter();
    const called = { ...list, status: 'expired' as const, lockedTime: null };
    await sendRideCancelled(email, { to: 'sam@example.com', firstName: 'Sam', list: called });

    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m.to).toBe('sam@example.com');
    expect(m.subject).toContain('Ella → Mirissa');
    // The product's core promise must survive any copy rewrite: the subject line
    // itself has to say no money was taken, so it reads right in an inbox preview.
    expect(m.subject.toLowerCase()).toMatch(/not charged|weren't charged|wasn't charged|no charge/);
    expect(m.html).toContain('Sam');
    expect(m.html).toContain('Ella → Mirissa');
    expect(m.html).toContain('2026-08-14');
    expect(m.html.toLowerCase()).toMatch(/not charged|no charge/);
    expect((m.text ?? '').toLowerCase()).toMatch(/not charged|no charge/);
  });

  it('never quotes a seat price as raw cents', async () => {
    const email = new FakeEmailAdapter();
    await sendRideCancelled(email, { to: 'sam@example.com', firstName: 'Sam', list });
    expect(email.sent[0].html).not.toMatch(/\b2400\b/);
    expect(email.sent[0].text ?? '').not.toMatch(/\b2400\b/);
  });
});

describe('sendRideAtRisk', () => {
  it('warns the named traveller that their seat on the dated route is at risk', async () => {
    const email = new FakeEmailAdapter();
    await sendRideAtRisk(email, { to: 'ana@example.com', firstName: 'Ana', list });

    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m.to).toBe('ana@example.com');
    expect(m.subject).toContain('Ella → Mirissa');
    expect(m.subject.toLowerCase()).toMatch(/at risk|action needed/);
    expect(m.html).toContain('Ana');
    expect(m.html).toContain('Ella → Mirissa');
    expect(m.html).toContain('2026-08-14');
    expect(m.html.toLowerCase()).toContain('card');
    expect((m.text ?? '').toLowerCase()).toContain('card');
  });
});

describe('optional fields', () => {
  const bare: RideList = { ...list, lockedTime: null, note: null, createdBy: null };

  it('sends without throwing (and without leaking "null") when lockedTime and note are absent', async () => {
    const email = new FakeEmailAdapter();
    await expect(
      sendRideConfirmed(email, { to: 'x@example.com', firstName: 'Nil', list: bare, lockedTime: '07:00' }),
    ).resolves.toBeUndefined();
    await expect(sendRideCancelled(email, { to: 'x@example.com', firstName: 'Nil', list: bare })).resolves.toBeUndefined();
    await expect(sendRideAtRisk(email, { to: 'x@example.com', firstName: 'Nil', list: bare })).resolves.toBeUndefined();

    expect(email.sent).toHaveLength(3);
    for (const m of email.sent) {
      expect(m.subject).toBeTruthy();
      expect(m.html).toBeTruthy();
      expect(m.html).not.toContain('null');
      expect(m.html).not.toContain('undefined');
    }
  });
});

// KNOWN GAP (reported, not fixed here): none of the three emails prints the
// list's public code (`list.code`, e.g. "EM-4821"), so a traveller replying about
// their ride has nothing to quote and ops has nothing to match on. `it.fails`
// keeps that visible: it passes only while the gap exists, and turns RED the
// moment the code is added — delete the `.fails` then.
it.fails('includes the public ride code a traveller could quote back to us', async () => {
  const email = new FakeEmailAdapter();
  await sendRideConfirmed(email, { to: 'maya@example.com', firstName: 'Maya', list, lockedTime: '08:00' });
  expect(email.sent[0].html).toContain('EM-4821');
});
