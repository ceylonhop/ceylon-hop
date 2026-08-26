// ============================================================================
// Tokenized-payment seam — card-on-file preapproval + later charge, for the
// Ride Board's "$0 to add your name, charged only if the van locks" flow.
//
// This is a NEW, separate interface from PaymentAdapter (checkout+webhook) —
// the existing shared-taxi seam is untouched. The real PayHere Preapproval +
// Charging adapter implements this later (owner-gated: needs merchant
// Automated-Charging approval, Visa/MC only). Until then the Fake drives the
// whole flow so no real gateway or money is ever involved.
// ============================================================================

export interface PreapproveArgs {
  // A stable reference for the payer (e.g. the customer subject) — for traceability only.
  customerRef: string;
  orderId?: string;
  items?: string;
  currency?: string;
  returnUrl?: string;
  cancelUrl?: string;
  customer?: {
    firstName: string;
    lastName?: string;
    email: string;
    phone?: string;
    address?: string;
    city?: string;
    country: string;
  };
}

export interface PreapprovalCheckout {
  provider: string;
  orderId: string;
  checkoutUrl: string;
  fields: Record<string, string>;
}

export type PreapprovalResult =
  | { status: 'approved'; ref: string; checkout?: never }
  | { status: 'requires_action'; checkout: PreapprovalCheckout; ref?: never };

export interface VerifiedPreapprovalEvent {
  orderId: string;
  providerTxnId: string;
  status: 'succeeded' | 'pending' | 'cancelled' | 'failed';
  ref?: string;
}

export interface ChargeArgs {
  ref: string; // the token returned by preapprove
  amountCents: number;
  currency: string;
  orderId: string;
}

export interface ChargeResult {
  // Tri-state on purpose, matching the refund path (adapters/payhere.ts). 'failed' is a
  // POSITIVE statement — we know no money moved (a decline, or a request that never left
  // this process). 'unknown' means the charge was sent and the reply was lost, so the card
  // may well have been debited: callers must not tell the traveller they weren't charged,
  // and must not silently retry (there is no idempotency key on this API).
  status: 'succeeded' | 'failed' | 'unknown';
  providerTxnId?: string;
  failureReason?: string;
}

export interface TokenizedPaymentAdapter {
  readonly provider: string;
  // A fake may approve immediately. A real gateway returns a browser handoff and supplies
  // the reusable token only in its signed server callback.
  preapprove(args: PreapproveArgs): Promise<PreapprovalResult>;
  parsePreapprovalWebhook(rawBody: string): VerifiedPreapprovalEvent | null;
  // Charge a preapproved token some amount, later.
  charge(args: ChargeArgs): Promise<ChargeResult>;
}

export class FakeTokenizedPaymentAdapter implements TokenizedPaymentAdapter {
  readonly provider = 'fake-tokenized';
  readonly preapprovals: PreapproveArgs[] = [];
  readonly charges: ChargeArgs[] = [];
  private readonly failRefs = new Set<string>();
  private readonly unknownRefs = new Set<string>();
  private seq = 0;

  constructor() {
    const allowed = ['1', 'true', 'yes'].includes(
      String(process.env.ALLOW_FAKE_PAYMENTS ?? '').trim().toLowerCase(),
    );
    if (process.env.NODE_ENV === 'production' && !allowed) {
      throw new Error(
        'FakeTokenizedPaymentAdapter must never be used in production — configure PayHere Automated Charging',
      );
    }
  }

  async preapprove(args: PreapproveArgs): Promise<{ status: 'approved'; ref: string }> {
    this.preapprovals.push(args);
    return { status: 'approved', ref: `pa_${++this.seq}` };
  }

  parsePreapprovalWebhook(): VerifiedPreapprovalEvent | null {
    return null;
  }

  // Test helper: mark a token so the next charge on it fails (expired-card simulation).
  markRefWillFail(ref: string): void {
    this.failRefs.add(ref);
  }

  // Test helper: mark a token so the next charge on it comes back indeterminate — the request
  // reached the gateway and the reply was lost, so the card may or may not have been debited.
  markRefWillBeUnknown(ref: string): void {
    this.unknownRefs.add(ref);
  }

  async charge(args: ChargeArgs): Promise<ChargeResult> {
    this.charges.push(args);
    if (this.failRefs.has(args.ref)) {
      return { status: 'failed', failureReason: 'card_declined' };
    }
    if (this.unknownRefs.has(args.ref)) {
      return { status: 'unknown', failureReason: 'charge_result_unknown:simulated timeout' };
    }
    return { status: 'succeeded', providerTxnId: `txn_${args.orderId}_${this.charges.length}` };
  }
}
