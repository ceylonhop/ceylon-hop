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
const PURPOSE_QUOTE_VIEW = 0x02; // disjoint from PURPOSE_QUOTE_PAY — see signQuoteViewToken
const SIG_BYTES = 16; // 128-bit truncated HMAC
const MAX_REVISION = 0xffff;
const MAX_SEQ = 0xffff;

const b64url = (b: Buffer): string => b.toString('base64url');

function macBytes(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(body).digest().subarray(0, SIG_BYTES);
}

// v3 (2026-08-04) adds a 2-byte SELECTION SEQ, so a partial link can be retired when ops re-picks
// which legs it covers — without editing the quote, which is what the revision already covers.
// seq 0 = "the full quote", which is what every pre-v3 link means.
// Packed: 1 version + 1 purpose + 16 uuid + 2 revision + 2 seq = 22 bytes.
export function signQuotePayToken(
  quoteId: string,
  revision: number,
  secret: string,
  seq = 0,
): string {
  // A revision or seq beyond 65535 would silently wrap, so fall back to v1 rather than mint a
  // token pointing at the wrong one. Unreachable in practice; cheap to be certain.
  const hex = quoteId.replace(/-/g, '');
  if (
    hex.length !== 32 || !/^[0-9a-f]+$/i.test(hex) ||
    revision < 1 || revision > MAX_REVISION ||
    seq < 0 || seq > MAX_SEQ
  ) {
    return signedBody({ v: 1, purpose: 'quote-pay', q: quoteId, r: revision, s: seq }, secret);
  }
  const buf = Buffer.alloc(22);
  buf.writeUInt8(3, 0);                       // version
  buf.writeUInt8(PURPOSE_QUOTE_PAY, 1);       // disjoint from the other token kinds
  Buffer.from(hex, 'hex').copy(buf, 2);       // uuid, raw
  buf.writeUInt16BE(revision, 18);
  buf.writeUInt16BE(seq, 20);
  const body = b64url(buf);
  return `${body}.${b64url(macBytes(body, secret))}`;
}

/** v2 (20 bytes, no seq) and v3 (22 bytes, seq). Returns null for anything else. */
function verifyPacked(
  token: string,
  secret: string,
): { quoteId: string; revision: number; seq: number } | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(body, 'base64url');
  } catch {
    return null;
  }
  const version = buf.length === 20 ? 2 : buf.length === 22 ? 3 : 0;
  if (!version || buf.readUInt8(0) !== version || buf.readUInt8(1) !== PURPOSE_QUOTE_PAY) return null;
  const expected = b64url(macBytes(body, secret));
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const hex = buf.subarray(2, 18).toString('hex');
  const quoteId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const revision = buf.readUInt16BE(18);
  if (revision < 1) return null;
  // A v2 token predates selections entirely, so it can only mean the full quote: seq 0.
  return { quoteId, revision, seq: version === 3 ? buf.readUInt16BE(20) : 0 };
}

export function verifyQuotePayToken(
  token: string | undefined,
  secret: string,
): { quoteId: string; revision: number; seq: number } | null {
  if (!token) return null;
  // v3/v2 first, then v1 — links already sitting in customers' WhatsApp threads must keep working.
  const packed = verifyPacked(token, secret);
  if (packed) return packed;
  const parsed = verifiedPayload(token, secret) as {
    v?: unknown; purpose?: unknown; q?: unknown; r?: unknown; s?: unknown;
  } | null;
  if (!parsed || parsed.v !== 1 || parsed.purpose !== 'quote-pay') return null;
  if (typeof parsed.q !== 'string' || parsed.q.length === 0) return null;
  if (typeof parsed.r !== 'number' || !Number.isInteger(parsed.r) || parsed.r < 1) return null;
  const seq = typeof parsed.s === 'number' && Number.isInteger(parsed.s) && parsed.s >= 0 ? parsed.s : 0;
  return { quoteId: parsed.q, revision: parsed.r, seq };
}

// ── the quote VIEW token (spec 2026-08-05 D3) ────────────────────────────────────────────────
// The quote link FOLLOWS its quote; only the pay token pins. So this token carries NO revision
// and NO seq — following is a property of the type, not a branch in the code, and there is no
// path by which this one could be made to pin. Liveness is read from the quote's status (D8).
//
// Deterministic by construction, which is what makes "copy the link twice, get the same URL"
// free — ops re-pastes the link into the thread rather than making the customer scroll.
//
// Packed: 1 version + 1 purpose + 16 uuid = 18 bytes. The purpose byte is disjoint from the pay
// token's, so neither can be spent as the other even though both are HMACs over the same secret.
export function signQuoteViewToken(quoteId: string, secret: string): string {
  const hex = quoteId.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-f]+$/i.test(hex)) {
    return signedBody({ v: 1, purpose: 'quote-view', q: quoteId }, secret);
  }
  const buf = Buffer.alloc(18);
  buf.writeUInt8(1, 0);
  buf.writeUInt8(PURPOSE_QUOTE_VIEW, 1);
  Buffer.from(hex, 'hex').copy(buf, 2);
  const body = b64url(buf);
  return `${body}.${b64url(macBytes(body, secret))}`;
}

export function verifyQuoteViewToken(
  token: string | undefined,
  secret: string,
): { quoteId: string } | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (body && sig) {
    let buf: Buffer | null = null;
    try {
      buf = Buffer.from(body, 'base64url');
    } catch {
      buf = null;
    }
    if (buf && buf.length === 18 && buf.readUInt8(0) === 1 && buf.readUInt8(1) === PURPOSE_QUOTE_VIEW) {
      const expected = b64url(macBytes(body, secret));
      if (sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        const hex = buf.subarray(2, 18).toString('hex');
        return {
          quoteId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
        };
      }
      return null;
    }
  }
  const parsed = verifiedPayload(token, secret) as { v?: unknown; purpose?: unknown; q?: unknown } | null;
  if (!parsed || parsed.v !== 1 || parsed.purpose !== 'quote-view') return null;
  if (typeof parsed.q !== 'string' || parsed.q.length === 0) return null;
  return { quoteId: parsed.q };
}

// ── the return leg of a redirect checkout (spec: docs/checkout-redirect-spec.md §D4) ──────────
// `return_url` is handed to PayHere, stored in their systems, and travels through a redirect
// chain that we do not control. So it must NOT carry the quote pay token: that one is a bearer
// credential for the whole quote. This token authorises exactly one thing — reading the
// settlement status of ONE booking — and carries a `purpose` disjoint from every other kind, so
// none of them can be spent as another.
//
// Deliberately NO expiry. A customer who pays and then loses signal for ten minutes must still
// land on their confirmation, and the token grants no more than the page it returns to.
//
// The field is `b`, not `id`: `verifyBookingToken` reads `id`, and reusing the name would let a
// pay-return token be spent as a booking view token.
export function signPayReturnToken(bookingId: string, secret: string): string {
  return signedBody({ v: 1, purpose: 'pay-return', b: bookingId }, secret);
}

export function verifyPayReturnToken(token: string | undefined, secret: string): string | null {
  const parsed = verifiedPayload(token, secret) as
    | { v?: unknown; purpose?: unknown; b?: unknown }
    | null;
  if (!parsed || parsed.v !== 1 || parsed.purpose !== 'pay-return') return null;
  return typeof parsed.b === 'string' && parsed.b.length > 0 ? parsed.b : null;
}
