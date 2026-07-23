import { describe, it, expect } from 'vitest';
import {
  manageUrl,
  sendBookingConfirmation,
  sendCancellationConfirmation,
  sendRefundConfirmation,
  sendTripReminder,
  sendReviewRequest,
  sendPaymentFailed,
  sendDepositReceived,
} from './notifications';
import { FakeEmailAdapter } from '../adapters/email';
import type { Booking } from '../db/bookingRepo';

const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };

const single: Booking = {
  mode: 'single',
  id: 'id1',
  reference: 'CH-ABC12',
  status: 'paid',
  createdAt: new Date().toISOString(),
  total: 5000,
  currency: 'USD',
  channel: 'website',
  input: { from: 'Colombo Airport', to: 'Ella', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer },
};

describe('sendBookingConfirmation — single transfer', () => {
  it('emails the customer with reference, route, vehicle, travellers and total — once', async () => {
    const email = new FakeEmailAdapter();
    await sendBookingConfirmation(single, email);
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m.to).toBe('maya@example.com');
    expect(m.subject).toContain('CH-ABC12');
    expect(m.subject.toLowerCase()).toContain('confirmed');
    expect(m.html).toContain('Colombo Airport');
    expect(m.html).toContain('Ella');
    expect(m.html).toContain('AC car');
    expect(m.html).toContain('2 adults');
    expect(m.html).toContain('$50.00');
  });

  it('includes a plain-text alternative mirroring the details', async () => {
    const email = new FakeEmailAdapter();
    await sendBookingConfirmation(single, email);
    const m = email.sent[0];
    expect(m.text).toBeTruthy();
    expect(m.text).toContain('CH-ABC12');
    expect(m.text).toContain('Colombo Airport → Ella');
    expect(m.text).toContain('$50.00');
    expect(m.text).not.toContain('<'); // genuinely plain text
  });

  it('HTML-escapes customer-supplied text (no markup/script injection)', async () => {
    const email = new FakeEmailAdapter();
    const evil = { ...customer, firstName: 'Mal<script>alert(1)</script>&"' };
    await sendBookingConfirmation({ ...single, input: { ...single.input, from: 'Pickup<b>x</b>', customer: evil } }, email);
    const m = email.sent[0];
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('Pickup<b>');
    expect(m.html).toContain('&lt;script&gt;');
  });

  it('shows "To confirm" when no date was set (flexible booking)', async () => {
    const email = new FakeEmailAdapter();
    await sendBookingConfirmation(single, email);
    expect(email.sent[0].html).toContain('To confirm');
  });

  it('formats a set date + time', async () => {
    const email = new FakeEmailAdapter();
    await sendBookingConfirmation({ ...single, input: { ...single.input, date: '2026-06-26', time: '09:00' } }, email);
    const m = email.sent[0];
    expect(m.html).toContain('26 Jun 2026');
    expect(m.html).toContain('09:00');
  });
});

describe('sendBookingConfirmation — trip (chauffeur)', () => {
  const trip: Booking = {
    mode: 'trip',
    id: 'id2',
    reference: 'CH-TRIP1',
    status: 'paid',
    createdAt: new Date().toISOString(),
    total: 60000,
    currency: 'USD',
    channel: 'website',
    input: {
      stops: ['Colombo Airport', 'Kandy', 'Ella'],
      nights: [0, 2, 2],
      dates: ['2026-07-01', '2026-07-03'],
      pax: 3,
      vehicleType: 'van',
      serviceType: 'chauffeur',
      customer,
      days: 5,
      driverNights: 4,
    },
  };

  it('lists the stops, chauffeur service and the 10-day cancellation policy', async () => {
    const email = new FakeEmailAdapter();
    await sendBookingConfirmation(trip, email);
    const m = email.sent[0];
    // route is now a stop-by-stop timeline (each stop on its own row)
    expect(m.html).toContain('Colombo Airport');
    expect(m.html).toContain('Kandy');
    expect(m.html).toContain('Ella');
    expect(m.html).toContain('Chauffeur-guide');
    expect(m.html).toContain('From');
    expect(m.html).toContain('1 Jul 2026');
    expect(m.text).toContain('Colombo Airport → Kandy → Ella'); // text keeps the joined route
    expect(m.text).toContain('10 days');
  });

  it('shows deposit paid + balance due when only the deposit was collected (GL-3)', async () => {
    const email = new FakeEmailAdapter();
    await sendBookingConfirmation({ ...trip, total: 90380, amountDueNow: 5000 }, email);
    const m = email.sent[0];
    expect(m.html).toContain('Deposit paid');
    expect(m.html).toContain('$50.00');
    expect(m.html).toContain('Balance due');
    expect(m.html).toContain('$853.80');
    expect(m.html).not.toContain('Total paid');
    expect(m.text).toContain('Deposit paid: $50.00');
    expect(m.text).toContain('Balance due: $853.80');
  });

  it('keeps the single total line when paid in full', async () => {
    const email = new FakeEmailAdapter();
    await sendBookingConfirmation({ ...trip, amountDueNow: trip.total }, email);
    const m = email.sent[0];
    expect(m.html).toContain('Total paid');
    expect(m.html).not.toContain('Balance due');
  });
});

