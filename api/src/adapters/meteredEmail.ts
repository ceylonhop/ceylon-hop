import type { EmailAdapter, EmailMessage, SendOutcome } from './email';
import type { UsageMeter } from '../services/usageMeter';

// Counts provider sends against the Resend caps (spec 2026-10-13 §3). Wraps the RAW provider
// adapter in server.ts — below the GuardedEmailAdapter/ObservingEmailAdapter that app.ts adds — so
// the ops alerts and the digest, which bypass the guard, are counted too. It decides nothing and
// never makes a second call: `email.sent` is a message the provider accepted, `email.suppressed`
// one the guard stopped before the provider, `email.failed` a throw (Resend non-2xx, timeout),
// rethrown unchanged.
export class MeteredEmailAdapter implements EmailAdapter {
  constructor(
    private readonly inner: EmailAdapter,
    private readonly meter: UsageMeter,
  ) {}

  async send(message: EmailMessage): Promise<SendOutcome | void> {
    let outcome: SendOutcome | void;
    try {
      outcome = await this.inner.send(message);
    } catch (err) {
      this.meter.bump('email.failed');
      throw err;
    }
    // A void outcome is delivered — the pre-outcome contract every caller still relies on.
    this.meter.bump(!outcome || outcome.delivered ? 'email.sent' : 'email.suppressed');
    return outcome;
  }
}
