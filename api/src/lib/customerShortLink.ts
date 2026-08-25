import { createHash, createHmac } from 'node:crypto';
import type { CustomerShortLinkTarget } from '../db/customerShortLinkRepo';

const CODE_BYTES = 12;
const CODE_PATTERN = /^[A-Za-z0-9_-]{16}$/;

function semanticKey(target: CustomerShortLinkTarget): string {
  if (target.kind === 'quote_view') return `short:v1:quote-view:${target.quoteId}`;
  return `short:v1:quote-pay:${target.quoteId}:r${target.revision}:s${target.seq}`;
}

/** A deterministic 96-bit bearer capability for one existing customer-link target. */
export function customerShortCode(target: CustomerShortLinkTarget, secret: string): string {
  return createHmac('sha256', secret)
    .update(semanticKey(target))
    .digest()
    .subarray(0, CODE_BYTES)
    .toString('base64url');
}

/** Stored instead of the bearer code, so a database read does not reveal usable links. */
export function customerShortCodeDigest(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function isCustomerShortCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

/**
 * The public alias URL for a code. `base` is the kind-correct customer origin — pay codes on the
 * pay host, quote codes on the quote host — so the link a customer reads matches what it does.
 */
export function customerShortUrl(base: string, code: string): string {
  return `${base.replace(/\/+$/, '')}/s/${code}`;
}
