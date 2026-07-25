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
  customer?: { firstName: string; email: string; country: string };
}

export interface ChargeArgs {
  ref: string; // the token returned by preapprove
  amountCents: number;
  currency: string;
  orderId: string;
}

export interface ChargeResult {
  status: 'succeeded' | 'failed';
  providerTxnId?: string;
  failureReason?: string;
}

export interface TokenizedPaymentAdapter {
  readonly provider: string;
  // Tokenize the card with a $0 hold; returns the reusable charge token.
  preapprove(args: PreapproveArgs): Promise<{ ref: string }>;
  // Charge a preapproved token some amount, later.
  charge(args: ChargeArgs): Promise<ChargeResult>;
}

export class FakeTokenizedPaymentAdapter implements TokenizedPaymentAdapter {
  readonly provider = 'fake-tokenized';
  readonly preapprovals: PreapproveArgs[] = [];
  readonly charges: ChargeArgs[] = [];
  private readonly failRefs = new Set<string>();
  private seq = 0;

  async preapprove(args: PreapproveArgs): Promise<{ ref: string }> {
    this.preapprovals.push(args);
    return { ref: `pa_${++this.seq}` };
  }

  // Test helper: mark a token so the next charge on it fails (expired-card simulation).
  markRefWillFail(ref: string): void {
    this.failRefs.add(ref);
  }

  async charge(args: ChargeArgs): Promise<ChargeResult> {
    this.charges.push(args);
    if (this.failRefs.has(args.ref)) {
      return { status: 'failed', failureReason: 'card_declined' };
    }
    return { status: 'succeeded', providerTxnId: `txn_${args.orderId}_${this.charges.length}` };
  }
}
