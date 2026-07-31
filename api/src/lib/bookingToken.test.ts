import { describe, it, expect } from 'vitest';
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
