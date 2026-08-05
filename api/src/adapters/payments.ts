import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Constant-time string compare (length-guarded — timingSafeEqual throws on unequal lengths).
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface CheckoutParams {
  provider: string;
  orderId: string;
  amount: number; // minor units
  currency: string;
  checkoutUrl: string;
  fields?: Record<string, string>; // form fields the browser POSTs (PayHere)
}

export interface CreateCheckoutArgs {
  orderId: string;
  amount: number; // minor units
  currency: string;
  items?: string;
  /**
   * Where the gateway sends the customer afterwards, for THIS checkout. Omitted, the adapter's
   * constructor URLs apply — which are the website checkout's pages, and the wrong destination
   * for a pay-link customer. Never part of the payment hash.
   */
  returnUrl?: string;
  cancelUrl?: string;
  customer?: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    country: string;
    // Billing address, when the booking captured one (pay page, 2026-08-01). Absent on
    // website bookings — the adapter then omits the fields entirely so the gateway collects
    // them, instead of sending the placeholder it used to.
    address?: string;
    city?: string;
    /** Appended to the address line — PayHere has no postcode parameter of its own. */
    postcode?: string;
    /** Likewise: no state parameter exists, so it joins the postcode on the address line. */
    state?: string;
  };
}

export type ProviderPaymentStatus = 'succeeded' | 'pending' | 'cancelled' | 'failed' | 'charged_back';

export interface VerifiedPaymentEvent {
  provider: 'fake' | 'payhere';
  merchantId: string;
  orderId: string;
  providerTxnId: string;
  amountCents: number;
  currency: string;
  status: ProviderPaymentStatus;
  providerStatusCode: string;
  receivedAt: Date;
  payloadSha256: string;
  sanitizedPayload: Record<string, string>;
}

interface FakeWebhookEvent {
  orderId: string;
  amount: number;
  currency: string;
  status: 'succeeded' | 'failed';
  providerTxnId: string;
}

interface WebhookBody extends FakeWebhookEvent {
  signature: string;
}

// The swappable payment seam. The real PayHere adapter implements the same interface
// later (Phase 1.5); until then the fake drives the whole flow with a signed webhook,
// so no real gateway is ever called.
// Why a webhook body was refused. `parseWebhook` returns a bare null, which is enough to reject
// the request and nowhere near enough to debug one: a genuine PayHere notify that trips a field
// rule and a bot probing the public endpoint raised the identical "invalid signature —
// misconfigured merchant secret or someone probing" alert (owner-reported, 2026-08-02). Only
// `signature_mismatch` implicates the secret; every other reason means we refused something the
// gateway may well have meant.
//
// The breadcrumbs are best-effort — a rejected body is by definition untrusted, so they are read
// without verifying anything and must never drive control flow. They exist so the alert can say
// WHICH order this was about. All non-PII: the notify's card_holder_name/card_no/card_expiry are
// never read here, same stance as `sanitizedPayload`.
export interface WebhookRejection {
  /** Stable machine name, e.g. 'signature_mismatch', 'amount_malformed'. Safe as a dedupe key. */
  reason: string;
  /** Of the raw body, so two alerts can be told apart (or matched) without logging the body. */
  bodySha256: string;
  orderId?: string;
  statusCode?: string;
  amount?: string;
  currency?: string;
}

// The outcome of asking the gateway to refund. `unknown` is the whole reason this type exists:
// PayHere's Refund API has no idempotency key, so a call that times out CANNOT be retried — the
// refund may already have happened. `unknown` means "a human must look", never "try again".
export type RefundOutcome = 'succeeded' | 'failed' | 'unknown';

export interface RefundResult {
  outcome: RefundOutcome;
  /** PayHere's refund number (`data`). Present only on 'succeeded'. */
  gatewayRef?: string;
  /** PayHere's `msg`, or our own description of an indefinite failure. Diagnostic only. */
  providerMessage?: string;
}

export interface RefundArgs {
  /** The GATEWAY's payment id (PayHere `payment_id`), not our payments.id. */
  gatewayPaymentId: string;
  amountCents: number;
  currency: string;
  /** Sent as `description`; the ops agent's reason, which is also our audit trail. */
  description: string;
  /** Full refunds omit `amount` entirely, per PayHere's docs. */
  isFullRefund: boolean;
}

