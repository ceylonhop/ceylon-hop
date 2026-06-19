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
