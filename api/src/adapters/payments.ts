import { createHmac, timingSafeEqual } from 'node:crypto';

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
  };
}

export interface WebhookEvent {
  orderId: string;
  amount: number;
  currency: string;
  status: 'succeeded' | 'failed';
  providerTxnId: string;
}

interface WebhookBody extends WebhookEvent {
  signature: string;
}

// The swappable payment seam. The real PayHere adapter implements the same interface
// later (Phase 1.5); until then the fake drives the whole flow with a signed webhook,
// so no real gateway is ever called.
export interface PaymentAdapter {
  readonly provider: string;
  createCheckout(args: CreateCheckoutArgs): Promise<CheckoutParams>;
  // Verify + parse a raw webhook body. Returns null when the signature is invalid.
  parseWebhook(rawBody: string): WebhookEvent | null;
}

const DEFAULT_SECRET = process.env.FAKE_PAYMENT_SECRET ?? 'fake-secret';

function canonical(e: WebhookEvent): string {
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

  constructor(private readonly secret: string = DEFAULT_SECRET) {}

  private sign(e: WebhookEvent): string {
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
    const event: WebhookEvent = {
      orderId: args.orderId,
      amount: args.amount,
      currency: args.currency,
      status: args.status ?? 'succeeded',
      providerTxnId: args.providerTxnId ?? `txn_${args.orderId}`,
    };
    return JSON.stringify({ ...event, signature: this.sign(event) });
  }

  parseWebhook(rawBody: string): WebhookEvent | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (!isWebhookBody(parsed)) return null;
    const { signature, ...event } = parsed;
    return safeEqual(signature, this.sign(event)) ? event : null;
  }
}
