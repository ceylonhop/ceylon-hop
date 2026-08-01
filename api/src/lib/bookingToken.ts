import { createHmac, timingSafeEqual } from 'node:crypto';

// A view-only capability token for ONE booking. Same shape as the ops session cookie
// (opsAuth.ts): base64url(json).hmac, verified with timingSafeEqual. No expiry — a customer
// can reopen their booking anytime. Signed with a DEDICATED secret (BOOKING_LINK_SECRET) so
// it can never be cross-replayed with the ops session cookie.
function mac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function signedBody(payload: unknown, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

function verifiedPayload(token: string | undefined, secret: string): unknown | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = mac(body, secret);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function signBookingToken(bookingId: string, secret: string): string {
  return signedBody({ id: bookingId }, secret);
}

export function verifyBookingToken(token: string | undefined, secret: string): string | null {
  const parsed = verifiedPayload(token, secret);
  const id = (parsed as { id?: unknown })?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export const CHECKOUT_TOKEN_TTL_MS = 30 * 60 * 1000;

export function signCheckoutToken(
  bookingId: string,
  secret: string,
  nowMs = Date.now(),
): string {
  return signedBody(
    {
      v: 1,
      purpose: 'checkout',
      bookingId,
      exp: Math.floor((nowMs + CHECKOUT_TOKEN_TTL_MS) / 1000),
    },
    secret,
  );
}

export function verifyCheckoutToken(
  token: string | undefined,
  expectedBookingId: string,
  secret: string,
  nowMs = Date.now(),
): boolean {
  const parsed = verifiedPayload(token, secret) as {
    v?: unknown;
    purpose?: unknown;
    bookingId?: unknown;
    exp?: unknown;
  } | null;
  return !!(
    parsed &&
    parsed.v === 1 &&
    parsed.purpose === 'checkout' &&
    parsed.bookingId === expectedBookingId &&
    Number.isSafeInteger(parsed.exp) &&
    nowMs < (parsed.exp as number) * 1000
  );
}

// ── Quote pay link token (spec D7, 2026-07-31) ────────────────────────────────────────
// A bearer capability over ONE quote at ONE revision. Same signing primitive and secret
// as the booking/checkout tokens, but a disjoint `purpose`, so the three token kinds can
// never be replayed for each other. Deliberately NO expiry field: the link is payable
// only while the quote is ready|sent, so quote expiry/loss/deletion kills it — and the
// pinned revision means a quote edited after sending renders the "quote updated" state
// rather than silently charging a changed price.

export function signQuotePayToken(quoteId: string, revision: number, secret: string): string {
  return signedBody({ v: 1, purpose: 'quote-pay', q: quoteId, r: revision }, secret);
}

export function verifyQuotePayToken(
  token: string | undefined,
  secret: string,
): { quoteId: string; revision: number } | null {
  const parsed = verifiedPayload(token, secret) as {
    v?: unknown; purpose?: unknown; q?: unknown; r?: unknown;
  } | null;
  if (!parsed || parsed.v !== 1 || parsed.purpose !== 'quote-pay') return null;
  if (typeof parsed.q !== 'string' || parsed.q.length === 0) return null;
  if (typeof parsed.r !== 'number' || !Number.isInteger(parsed.r) || parsed.r < 1) return null;
  return { quoteId: parsed.q, revision: parsed.r };
}
