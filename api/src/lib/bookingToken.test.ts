import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  CHECKOUT_TOKEN_TTL_MS,
  signBookingToken,
  signCheckoutToken,
  verifyBookingToken,
  verifyCheckoutToken,
  signQuotePayToken,
  verifyQuotePayToken,
} from './bookingToken';

const S = 'test-secret';

describe('bookingToken', () => {
  it('round-trips a booking id', () => {
    const t = signBookingToken('abc-123', S);
    expect(verifyBookingToken(t, S)).toBe('abc-123');
  });

  it('rejects a tampered body (forged id, kept signature)', () => {
    const t = signBookingToken('abc-123', S);
    const sig = t.split('.')[1];
    const forgedBody = Buffer.from(JSON.stringify({ id: 'other' })).toString('base64url');
    expect(verifyBookingToken(`${forgedBody}.${sig}`, S)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const t = signBookingToken('abc-123', S);
    const last = t.slice(-1);
    expect(verifyBookingToken(t.slice(0, -1) + (last === '0' ? '1' : '0'), S)).toBeNull();
  });

  it('rejects a wrong secret', () => {
    const t = signBookingToken('abc-123', S);
    expect(verifyBookingToken(t, 'other-secret')).toBeNull();
  });

  it('rejects undefined / empty / no-dot / garbage input', () => {
    expect(verifyBookingToken(undefined, S)).toBeNull();
    expect(verifyBookingToken('', S)).toBeNull();
    expect(verifyBookingToken('no-dot-here', S)).toBeNull();
    expect(verifyBookingToken('....', S)).toBeNull();
  });
});

describe('checkout capability token', () => {
  const NOW = Date.UTC(2026, 6, 28, 12);

  it('round-trips only for its version, purpose, booking, and lifetime', () => {
    const token = signCheckoutToken('booking-1', S, NOW);
    expect(verifyCheckoutToken(token, 'booking-1', S, NOW)).toBe(true);
    expect(verifyCheckoutToken(token, 'booking-2', S, NOW)).toBe(false);
    expect(verifyCheckoutToken(token, 'booking-1', 'wrong-secret', NOW)).toBe(false);
    expect(verifyCheckoutToken(token, 'booking-1', S, NOW + CHECKOUT_TOKEN_TTL_MS - 1)).toBe(
      true,
    );
    expect(verifyCheckoutToken(token, 'booking-1', S, NOW + CHECKOUT_TOKEN_TTL_MS)).toBe(
      false,
    );
  });

  it('rejects missing, malformed, modified, and view-purpose tokens', () => {
    const token = signCheckoutToken('booking-1', S, NOW);
    const last = token.slice(-1);
    expect(verifyCheckoutToken(undefined, 'booking-1', S, NOW)).toBe(false);
    expect(verifyCheckoutToken('garbage', 'booking-1', S, NOW)).toBe(false);
    expect(
      verifyCheckoutToken(
        token.slice(0, -1) + (last === '0' ? '1' : '0'),
        'booking-1',
        S,
        NOW,
      ),
    ).toBe(false);
    expect(verifyCheckoutToken(signBookingToken('booking-1', S), 'booking-1', S, NOW)).toBe(
      false,
    );
  });
});

describe('quote pay token', () => {
  const S = 'link-secret';

  it('round-trips quote id and revision', () => {
    const t = signQuotePayToken('q-1', 3, S);
    expect(verifyQuotePayToken(t, S)).toEqual({ quoteId: 'q-1', revision: 3 });
  });

  it('rejects a wrong secret, tampering, and garbage', () => {
    const t = signQuotePayToken('q-1', 3, S);
    expect(verifyQuotePayToken(t, 'other-secret')).toBeNull();
    const last = t.at(-1)!;
    expect(verifyQuotePayToken(t.slice(0, -1) + (last === '0' ? '1' : '0'), S)).toBeNull();
    expect(verifyQuotePayToken('not-a-token', S)).toBeNull();
    expect(verifyQuotePayToken(undefined, S)).toBeNull();
  });

  it('never cross-verifies with the other token purposes', () => {
    // A checkout or view token must not open the pay page, and a pay token must not
    // authorise a checkout — same secret, disjoint purposes.
    expect(verifyQuotePayToken(signBookingToken('q-1', S), S)).toBeNull();
    expect(verifyQuotePayToken(signCheckoutToken('q-1', S), S)).toBeNull();
    expect(verifyBookingToken(signQuotePayToken('q-1', 1, S), S)).toBeNull();
    expect(verifyCheckoutToken(signQuotePayToken('q-1', 1, S), 'q-1', S, Date.now())).toBe(false);
  });

  it('pins the revision — a revised quote invalidates old links at the token layer', () => {
    const t = signQuotePayToken('q-1', 1, S);
    const parsed = verifyQuotePayToken(t, S)!;
    expect(parsed.revision).toBe(1);
    // The caller compares against quote.revision; a non-integer revision never verifies.
    const forged = signQuotePayToken('q-1', 1.5 as unknown as number, S);
    expect(verifyQuotePayToken(forged, S)).toBeNull();
  });
});

// Short pay links (owner, 2026-08-02). The v1 JSON token made a 208-character URL — a base64
// blob arriving right before a request for money, which is the visual grammar of phishing.
describe('quote pay token v2 — compact, and back-compatible', () => {
  const SECRET = 'test-link-secret';
  const QUOTE = '48ebe678-8b5c-49c1-a7f8-5dc5005e347b';

  it('is dramatically shorter than the v1 form it replaces', () => {
    const v2 = signQuotePayToken(QUOTE, 13, SECRET);
    const v1 = `${Buffer.from(JSON.stringify({ v: 1, purpose: 'quote-pay', q: QUOTE, r: 13 })).toString('base64url')}.${'a'.repeat(64)}`;
    expect(v2.length).toBeLessThan(v1.length / 2);
    expect(v2.length).toBeLessThan(55);
  });

  it('round-trips the quote id and revision exactly', () => {
    for (const rev of [1, 13, 255, 256, 65535]) {
      expect(verifyQuotePayToken(signQuotePayToken(QUOTE, rev, SECRET), SECRET))
        .toEqual({ quoteId: QUOTE, revision: rev });
    }
  });

  // THE back-compat guard: links already sitting in customers' WhatsApp threads were minted
  // in the v1 format. Breaking them would strand real people mid-payment.
  it('still verifies a v1 token, so links already sent keep working', () => {
    const body = Buffer.from(JSON.stringify({ v: 1, purpose: 'quote-pay', q: QUOTE, r: 13 })).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyQuotePayToken(`${body}.${sig}`, SECRET)).toEqual({ quoteId: QUOTE, revision: 13 });
  });

  it('refuses a tampered v2 token and one signed with another secret', () => {
    const t = signQuotePayToken(QUOTE, 13, SECRET);
    const [body, sig] = t.split('.');
    // flip a byte of the payload — the revision or quote id would change
    const bad = Buffer.from(body, 'base64url'); bad.writeUInt16BE(99, 18);
    expect(verifyQuotePayToken(`${bad.toString('base64url')}.${sig}`, SECRET)).toBeNull();
    expect(verifyQuotePayToken(t, 'another-secret')).toBeNull();
    expect(verifyQuotePayToken('garbage', SECRET)).toBeNull();
  });

  // The other two token kinds share the signing secret; a disjoint purpose byte is what stops
  // a booking token being replayed as a pay token.
  it('cannot be crossed with the booking token kind', () => {
    expect(verifyQuotePayToken(signBookingToken('some-booking-id', SECRET), SECRET)).toBeNull();
  });
});
