import { describe, it, expect } from 'vitest';
import { experienceConfirmedEmail, type ExperienceConfirmedView } from './notifications';

// Experience confirmation email (spec 2026-10-06 D21): sent only when ops presses the button, once the
// date, time and meeting point are final.
const VIEW: ExperienceConfirmedView = {
  reference: 'CH-4821',
  customerFirstName: 'Maya',
  experienceName: 'Ayurvedic massage',
  partnerName: 'Atherya Spa',
  scheduledDate: '2026-11-21',
  scheduledTime: '09:30',
  meetingPoint: 'Hotel lobby, Sigiriya Village',
  amountPaidCents: 3500,
  amountPaidCurrency: 'USD',
  paymentRef: 'PH-123456',
};

describe('experienceConfirmedEmail', () => {
  it('subject names the experience and the date', () => {
    expect(experienceConfirmedEmail(VIEW).subject).toBe('Confirmed: Ayurvedic massage on Sat 21 Nov');
  });

  it('html carries every fact the customer needs', () => {
    const { html } = experienceConfirmedEmail(VIEW);
    for (const s of ['Maya', 'Ayurvedic massage', 'Atherya Spa', 'Sat 21 Nov 2026', '09:30', 'Hotel lobby, Sigiriya Village', '$35.00', 'PH-123456', 'CH-4821',
      'Free cancellation up to 24 hours before the experience date.', 'https://wa.me/94779669662']) {
      expect(html, s).toContain(s);
    }
  });

  it('text carries the same facts', () => {
    const { text } = experienceConfirmedEmail(VIEW);
    for (const s of ['Hi Maya', 'Ayurvedic massage', 'Atherya Spa', 'Sat 21 Nov 2026', '09:30', 'Hotel lobby, Sigiriya Village', '$35.00', 'PH-123456', 'CH-4821',
      'Free cancellation up to 24 hours before the experience date.', 'https://wa.me/94779669662']) {
      expect(text, s).toContain(s);
    }
  });

  it('states the time is Sri Lanka local time', () => {
    expect(experienceConfirmedEmail(VIEW).html).toMatch(/Sri Lanka time/);
    expect(experienceConfirmedEmail(VIEW).text).toMatch(/Sri Lanka time/);
  });

  it('leaves out the meeting point, partner, amount and reference when there are none', () => {
    const { html, text } = experienceConfirmedEmail({
      ...VIEW, partnerName: undefined, meetingPoint: null, amountPaidCents: null, amountPaidCurrency: null, paymentRef: null,
    });
    for (const out of [html, text]) {
      expect(out).not.toMatch(/Meeting point/i);
      expect(out).not.toMatch(/Amount paid/i);
      expect(out).not.toMatch(/PayHere/i);
      expect(out).not.toMatch(/Atherya/);
    }
    expect(html).toContain('Free cancellation up to 24 hours before the experience date.');
  });

  it('shows a reference but no amount line when only the reference was recorded', () => {
    const { html, text } = experienceConfirmedEmail({ ...VIEW, amountPaidCents: null, amountPaidCurrency: null });
    expect(html).not.toMatch(/Amount paid/i);
    expect(text).not.toMatch(/Amount paid/i);
    expect(html).toContain('PH-123456');
  });

  it('escapes everything ops or the customer typed in the html', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { html } = experienceConfirmedEmail({
      ...VIEW, customerFirstName: evil, experienceName: evil, partnerName: evil, meetingPoint: evil, paymentRef: evil, reference: evil,
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('falls back politely when the customer has no first name', () => {
    const { html, text } = experienceConfirmedEmail({ ...VIEW, customerFirstName: '' });
    expect(text).toContain('Hi there');
    expect(html).not.toMatch(/, !/);
  });

  it('a bad stored date is shown as typed rather than throwing', () => {
    expect(() => experienceConfirmedEmail({ ...VIEW, scheduledDate: 'nope' })).not.toThrow();
  });
});
