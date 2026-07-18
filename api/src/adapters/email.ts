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

// Parse EMAIL_ALLOWLIST ("Team@x.com, ops@x.com, @ceylonhop.com") into a normalized list of
// lowercased entries. Each entry is either a full address (exact match) or a domain suffix
// beginning with "@" (matches any recipient on that domain). Undefined/blank → [] (no allowlist).
export function parseEmailAllowlist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export interface AllowlistOptions {
  allow: string[]; // entries from parseEmailAllowlist — full addresses and/or "@domain" suffixes
  onBlocked?: (msg: EmailMessage) => void; // observability hook; defaults to a console.warn
}

// Staging safety decorator. Wraps a real EmailAdapter and only forwards messages whose
// recipient matches the allowlist; anything else is DROPPED (logged, never thrown) so a
// staging run can never email a real customer, and a blocked send can't break the inline
// webhook/confirmation path. Production never wraps (empty EMAIL_ALLOWLIST → the real adapter
// is used directly), so this is inert there — the whole feature lives in staging config.
export class AllowlistEmailAdapter implements EmailAdapter {
  constructor(
    private readonly inner: EmailAdapter,
    private readonly opts: AllowlistOptions,
  ) {}

  async send(msg: EmailMessage): Promise<void> {
    const to = msg.to.trim().toLowerCase();
    const allowed = this.opts.allow.some((entry) =>
      entry.startsWith('@') ? to.endsWith(entry) : to === entry,
    );
    if (!allowed) {
      const onBlocked =
        this.opts.onBlocked ??
        ((m: EmailMessage) =>
          console.warn(`[email-allowlist] dropped message to ${m.to} — not in EMAIL_ALLOWLIST`));
      onBlocked(msg);
      return;
    }
    await this.inner.send(msg);
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
