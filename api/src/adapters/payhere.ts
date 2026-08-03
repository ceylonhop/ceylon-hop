import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  PaymentAdapter,
  CheckoutParams,
  CreateCheckoutArgs,
  ProviderPaymentStatus,
  VerifiedPaymentEvent,
  WebhookRejection,
  RefundArgs,
  RefundResult,
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

// Refund API credentials (PayHere Settings -> API Keys, permission "Automated Charging API").
// Absent => the adapter exposes no refund(), and the ops UI offers the manual flow only.
export interface PayHereApiCredentials {
  appId: string;
  appSecret: string;
}

// PayHere's tokens live 599 seconds. Refresh with a minute to spare so a slow refund call can
// never straddle the expiry: the token is checked before the request, used during it.
const TOKEN_SAFETY_MARGIN_MS = 60_000;
const REFUND_TIMEOUT_MS = 10_000;
// payhere.lk sits behind Cloudflare, which blocks clients it cannot identify — a plain `curl`
// to the token endpoint is served a "Sorry, you have been blocked" page rather than an API
// response (observed 2026-08-02). Node's fetch sends no User-Agent at all, which is the same
// shape. So identify ourselves honestly: this is our own server-to-server client saying who it
// is, not a browser impersonation. Also ask for JSON explicitly, so a WAF interstitial is at
// least more likely to come back as an error than as HTML we would fail to parse.
const API_USER_AGENT = 'CeylonHop-API/1.0 (+https://ceylonhop.com)';

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
  private readonly apiBase: string;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly merchantId: string,
    private readonly merchantSecret: string,
    private readonly opts: PayHereOptions,
    // Optional: without these the class simply has no refund() to call.
    private readonly api?: PayHereApiCredentials,
    // Seam for tests. Never stubbed in production.
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.checkoutUrl =
      opts.mode === 'live' ? 'https://www.payhere.lk/pay/checkout' : 'https://sandbox.payhere.lk/pay/checkout';
    this.apiBase = opts.mode === 'live' ? 'https://www.payhere.lk' : 'https://sandbox.payhere.lk';
  }

  /** True when refund() will do anything. The ops UI asks this before offering the API route. */
  get canRefundViaApi(): boolean {
    return Boolean(this.api?.appId && this.api?.appSecret);
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

  // ── Refund API ────────────────────────────────────────────────────────────────────────────
  // OAuth client-credentials, then POST /merchant/v1/payment/refund.
  // Docs: support.payhere.lk/api-&-mobile-sdk/refund-api (read 2026-08-02).

  private async accessToken(now: number): Promise<string> {
    if (!this.api) throw new Error('payhere_refund_api_not_configured');
    if (this.token && this.token.expiresAt - TOKEN_SAFETY_MARGIN_MS > now) return this.token.value;
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
      signal: AbortSignal.timeout(REFUND_TIMEOUT_MS),
    });
    // A token failure is safe to surface loudly — no money has been asked for yet.
    if (!res.ok) throw new Error(`payhere_token_http_${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new Error('payhere_token_malformed');
    }
    const ttlSeconds = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 599;
    this.token = { value: body.access_token, expiresAt: now + ttlSeconds * 1000 };
    return this.token.value;
  }

  async refund(args: RefundArgs): Promise<RefundResult> {
    // The token call is the only part that is safe to retry, because it moves no money. It sits
    // outside the try below on purpose: a token failure is 'failed' (we never asked for the
    // refund), never 'unknown'.
    let token: string;
    try {
      token = await this.accessToken(Date.now());
    } catch (error) {
      return { outcome: 'failed', providerMessage: `token: ${(error as Error).message}` };
    }

    // Full refunds omit `amount` entirely, per PayHere's docs; a partial sends major units.
    const body: Record<string, string> = {
      payment_id: args.gatewayPaymentId,
      description: args.description.slice(0, 200),
    };
    if (!args.isFullRefund) body.amount = (args.amountCents / 100).toFixed(2);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}/merchant/v1/payment/refund`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': API_USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REFUND_TIMEOUT_MS),
      });
    } catch (error) {
      // Timeout, abort, socket error. PayHere may well have refunded the customer and we will
      // never know from here. This is the case the whole api_processing design exists for:
      // 'unknown' must never be downgraded to 'failed', which would free the money to be
      // refunded a second time.
      return { outcome: 'unknown', providerMessage: `transport: ${(error as Error).message}` };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      // A WAF interstitial is HTML, and it means the request never reached PayHere's API at all
      // — so the refund definitely did not happen and must not strand the row in api_processing.
      // Anything else unreadable stays unknown: we cannot prove it was not processed.
      const contentType = res.headers?.get?.('content-type') ?? '';
      if (contentType.includes('text/html')) {
        return { outcome: 'failed', providerMessage: `blocked before reaching the API (HTTP ${res.status})` };
      }
      return { outcome: 'unknown', providerMessage: `unparseable body (HTTP ${res.status})` };
    }

    // Token errors come back in a DIFFERENT shape — {error, error_description}, no status field.
    if (typeof parsed.error === 'string') {
      return { outcome: 'failed', providerMessage: `${parsed.error}: ${String(parsed.error_description ?? '')}`.slice(0, 200) };
    }

    // Their docs name this field `status_code` in prose and `status` in every JSON example.
    // Read both; treat neither-present as unknown rather than inventing an answer.
    const raw = parsed.status ?? parsed.status_code;
    const status = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    const providerMessage = typeof parsed.msg === 'string' ? parsed.msg.slice(0, 200) : undefined;
    if (!Number.isFinite(status)) {
      return { outcome: 'unknown', providerMessage: providerMessage ?? `no status (HTTP ${res.status})` };
    }

    if (status === 1) {
      // `data` carries PayHere's refund number. It is null on an AUTHORIZATION refund, which we
      // never issue — so a null here means we cannot identify what just happened, and the
      // evidence constraint would reject the row anyway. Treat it as unknown: the money may
      // have moved, and that is a human's problem, not a retry's.
      const ref = parsed.data;
      const gatewayRef =
        typeof ref === 'number' || (typeof ref === 'string' && ref.length > 0) ? String(ref) : null;
      if (!gatewayRef) {
        return { outcome: 'unknown', providerMessage: providerMessage ?? 'success with no refund reference' };
      }
      return { outcome: 'succeeded', gatewayRef, providerMessage };
    }

    // 0 = error initiating, -1 = refund failed, -2 = auth/IP/domain not allowed. All definite:
    // PayHere is telling us the money did not move.
    return { outcome: 'failed', providerMessage: providerMessage ?? `status ${status}` };
  }
}
