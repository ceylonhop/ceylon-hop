export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

// The swappable email seam. A real provider (Resend/Postmark) implements this later;
// everything else uses the fake so no email is ever actually sent in code or tests.
export interface EmailAdapter {
  send(msg: EmailMessage): Promise<void>;
}

export class FakeEmailAdapter implements EmailAdapter {
  readonly sent: EmailMessage[] = [];

  async send(msg: EmailMessage): Promise<void> {
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
    const res = await fetch('https://api.resend.com/emails', {
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
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`resend_send_failed_${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
  }
}