describe('sendBookingConfirmation — shared seat', () => {
  const shared: Booking = {
    mode: 'shared',
    id: 'id3',
    reference: 'CH-SHR01',
    status: 'paid',
    createdAt: new Date().toISOString(),
    total: 4000,
    currency: 'USD',
    channel: 'website',
    input: { corridorId: 'cmb-galle', date: '2026-07-10', time: '08:00', seats: 2, customer },
  };

  it('shows shared service, seats and the fixed departure', async () => {
    const email = new FakeEmailAdapter();
    await sendBookingConfirmation(shared, email);
    const m = email.sent[0];
    expect(m.html).toContain('Shared ride');
    expect(m.html).toContain('10 Jul 2026');
    expect(m.html).toContain('08:00');
    expect(m.html).toContain('$40.00');
  });
});

describe('sendCancellationConfirmation', () => {
  it('emails the customer that the booking is cancelled, with reference + route — once', async () => {
    const email = new FakeEmailAdapter();
    await sendCancellationConfirmation(single, email);
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m.to).toBe('maya@example.com');
    expect(m.subject).toContain('CH-ABC12');
    expect(m.subject.toLowerCase()).toContain('cancel');
    expect(m.html.toLowerCase()).toContain('cancel');
    expect(m.html).toContain('Colombo Airport');
    expect(m.html).toContain('Ella');
  });

  it('includes a plain-text alternative with the reference and no markup', async () => {
    const email = new FakeEmailAdapter();
    await sendCancellationConfirmation(single, email);
    const m = email.sent[0];
    expect(m.text).toBeTruthy();
    expect(m.text).toContain('CH-ABC12');
    expect(m.text).not.toContain('<');
  });
});

describe('sendTripReminder', () => {
  it('reminds the customer about the upcoming trip, with reference, route and date — once', async () => {
    const email = new FakeEmailAdapter();
    await sendTripReminder({ ...single, input: { ...single.input, date: '2026-06-26', time: '09:00' } }, email);
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m.to).toBe('maya@example.com');
    expect(m.subject).toContain('CH-ABC12');
    expect(m.html).toContain('Colombo Airport');
    expect(m.html).toContain('26 Jun 2026');
    expect(m.text).toContain('CH-ABC12');
    expect(m.text).not.toContain('<');
  });
});

describe('sendReviewRequest', () => {
  it('thanks the customer and asks for a review, with reference and a review link — once', async () => {
    const email = new FakeEmailAdapter();
    await sendReviewRequest(single, email);
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m.subject).toContain('CH-ABC12');
    expect(m.html.toLowerCase()).toContain('review');
    expect(m.html).toContain('g.page/ceylonhop');
    expect(m.text).not.toContain('<');
  });
});

describe('manage-booking link', () => {
  it('builds a signed manage URL from the base + secret', () => {
    const url = manageUrl(single, 'https://ceylonhop.com', 'sek');
    expect(url).toMatch(/^https:\/\/ceylonhop\.com\/manage\.html\?t=.+\..+$/);
  });

  it('renders a View-your-booking link when provided, and omits it otherwise', async () => {
    const withLink = new FakeEmailAdapter();
    await sendBookingConfirmation(single, withLink, { manage: 'https://ceylonhop.com/manage.html?t=TOK' });
    expect(withLink.sent[0].html).toContain('https://ceylonhop.com/manage.html?t=TOK');
    expect(withLink.sent[0].text).toContain('https://ceylonhop.com/manage.html?t=TOK');

    const noLink = new FakeEmailAdapter();
    await sendBookingConfirmation(single, noLink);
    expect(noLink.sent[0].html).not.toContain('manage.html');
  });
});

