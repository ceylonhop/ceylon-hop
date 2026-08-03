import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  PaymentAdapter,
  CheckoutParams,
  CreateCheckoutArgs,
  ProviderPaymentStatus,
  VerifiedPaymentEvent,
  WebhookRejection,
} from './payments';

type ParseResult =
  | { ok: true; event: VerifiedPaymentEvent }
  | { ok: false; rejection: WebhookRejection };

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

const MAX_DIAGNOSTIC_CHARS = 200;

// The two non-PII fields PayHere sends that actually explain a decline. Everything else on a card
// notify — card_holder_name, card_no, card_expiry — is PII and is deliberately NOT copied into
// this table, which is the sanitized log.
function diagnostic(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['status_message', 'method'] as const) {
    const value = getExactlyOne(params, name);
    // Absent is the normal case on a clean success; an empty string carries nothing either.
    if (value === null || value.length === 0) continue;
    out[name] = value.slice(0, MAX_DIAGNOSTIC_CHARS);
  }
  return out;
}

// Enough of a refused body to name the order it was about, read WITHOUT verifying anything —
// a rejected notify is untrusted by definition, so these are for the alert's prose and nothing
// else. Length-capped: an attacker chooses these strings, and they end up in an ops email.
const MAX_BREADCRUMB_CHARS = 64;

function breadcrumbs(p?: URLSearchParams): Omit<WebhookRejection, 'reason' | 'bodySha256'> {
  if (!p) return {};
  const first = (name: string): string | undefined => {
    const v = p.get(name);
    return v === null || v.length === 0 ? undefined : v.slice(0, MAX_BREADCRUMB_CHARS);
  };
  return {
    orderId: first('order_id'),
    statusCode: first('status_code'),
    amount: first('payhere_amount'),
    currency: first('payhere_currency'),
  };
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
    // Billing address: send it ONLY when the booking actually captured one. This used to be
    // `address: 'N/A', city: 'Colombo'` hardcoded — fabricated billing data on a live card
    // transaction, wrong in the payment record and a plausible AVS decline on foreign-issued
    // cards. Omitting the fields makes PayHere collect them in its own step (owner-caught,
    // 2026-08-01), which is strictly better than asserting something false.
    // PayHere has NO postcode parameter, and a postcode is the strongest AVS signal most
    // issuers check — so it rides on the address line, which their docs define as
    // "Address Line1 + Line2" (free text). Omitting it entirely would hand the acquirer an
    // address with the one part the bank actually matches on missing.
    // "31 River Court, Apt 105, NJ 07310" — a US address written the way a US address is
    // written, because the acquirer's only chance of picking either part out is if it looks
    // like one. State added 2026-08-02: the form had no field for it, so payers were putting
    // it in `city`, which is the one place it definitely does not belong.
    if (c?.address) fields.address = [c.address, [c.state, c.postcode].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(', ');
    if (c?.city) fields.city = c.city;
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

  // One parser, two callers. `parseWebhook` throws the reason away (its contract is
  // event-or-null and the settlement path never wanted more); `describeWebhookRejection` keeps
  // it for the alert. Splitting the rules into two functions instead would let the diagnosis
  // drift out of step with the decision, which is the failure mode that makes this kind of
  // logging worse than none.
  private parse(rawBody: string): ParseResult {
    const bodySha256 = createHash('sha256').update(rawBody).digest('hex');
    const reject = (reason: string, p?: URLSearchParams): ParseResult => ({
      ok: false,
      rejection: { reason, bodySha256, ...breadcrumbs(p) },
    });
    // Checked before parsing, so there is deliberately nothing to report but the size.
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_WEBHOOK_BYTES) return reject('body_too_large');
    const p = new URLSearchParams(rawBody);
    const merchantId = getExactlyOne(p, 'merchant_id');
    const orderId = getExactlyOne(p, 'order_id');
    const providerTxnId = getExactlyOne(p, 'payment_id');
    const payhereAmount = getExactlyOne(p, 'payhere_amount');
    const payhereCurrency = getExactlyOne(p, 'payhere_currency');
    const statusCode = getExactlyOne(p, 'status_code');
    const md5sig = getExactlyOne(p, 'md5sig');
    // Named individually: "which field" is the whole diagnosis when a real notify is refused,
    // and a scanner posting nothing at all reads as merchant_id rather than as a bad secret.
    for (const [name, value] of [
      ['merchant_id', merchantId],
      ['order_id', orderId],
      ['payment_id', providerTxnId],
      ['payhere_amount', payhereAmount],
      ['payhere_currency', payhereCurrency],
      ['status_code', statusCode],
      ['md5sig', md5sig],
    ] as const) {
      if (value === null) return reject(`missing_or_duplicate_field:${name}`, p);
    }
    if (
      merchantId === null ||
      orderId === null ||
      providerTxnId === null ||
      payhereAmount === null ||
      payhereCurrency === null ||
      statusCode === null ||
      md5sig === null
    ) {
      return reject('missing_or_duplicate_field', p); // unreachable; narrows for the compiler
    }
    if (merchantId !== this.merchantId) return reject('merchant_mismatch', p);
    if (orderId.length === 0 || orderId.length > 128) return reject('order_id_invalid', p);
    if (providerTxnId.length === 0 || providerTxnId.length > 128) return reject('payment_id_invalid', p);
    if (!/^[A-Z]{3}$/.test(payhereCurrency)) return reject('currency_malformed', p);
    if (!/^[A-F0-9]{32}$/.test(md5sig)) return reject('md5sig_malformed', p);
    const amountCents = parseAmountCents(payhereAmount);
    const status = statusByCode[statusCode];
    // The two rules most likely to refuse a notify PayHere genuinely sent: our amount regex
    // admits no thousands separator, and our status map knows only PayHere's documented five.
    if (amountCents === null) return reject('amount_malformed', p);
    if (status === undefined) return reject('status_code_unknown', p);
    const local = md5Upper(
      merchantId + orderId + payhereAmount + payhereCurrency + statusCode + md5Upper(this.merchantSecret),
    );
    // The only reason that implicates the merchant secret.
    if (!safeEqual(local, md5sig)) return reject('signature_mismatch', p);
    return {
      ok: true,
      event: {
        provider: this.provider,
        merchantId,
        orderId,
        providerTxnId,
        amountCents,
        currency: payhereCurrency,
        status,
        providerStatusCode: statusCode,
        receivedAt: new Date(),
        payloadSha256: bodySha256,
        sanitizedPayload: {
          merchant_id: merchantId,
          order_id: orderId,
          payment_id: providerTxnId,
          payhere_amount: payhereAmount,
          payhere_currency: payhereCurrency,
          status_code: statusCode,
          // PayHere sends these on every notify and we were dropping both. A real production
          // decline (CH-4KU9Z, status -2) left us with nothing but "-2" and the reason living
          // only in PayHere's dashboard. Neither is PII.
          //
          // NOT covered by md5sig — the signature spans merchant_id, order_id, amount, currency
          // and status_code only. So these are diagnostic breadcrumbs, never control flow: nothing
          // may branch on them. Truncated because their length is PayHere's to choose, not ours.
          ...diagnostic(p),
        },
      },
    };
  }

  parseWebhook(rawBody: string): VerifiedPaymentEvent | null {
    const result = this.parse(rawBody);
    return result.ok ? result.event : null;
  }

  describeWebhookRejection(rawBody: string): WebhookRejection | null {
    const result = this.parse(rawBody);
    return result.ok ? null : result.rejection;
  }
}
