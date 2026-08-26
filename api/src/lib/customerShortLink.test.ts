import { describe, expect, it } from 'vitest';
import {
  customerShortCode,
  customerShortCodeDigest,
  isCustomerShortCode,
} from './customerShortLink';

const SECRET = 'short-link-test-secret';
const QUOTE_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('customer short-link capability codes', () => {
  it('derives an exact 16-character base64url code deterministically', () => {
    const target = { kind: 'quote_view' as const, quoteId: QUOTE_ID };
    const a = customerShortCode(target, SECRET);
    const b = customerShortCode(target, SECRET);

    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it('keeps a following quote-view code independent of quote revision', () => {
    const target = { kind: 'quote_view' as const, quoteId: QUOTE_ID };
    const oldRevision = { ...target, revision: 1 };
    const newRevision = { ...target, revision: 99 };
    expect(customerShortCode(oldRevision, SECRET)).toBe(customerShortCode(newRevision, SECRET));
  });

  it('domain-separates kind, quote, revision, and payment selection', () => {
    const codes = new Set([
      customerShortCode({ kind: 'quote_view', quoteId: QUOTE_ID }, SECRET),
      customerShortCode({ kind: 'quote_view', quoteId: OTHER_ID }, SECRET),
      customerShortCode({ kind: 'quote_pay', quoteId: QUOTE_ID, revision: 1, seq: 0 }, SECRET),
      customerShortCode({ kind: 'quote_pay', quoteId: QUOTE_ID, revision: 2, seq: 0 }, SECRET),
      customerShortCode({ kind: 'quote_pay', quoteId: QUOTE_ID, revision: 2, seq: 1 }, SECRET),
    ]);
    expect(codes.size).toBe(5);
  });

  it('stores a stable digest rather than the bearer code', () => {
    const code = customerShortCode({ kind: 'quote_view', quoteId: QUOTE_ID }, SECRET);
    const digest = customerShortCodeDigest(code);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toBe(code);
    expect(customerShortCodeDigest(code)).toBe(digest);
  });

  it('accepts only the exact public code shape', () => {
    expect(isCustomerShortCode('AbCdEf0123_-xyZW')).toBe(true);
    for (const invalid of ['', 'short', 'A'.repeat(15), 'A'.repeat(17), 'A'.repeat(15) + '.', 'é'.repeat(16)]) {
      expect(isCustomerShortCode(invalid), invalid).toBe(false);
    }
  });
});