describe('sendRefundConfirmation', () => {
  it('emails the customer that a refund was processed, with reference + amount — once', async () => {
    const email = new FakeEmailAdapter();
    await sendRefundConfirmation(single, email);
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m.to).toBe('maya@example.com');
    expect(m.subject).toContain('CH-ABC12');
    expect(m.subject.toLowerCase()).toContain('refund');
    expect(m.html.toLowerCase()).toContain('refund');
    expect(m.html).toContain('$50.00');
  });

  it('includes a plain-text alternative with the reference and no markup', async () => {
    const email = new FakeEmailAdapter();
    await sendRefundConfirmation(single, email);
    const m = email.sent[0];
    expect(m.text).toContain('CH-ABC12');
    expect(m.text).not.toContain('<');
  });
});

// ── New lifecycle emails ────────────────────────────────────────────────────
import {
  sendPaymentIncomplete,
  sendBookingConfirmed,
  sendNoShowNotice,
  sendDetailsNeeded,
  needsDetails,
} from './notifications';

const pending: Booking = { ...single, id: 'idp', reference: 'CH-PEND1', status: 'payment_pending' };

describe('sendPaymentIncomplete — abandoned checkout recovery', () => {
  it('emails a finish-your-booking with the amount due and a resume link', async () => {
    const email = new FakeEmailAdapter();
    await sendPaymentIncomplete(pending, email, { resume: 'https://ceylonhop.com/manage.html?t=tok' });
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m.to).toBe('maya@example.com');
    expect(m.subject).toContain('CH-PEND1');
    expect(m.subject.toLowerCase()).toContain('finish');
    expect(m.html).toContain('$50.00');            // amount due
    expect(m.html).toContain('manage.html?t=tok'); // resume link
    expect(m.text).toContain('manage.html?t=tok');
    expect(m.text).not.toContain('<');
  });

  it('still renders without a resume link', async () => {
    const email = new FakeEmailAdapter();
    await sendPaymentIncomplete(pending, email);
    expect(email.sent[0].html).not.toContain('href="undefined"');
  });
});

describe('sendBookingConfirmed — driver arranged', () => {
  it('emails a confirmed message with route and a manage link', async () => {
    const email = new FakeEmailAdapter();
    await sendBookingConfirmed({ ...single, status: 'confirmed' }, email, { manage: 'https://ceylonhop.com/manage.html?t=xyz' });
    const m = email.sent[0];
    expect(m.subject).toContain('CH-ABC12');
    expect(m.subject.toLowerCase()).toContain('confirmed');
    expect(m.html).toContain('Colombo Airport');
    expect(m.html).toContain('Confirmed');
    expect(m.html.toLowerCase()).toContain('whatsapp');
    expect(m.html).toContain('manage.html?t=xyz');
  });
});

describe('sendNoShowNotice — fare forfeited', () => {
  it('states the fare is not refundable and offers rebooking', async () => {
    const email = new FakeEmailAdapter();
    await sendNoShowNotice({ ...single, status: 'no_show' }, email);
    const m = email.sent[0];
    expect(m.subject).toContain('CH-ABC12');
    expect(m.html.toLowerCase()).toContain("isn’t refundable");
    expect((m.text ?? "").toLowerCase()).toContain("isn’t refundable");
    expect(m.text).not.toContain('<');
  });
});

describe('sendDetailsNeeded — flexible booking follow-up', () => {
  it('says we still need the exact pickup/time and will reach out on WhatsApp', async () => {
    const email = new FakeEmailAdapter();
    await sendDetailsNeeded(single, email, { manage: 'https://ceylonhop.com/manage.html?t=abc' });
    const m = email.sent[0];
    expect(m.subject).toContain('CH-ABC12');
    expect(m.subject.toLowerCase()).toContain('detail');
    expect(m.html.toLowerCase()).toContain('whatsapp');
    expect(m.html.toLowerCase()).toContain('pickup');
    expect(m.text).not.toContain('<');
  });
});

describe('needsDetails', () => {
  it('true for a single transfer with no date, false once a date is set', () => {
    expect(needsDetails(single)).toBe(true); // fixture has no date
    expect(needsDetails({ ...single, input: { ...single.input, date: '2026-08-01' } } as Booking)).toBe(false);
  });
  it('true for a trip with no dates, false when a date exists', () => {
    const noDates: Booking = {
      ...single, mode: 'trip', reference: 'CH-T', id: 'idt',
      input: { stops: ['A', 'B'], nights: [0, 0], dates: [], pax: 2, vehicleType: 'car', serviceType: 'private', customer: single.input.customer },
    } as Booking;
    expect(needsDetails(noDates)).toBe(true);
    expect(needsDetails({ ...noDates, input: { ...(noDates.input as object), dates: ['2026-08-01'] } } as Booking)).toBe(false);
  });
  it('false for shared (always a fixed departure)', () => {
    const shared: Booking = {
      ...single, mode: 'shared', reference: 'CH-S', id: 'ids',
      input: { corridorId: 'cmb-galle', date: '2026-07-10', time: '08:00', seats: 2, customer: single.input.customer },
    } as Booking;
    expect(needsDetails(shared)).toBe(false);
  });
});

