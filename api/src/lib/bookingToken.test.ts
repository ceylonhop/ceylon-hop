import { describe, it, expect } from 'vitest';
import { signBookingToken, verifyBookingToken } from './bookingToken';

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
