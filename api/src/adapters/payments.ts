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
export interface PaymentAdapter {
  readonly provider: string;
  createCheckout(args: CreateCheckoutArgs): Promise<CheckoutParams>;
  // Verify + parse a raw webhook body. Returns null when the signature is invalid.
  parseWebhook(rawBody: string): VerifiedPaymentEvent | null;
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