// Faithful itinerary rendering across the website-bookable shapes.
describe('itinerary rendering — website booking shapes', () => {
  it('single transfer renders selected extras and bag count', async () => {
    const email = new FakeEmailAdapter();
    const b: Booking = { ...single, input: { ...single.input, bags: 3, extras: ['sightseeing'] } };
    await sendBookingConfirmation(b, email);
    const m = email.sent[0];
    expect(m.html).toContain('Sightseeing stops');
    expect(m.html).toContain('3 bags');
    expect(m.text).toContain('Sightseeing stops');
  });

  it('chauffeur trip renders the multi-day duration', async () => {
    const email = new FakeEmailAdapter();
    const b: Booking = {
      ...single, mode: 'trip', reference: 'CH-CHA', id: 'idc',
      input: { stops: ['Colombo', 'Kandy', 'Ella'], nights: [0, 2, 1], dates: ['2026-08-09', '2026-08-11'], pax: 3, vehicleType: 'van', serviceType: 'chauffeur', days: 6, driverNights: 5, customer: single.input.customer },
    } as Booking;
    await sendBookingConfirmation(b, email);
    expect(email.sent[0].html).toContain('Duration');
    expect(email.sent[0].html).toContain('6 days');
  });

  it('multi-stop trip renders per-stop nights and per-leg travel dates', async () => {
    const email = new FakeEmailAdapter();
    const b: Booking = {
      ...single, mode: 'trip', reference: 'CH-MUL', id: 'idm',
      input: { stops: ['Colombo Fort', 'Kandy', 'Ella'], nights: [0, 2, 0], dates: ['2026-08-09', '2026-08-11'], pax: 2, vehicleType: 'car', serviceType: 'private', customer: single.input.customer },
    } as Booking;
    await sendBookingConfirmation(b, email);
    const html = email.sent[0].html;
    expect(html).toContain('2 nights');
    expect(html).toContain('depart');
  });

  it('round trip (origin repeated) labels the final stop as a return', async () => {
    const email = new FakeEmailAdapter();
    const b: Booking = {
      ...single, mode: 'trip', reference: 'CH-RND', id: 'idr',
      input: { stops: ['Kandy', 'Sigiriya', 'Kandy'], nights: [0, 1, 0], dates: ['2026-08-09', '2026-08-10'], pax: 2, vehicleType: 'car', serviceType: 'private', customer: single.input.customer },
    } as Booking;
    await sendBookingConfirmation(b, email);
    expect(email.sent[0].html).toContain('Return');
  });
});

describe('sendPaymentFailed', () => {
  it('emails a retry nudge with the amount due and a resume link, plus plaintext', async () => {
    const email = new FakeEmailAdapter();
    await sendPaymentFailed(single, email, { resume: 'https://ceylonhop.com/booking.html?id=x' });
    const m = email.sent[0];
    expect(m.to).toBe('maya@example.com');
    expect(m.subject).toContain('CH-ABC12');
    expect(m.subject.toLowerCase()).toContain('didn’t go through');
    expect(m.html).toContain('Try payment again');
    expect(m.html).toContain('$50.00');
    expect(m.text).toContain('https://ceylonhop.com/booking.html?id=x');
    expect(m.text).not.toContain('<');
  });
});

describe('sendDepositReceived', () => {
  it('shows deposit paid + balance due and the balance in the message', async () => {
    const email = new FakeEmailAdapter();
    await sendDepositReceived({ ...single, total: 20000, amountDueNow: 5000 }, email);
    const m = email.sent[0];
    expect(m.subject.toLowerCase()).toContain('deposit');
    expect(m.html).toContain('Deposit paid');
    expect(m.html).toContain('Balance due');
    expect(m.html).toContain('$50.00'); // deposit
    expect(m.html).toContain('$150.00'); // balance
    expect(m.text).toContain('Balance due before travel: $150.00');
  });
});
