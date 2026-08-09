// Who a message is FOR, not what it says. The distinction earns its keep in exactly one
// place — the kill switch (see adapters/emailGuard.ts), which stops customer mail while
// letting ops alerts through, because silencing the alerts would hide the incident the
// switch was thrown for. Defaults to 'customer': the safer side of the switch, and what
// all ten customer senders mean without saying so.
export type EmailAudience = 'customer' | 'ops';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  audience?: EmailAudience;
}

// The swappable email seam. A real provider (Resend/Postmark) implements this later;
// everything else uses the fake so no email is ever actually sent in code or tests.
export interface EmailAdapter {
  send(msg: EmailMessage): Promise<void>;
}

// A customer who reached out on WhatsApp has no email address, and since 2026-08-08 a booking may
// legitimately carry none. All ten senders read `booking.input.customer.email` straight into `to`,
// so the guard lives HERE — one place rather than ten, and no sender can forget it.
//
// Silently skipping is deliberate: a missing address is a fact about the customer, not a failure.
// Throwing would fail the awaited webhook path that sends the confirmation inline.
export function hasDeliverableAddress(to: string | null | undefined): boolean {
  return !!(to && to.trim());
}

export class FakeEmailAdapter implements EmailAdapter {
  readonly sent: EmailMessage[] = [];

  async send(msg: EmailMessage): Promise<void> {
    if (!hasDeliverableAddress(msg.to)) return;
    this.sent.push(msg);
  }
}

export interface ResendOptions {
  from: string; // e.g. "Ceylon Hop <hello@ceylonhop.com>" — must be a Resend-verified sender
  replyTo?: string;
}

// Real provider: Resend (https://resend.com). Selected at startup when RESEND_API_KEY
// is set; otherwise the fake is used so code/tests never send real mail. Throws on
// failure so callers can decide whether email is best-effort or must succeed.
export class ResendEmailAdapter implements EmailAdapter {
  readonly provider = 'resend';
  constructor(
    private readonly apiKey: string,
    private readonly opts: ResendOptions,
  ) {}

  async send(msg: EmailMessage): Promise<void> {
    // No address, nothing to send. Resend would answer 4xx for `to: ['']`, which reads in the
    // logs as a delivery failure rather than a customer we never had an address for.
    if (!hasDeliverableAddress(msg.to)) return;
    // Bound the outbound call so a hung Resend endpoint can't stall the awaited webhook path
    // (the confirmation email is sent inline in the PayHere webhook) or the notifications cron.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res: Response;
    try {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.opts.from,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          ...(msg.text ? { text: msg.text } : {}),
          ...(this.opts.replyTo ? { reply_to: this.opts.replyTo } : {}),
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`resend_send_failed_${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
  }
}
