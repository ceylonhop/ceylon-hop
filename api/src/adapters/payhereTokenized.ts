import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  ChargeArgs,
  ChargeResult,
  PreapproveArgs,
  PreapprovalResult,
  TokenizedPaymentAdapter,
  VerifiedPreapprovalEvent,
} from './tokenizedPayments';
import type { PayHereApiCredentials } from './payhere';

const MAX_NOTIFY_BYTES = 8_192;
const TOKEN_MARGIN_MS = 60_000;
const API_TIMEOUT_MS = 10_000;
const API_USER_AGENT = 'CeylonHop-API/1.0 (+https://ceylonhop.com)';

const md5Upper = (value: string): string =>
  createHash('md5').update(value).digest('hex').toUpperCase();

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function exactlyOne(params: URLSearchParams, name: string): string | null {
  const all = params.getAll(name);
  return all.length === 1 ? (all[0] ?? null) : null;
}

export interface PayHereTokenizedOptions {
  mode: 'sandbox' | 'live';
  notifyUrl: string;
}

/**
 * PayHere Automated Charging consists of two different protocols:
 * 1. a hosted, form-POST preapproval that returns a customer_token by signed callback;
 * 2. an OAuth-protected JSON Charging API that consumes that token later.
 */
export class PayHereTokenizedPaymentAdapter implements TokenizedPaymentAdapter {
  readonly provider = 'payhere-tokenized';
  private readonly preapprovalUrl: string;
  private readonly apiBase: string;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly merchantId: string,
    private readonly merchantSecret: string,
    private readonly opts: PayHereTokenizedOptions,
    private readonly api: PayHereApiCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.preapprovalUrl = opts.mode === 'live'
      ? 'https://www.payhere.lk/pay/preapprove'
      : 'https://sandbox.payhere.lk/pay/preapprove';
    this.apiBase = opts.mode === 'live' ? 'https://www.payhere.lk' : 'https://sandbox.payhere.lk';
  }

  async preapprove(args: PreapproveArgs): Promise<PreapprovalResult> {
    const c = args.customer;
    if (
      !args.orderId || !args.returnUrl || !args.cancelUrl || !args.currency ||
      !c?.firstName || !c.lastName || !c.email || !c.phone || !c.address || !c.city || !c.country
    ) {
      throw new Error('payment_details_required');
    }
    const currency = args.currency.toUpperCase();
    // Deliberately omit `amount`: including it would capture a payment in addition to approval.
    // The hash still has to be built over the amount PayHere will authorize, and that value is
    // NOT what their documentation says for non-LKR on live. Every live preapproval failed with
    // `PH-0014 Unauthorized payment request`; PayHere support, 2026-08-24:
    //   "Please use 0.51 as the authorization amount for other currencies when generating the
    //    hash value. For the PayHere Preapproval API, the authorization amount has been changed
    //    in the PayHere Live environment. This change will be reflected in the PayHere
    //    documentation soon."
    // Their live preapproval page had been quoting USD 0.51 while we hashed 1.01, which is the
    // mismatch. Sandbox still expects 1.01 and their published docs still say 1.01, so this is
    // deliberately mode-dependent — do not collapse the branch to a single constant until the
    // documentation catches up and sandbox is confirmed to have moved too. LKR is unchanged.
    const hashAmount = currency === 'LKR'
      ? '10.00'
      : this.opts.mode === 'live' ? '0.51' : '1.01';
    const hash = md5Upper(
      this.merchantId + args.orderId + hashAmount + currency + md5Upper(this.merchantSecret),
    );
    return {
      status: 'requires_action',
      checkout: {
        provider: this.provider,
        orderId: args.orderId,
        checkoutUrl: this.preapprovalUrl,
        fields: {
          merchant_id: this.merchantId,
          return_url: args.returnUrl,
          cancel_url: args.cancelUrl,
          notify_url: this.opts.notifyUrl,
          order_id: args.orderId,
          items: args.items ?? 'Ceylon Hop Ride Board card approval',
          currency,
          first_name: c.firstName,
          last_name: c.lastName,
          email: c.email,
          phone: c.phone,
          address: c.address,
          city: c.city,
          country: c.country,
          hash,
        },
      },
    };
  }

  parsePreapprovalWebhook(rawBody: string): VerifiedPreapprovalEvent | null {
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_NOTIFY_BYTES) return null;
    const p = new URLSearchParams(rawBody);
    const merchantId = exactlyOne(p, 'merchant_id');
    const orderId = exactlyOne(p, 'order_id');
    const paymentId = exactlyOne(p, 'payment_id');
    const amount = exactlyOne(p, 'payhere_amount');
    const currency = exactlyOne(p, 'payhere_currency');
    const statusCode = exactlyOne(p, 'status_code');
    const signature = exactlyOne(p, 'md5sig');
    if (!merchantId || !orderId || !paymentId || !amount || !currency || !statusCode || !signature) return null;
    if (merchantId !== this.merchantId || orderId.length > 128 || paymentId.length > 128) return null;
    if (!/^[A-Z]{3}$/.test(currency) || !/^-?\d+$/.test(statusCode) || !/^[A-F0-9]{32}$/.test(signature)) return null;
    const expected = md5Upper(
      merchantId + orderId + amount + currency + statusCode + md5Upper(this.merchantSecret),
    );
    if (!safeEqual(expected, signature)) return null;
    const status = statusCode === '2'
      ? 'succeeded'
      : statusCode === '0'
        ? 'pending'
        : statusCode === '-1'
          ? 'cancelled'
          : statusCode === '-2'
            ? 'failed'
            : null;
    if (!status) return null;
    const customerToken = exactlyOne(p, 'customer_token');
    if (status === 'succeeded' && (!customerToken || customerToken.length > 2_048)) return null;
    return {
      orderId,
      providerTxnId: paymentId,
      status,
      ...(status === 'succeeded' ? { ref: customerToken! } : {}),
    };
  }

  simulatePreapprovalNotify(args: {
    orderId: string;
    customerToken: string;
    statusCode?: string;
    paymentId?: string;
    amount?: string;
    currency?: string;
  }): string {
    const amount = args.amount ?? '1.01';
    const currency = args.currency ?? 'USD';
    const statusCode = args.statusCode ?? '2';
    const signature = md5Upper(
      this.merchantId + args.orderId + amount + currency + statusCode + md5Upper(this.merchantSecret),
    );
    return new URLSearchParams({
      merchant_id: this.merchantId,
      order_id: args.orderId,
      payment_id: args.paymentId ?? 'PAY-PREAPPROVAL-1',
      payhere_amount: amount,
      payhere_currency: currency,
      status_code: statusCode,
      md5sig: signature,
      customer_token: args.customerToken,
    }).toString();
  }

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt - TOKEN_MARGIN_MS > now) return this.token.value;
    const basic = Buffer.from(`${this.api.appId}:${this.api.appSecret}`).toString('base64');
    const res = await this.fetchImpl(`${this.apiBase}/merchant/v1/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': API_USER_AGENT,
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`payhere_token_http_${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('payhere_token_malformed');
    const ttl = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 599;
    this.token = { value: body.access_token, expiresAt: now + ttl * 1_000 };
    return body.access_token;
  }

  async charge(args: ChargeArgs): Promise<ChargeResult> {
    if (
      !args.ref || !args.orderId || !Number.isSafeInteger(args.amountCents) || args.amountCents <= 0 ||
      !/^[A-Z]{3}$/.test(args.currency)
    ) {
      return { status: 'failed', failureReason: 'invalid_charge_request' };
    }
    let token: string;
    try {
      token = await this.accessToken();
    } catch (error) {
      return { status: 'failed', failureReason: `oauth_failed:${(error as Error).message}` };
    }
    try {
      const res = await this.fetchImpl(`${this.apiBase}/merchant/v1/payment/charge`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': API_USER_AGENT,
        },
        body: JSON.stringify({
          type: 'PAYMENT',
          order_id: args.orderId,
          items: `Ceylon Hop shared ride ${args.orderId}`,
          currency: args.currency,
          amount: args.amountCents / 100,
          customer_token: args.ref,
        }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      const body = (await res.json()) as {
        status?: unknown;
        msg?: unknown;
        data?: { payment_id?: unknown; status_code?: unknown } | null;
      };
      const ok = res.ok && Number(body.status) === 1 && Number(body.data?.status_code) === 2;
      if (!ok) {
        return {
          status: 'failed',
          failureReason: typeof body.msg === 'string' ? body.msg.slice(0, 200) : `payhere_charge_http_${res.status}`,
        };
      }
      const paymentId = body.data?.payment_id;
      if (typeof paymentId !== 'string' && typeof paymentId !== 'number') {
        return { status: 'failed', failureReason: 'payhere_charge_missing_payment_id' };
      }
      return { status: 'succeeded', providerTxnId: String(paymentId) };
    } catch (error) {
      // Do not retry automatically: PayHere may have charged before a timeout. The stable order
      // id is retained for dashboard reconciliation.
      return { status: 'failed', failureReason: `charge_result_unknown:${(error as Error).message}` };
    }
  }
}