export interface PaymentAdapter {
  readonly provider: string;
  createCheckout(args: CreateCheckoutArgs): Promise<CheckoutParams>;
  // Verify + parse a raw webhook body. Returns null when the signature is invalid.
  parseWebhook(rawBody: string): VerifiedPaymentEvent | null;
  // Optional: explain a body parseWebhook refused. Adapters that omit it stay opaque, and the
  // caller falls back to the old undifferentiated alert.
  describeWebhookRejection?(rawBody: string): WebhookRejection | null;
  // Optional: refund through the gateway's API. An adapter without it means the ops UI offers
  // the manual dashboard flow only, which is a supported state, not a degraded one.
  refund?(args: RefundArgs): Promise<RefundResult>;
}

const DEFAULT_SECRET = process.env.FAKE_PAYMENT_SECRET ?? 'fake-secret';

function canonical(e: FakeWebhookEvent): string {
  return [e.orderId, e.amount, e.currency, e.status, e.providerTxnId].join('|');
}

function isWebhookBody(v: unknown): v is WebhookBody {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.orderId === 'string' &&
    typeof o.amount === 'number' &&
    typeof o.currency === 'string' &&
    (o.status === 'succeeded' || o.status === 'failed') &&
    typeof o.providerTxnId === 'string' &&
    typeof o.signature === 'string'
  );
}

export class FakePaymentAdapter implements PaymentAdapter {
  readonly provider = 'fake';

  constructor(private readonly secret: string = DEFAULT_SECRET) {
    // DEFAULT_SECRET is a constant in this repo, so a fake adapter in production would let
    // anyone sign their own "succeeded" webhook. config.ts refuses to boot without PayHere
    // credentials; this is the second lock, in case something constructs one directly.
    // A non-production deployment that still runs NODE_ENV=production (staging on Render) opts
    // out explicitly with ALLOW_FAKE_PAYMENTS — never set that where real money moves.
    const optedOut = ['1', 'true', 'yes'].includes(String(process.env.ALLOW_FAKE_PAYMENTS ?? '').trim().toLowerCase());
    if (process.env.NODE_ENV === 'production' && !optedOut) {
      throw new Error('FakePaymentAdapter must never be used in production — configure PayHere credentials');
    }
  }

  private sign(e: FakeWebhookEvent): string {
    return createHmac('sha256', this.secret).update(canonical(e)).digest('hex');
  }

  async createCheckout(args: CreateCheckoutArgs): Promise<CheckoutParams> {
    return {
      provider: this.provider,
      orderId: args.orderId,
      amount: args.amount,
      currency: args.currency,
      checkoutUrl: `https://sandbox.fake-pay.local/checkout/${args.orderId}`,
    };
  }

  // Test/dev helper: build a correctly-signed webhook body for an order.
  simulateWebhook(args: {
    orderId: string;
    amount: number;
    currency: string;
    status?: 'succeeded' | 'failed';
    providerTxnId?: string;
  }): string {
    const event: FakeWebhookEvent = {
      orderId: args.orderId,
      amount: args.amount,
      currency: args.currency,
      status: args.status ?? 'succeeded',
      providerTxnId: args.providerTxnId ?? `txn_${args.orderId}`,
    };
    return JSON.stringify({ ...event, signature: this.sign(event) });
  }

  parseWebhook(rawBody: string): VerifiedPaymentEvent | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (!isWebhookBody(parsed)) return null;
    const { signature, ...event } = parsed;
    if (!safeEqual(signature, this.sign(event))) return null;
    return {
      provider: this.provider,
      merchantId: 'fake',
      orderId: event.orderId,
      providerTxnId: event.providerTxnId,
      amountCents: event.amount,
      currency: event.currency,
      status: event.status,
      providerStatusCode: event.status,
      receivedAt: new Date(),
      payloadSha256: createHash('sha256').update(rawBody).digest('hex'),
      sanitizedPayload: {
        orderId: event.orderId,
        amount: String(event.amount),
        currency: event.currency,
        status: event.status,
        providerTxnId: event.providerTxnId,
      },
    };
  }
}
