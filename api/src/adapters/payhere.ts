import { createHash } from 'node:crypto';
import type { PaymentAdapter, CheckoutParams, CreateCheckoutArgs, WebhookEvent } from './payments';

const md5Upper = (s: string): string => createHash('md5').update(s).digest('hex').toUpperCase();

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
      address: 'N/A',
      city: 'Colombo',
      country: c?.country ?? 'Sri Lanka',
      hash,
    };
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

  parseWebhook(rawBody: string): WebhookEvent | null {
    const p = new URLSearchParams(rawBody);
    const merchantId = p.get('merchant_id') ?? '';
    const orderId = p.get('order_id') ?? '';
    const payhereAmount = p.get('payhere_amount') ?? '';
    const payhereCurrency = p.get('payhere_currency') ?? '';
    const statusCode = p.get('status_code') ?? '';
    const md5sig = p.get('md5sig') ?? '';
    const local = md5Upper(
      merchantId + orderId + payhereAmount + payhereCurrency + statusCode + md5Upper(this.merchantSecret),
    );
    if (!md5sig || local !== md5sig) return null;
    return {
      orderId,
      amount: Math.round(parseFloat(payhereAmount) * 100),
      currency: payhereCurrency,
      status: statusCode === '2' ? 'succeeded' : 'failed',
      providerTxnId: p.get('payment_id') ?? '',
    };
  }
}
