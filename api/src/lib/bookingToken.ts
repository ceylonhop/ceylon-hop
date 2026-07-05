import { createHmac, timingSafeEqual } from 'node:crypto';

// A view-only capability token for ONE booking. Same shape as the ops session cookie
// (opsAuth.ts): base64url(json).hmac, verified with timingSafeEqual. No expiry — a customer
// can reopen their booking anytime. Signed with a DEDICATED secret (BOOKING_LINK_SECRET) so
// it can never be cross-replayed with the ops session cookie.
function mac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function signBookingToken(bookingId: string, secret: string): string {
  const body = Buffer.from(JSON.stringify({ id: bookingId })).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

export function verifyBookingToken(token: string | undefined, secret: string): string | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = mac(body, secret);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const id = (parsed as { id?: unknown })?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
