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

// v2, compact (2026-08-02). The v1 JSON form produced a 208-character URL — a base64 blob
// arriving right before a request for money, which reads like phishing. Three sources of waste,
// all removed here:
//   • `"purpose":"quote-pay"` cost 21 characters of JSON to say one byte
//   • the uuid travelled as 36 characters of hex-with-dashes for 16 bytes of data
//   • the HMAC was 64 hex characters; hex wastes half, and 256 bits is far past what a
//     capability token needs — 128 is the standard truncation and is infeasible to forge
// Packed as bytes: 1 version + 1 purpose + 16 uuid + 2 revision = 20 bytes → 27 base64url
// chars, plus a 22-char truncated signature. ~80 characters all in.
const PURPOSE_QUOTE_PAY = 0x01;
const SIG_BYTES = 16; // 128-bit truncated HMAC
const MAX_REVISION = 0xffff;

const b64url = (b: Buffer): string => b.toString('base64url');

function macBytes(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(body).digest().subarray(0, SIG_BYTES);
}

export function signQuotePayToken(quoteId: string, revision: number, secret: string): string {
  // A revision beyond 65535 would silently wrap, so fall back to v1 rather than mint a token
  // pointing at the wrong revision. Unreachable in practice; cheap to be certain.
  const hex = quoteId.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-f]+$/i.test(hex) || revision < 1 || revision > MAX_REVISION) {
    return signedBody({ v: 1, purpose: 'quote-pay', q: quoteId, r: revision }, secret);
  }
  const buf = Buffer.alloc(20);
  buf.writeUInt8(2, 0);                       // version
  buf.writeUInt8(PURPOSE_QUOTE_PAY, 1);       // disjoint from the other token kinds
  Buffer.from(hex, 'hex').copy(buf, 2);       // uuid, raw
  buf.writeUInt16BE(revision, 18);
  const body = b64url(buf);
  return `${body}.${b64url(macBytes(body, secret))}`;
}

/** v2 only; returns null for anything else so the caller can fall back to v1. */
function verifyV2(token: string, secret: string): { quoteId: string; revision: number } | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(body, 'base64url');
  } catch {
    return null;
  }
  if (buf.length !== 20 || buf.readUInt8(0) !== 2 || buf.readUInt8(1) !== PURPOSE_QUOTE_PAY) return null;
  const expected = b64url(macBytes(body, secret));
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const hex = buf.subarray(2, 18).toString('hex');
  const quoteId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const revision = buf.readUInt16BE(18);
  return revision >= 1 ? { quoteId, revision } : null;
}

export function verifyQuotePayToken(
  token: string | undefined,
  secret: string,
): { quoteId: string; revision: number } | null {
  if (!token) return null;
  // v2 first, then v1 — links already sitting in customers' WhatsApp threads must keep working.
  const v2 = verifyV2(token, secret);
  if (v2) return v2;
  const parsed = verifiedPayload(token, secret) as {
    v?: unknown; purpose?: unknown; q?: unknown; r?: unknown;
  } | null;
  if (!parsed || parsed.v !== 1 || parsed.purpose !== 'quote-pay') return null;
  if (typeof parsed.q !== 'string' || parsed.q.length === 0) return null;
  if (typeof parsed.r !== 'number' || !Number.isInteger(parsed.r) || parsed.r < 1) return null;
  return { quoteId: parsed.q, revision: parsed.r };
}
