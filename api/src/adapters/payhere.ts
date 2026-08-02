import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  PaymentAdapter,
  CheckoutParams,
  CreateCheckoutArgs,
  ProviderPaymentStatus,
  VerifiedPaymentEvent,
} from './payments';

const md5Upper = (s: string): string => createHash('md5').update(s).digest('hex').toUpperCase();
const MAX_WEBHOOK_BYTES = 8_192;
const MAX_AMOUNT_MAJOR_UNITS = 999_999_999;

const statusByCode: Readonly<Record<string, ProviderPaymentStatus>> = {
  '2': 'succeeded',
  '0': 'pending',
  '-1': 'cancelled',
  '-2': 'failed',
  '-3': 'charged_back',
};

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function getExactlyOne(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function parseAmountCents(value: string): number | null {
  if (!/^[0-9]{1,9}\.[0-9]{2}$/.test(value)) return null;
  const [majorText, minorText] = value.split('.');
  const major = Number(majorText);
  const minor = Number(minorText);
  if (major > MAX_AMOUNT_MAJOR_UNITS) return null;
  const cents = major * 100 + minor;
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export interface PayHereOptions {
  mode: 'sandbox' | 'live';
  notifyUrl: string;
  returnUrl: string;
  cancelUrl: string;
}

// PayHere hosted checkout. Hash + md5sig per PayHere's spec:
//   hash   = UPPER(md5( merchant_id + order_id + amount + currency + UPPER(md5(secret)) ))
//   md5sig = UPPER(md5( merchant_id + order_id + payhere_amount + payhere_currency + status_code + UPPER(md5(secret)) ))
// status_code 2 = success. The secret never leaves the server.
export class PayHerePaymentAdapter implements PaymentAdapter {
  readonly provider = 'payhere';
  private readonly checkoutUrl: string;

  constructor(
    private readonly merchantId: string,
    private readonly merchantSecret: string,
    private readonly opts: PayHereOptions,
  ) {
    this.checkoutUrl =
      opts.mode === 'live' ? 'https://www.payhere.lk/pay/checkout' : 'https://sandbox.payhere.lk/pay/checkout';
  }

  async createCheckout(args: CreateCheckoutArgs): Promise<CheckoutParams> {
    const amountStr = (args.amount / 100).toFixed(2);
    const hash = md5Upper(
      this.merchantId + args.orderId + amountStr + args.currency + md5Upper(this.merchantSecret),
    );
    const c = args.customer;
    const fields: Record<string, string> = {
      merchant_id: this.merchantId,
      return_url: this.opts.returnUrl,
      cancel_url: this.opts.cancelUrl,
      notify_url: this.opts.notifyUrl,
      order_id: args.orderId,
      items: args.items ?? 'Ceylon Hop booking',
      currency: args.currency,
      amount: amountStr,
      first_name: c?.firstName ?? 'Guest',
      last_name: c?.lastName ?? '-',
      email: c?.email ?? '',
      phone: c?.phone ?? '',
      country: c?.country ?? 'Sri Lanka',
      hash,
    };
    // NO address/city — deliberately (owner, 2026-08-02). PayHere collects the billing address
    // in its own step when these are absent, so the acquirer's AVS check sees exactly what the
    // payer typed against their own card. We sent a hardcoded 'N/A'/'Colombo' until 2026-08-01,
    // then briefly sent an address typed into OUR form; both put a value in front of AVS that
    // the cardholder's bank had not agreed to, and cards were being declined. The gateway is
    // the right place to ask.
    return {
      provider: this.provider,
      orderId: args.orderId,
      amount: args.amount,
      currency: args.currency,
      checkoutUrl: this.checkoutUrl,
      fields,
    };
  }

  // test/dev helper: build a correctly-signed notify body
  simulateNotify(args: {
    orderId: string;
    amount: number;
    currency: string;
    statusCode?: string;
    paymentId?: string;
  }): string {
    const amountStr = (args.amount / 100).toFixed(2);
    const statusCode = args.statusCode ?? '2';
    const md5sig = md5Upper(
      this.merchantId + args.orderId + amountStr + args.currency + statusCode + md5Upper(this.merchantSecret),
    );
    return new URLSearchParams({
      merchant_id: this.merchantId,
      order_id: args.orderId,
      payment_id: args.paymentId ?? 'PAY123',
      payhere_amount: amountStr,
      payhere_currency: args.currency,
      status_code: statusCode,
      md5sig,
    }).toString();
  }

  parseWebhook(rawBody: string): VerifiedPaymentEvent | null {
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_WEBHOOK_BYTES) return null;
    const p = new URLSearchParams(rawBody);
    const merchantId = getExactlyOne(p, 'merchant_id');
    const orderId = getExactlyOne(p, 'order_id');
    const providerTxnId = getExactlyOne(p, 'payment_id');
    const payhereAmount = getExactlyOne(p, 'payhere_amount');
    const payhereCurrency = getExactlyOne(p, 'payhere_currency');
    const statusCode = getExactlyOne(p, 'status_code');
    const md5sig = getExactlyOne(p, 'md5sig');
    if (
      merchantId === null ||
      orderId === null ||
      providerTxnId === null ||
      payhereAmount === null ||
      payhereCurrency === null ||
      statusCode === null ||
      md5sig === null
    ) {
      return null;
    }
    if (
      merchantId !== this.merchantId ||
      orderId.length === 0 ||
      orderId.length > 128 ||
      providerTxnId.length === 0 ||
      providerTxnId.length > 128 ||
      !/^[A-Z]{3}$/.test(payhereCurrency) ||
      !/^[A-F0-9]{32}$/.test(md5sig)
    ) {
      return null;
    }
    const amountCents = parseAmountCents(payhereAmount);
    const status = statusByCode[statusCode];
    if (amountCents === null || status === undefined) return null;
    const local = md5Upper(
      merchantId + orderId + payhereAmount + payhereCurrency + statusCode + md5Upper(this.merchantSecret),
    );
    if (!safeEqual(local, md5sig)) return null;
    return {
      provider: this.provider,
      merchantId,
      orderId,
      providerTxnId,
      amountCents,
      currency: payhereCurrency,
      status,
      providerStatusCode: statusCode,
      receivedAt: new Date(),
      payloadSha256: createHash('sha256').update(rawBody).digest('hex'),
      sanitizedPayload: {
        merchant_id: merchantId,
        order_id: orderId,
        payment_id: providerTxnId,
        payhere_amount: payhereAmount,
        payhere_currency: payhereCurrency,
        status_code: statusCode,
      },
    };
  }
}
