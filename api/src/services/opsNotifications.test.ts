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
