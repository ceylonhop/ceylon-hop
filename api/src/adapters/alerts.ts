// Ops alerting seam (M17). Alerts flow through one adapter so the channel is swappable;
// the owner's O1 decision is email-only, sent via the existing EmailAdapter to ALERT_EMAIL.
// Every caller gets the ThrottledAlerts wrapper: DB-backed de-duplication means an error
// storm delivers ONE email per (kind, dedupeKey) per cooldown window, and delivery failure
// never breaks the request path that raised the alert.

import type { EmailAdapter } from './email';
import type { AlertLogRepo } from '../db/alertLogRepo';

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface Alert {
  severity: AlertSeverity;
  kind: string; // stable machine name, e.g. 'payhere_signature', 'api_error'
  title: string; // one-line human summary
  body: string; // detail — reference, route, error message
  dedupeKey?: string; // defaults to kind; storms collapse per key per cooldown
}

export interface AlertAdapter {
  send(alert: Alert): Promise<void>;
}

export class FakeAlertAdapter implements AlertAdapter {
  readonly sent: Alert[] = [];
  async send(alert: Alert): Promise<void> {
    this.sent.push(alert);
  }
}

// Dev / ALERT_EMAIL-unset fallback: alerts are at least visible in the server log.
export class LogAlertAdapter implements AlertAdapter {
  async send(alert: Alert): Promise<void> {
    console.error(`[alert:${alert.severity}] ${alert.kind}: ${alert.title} — ${alert.body}`);
  }
}

export class EmailAlertAdapter implements AlertAdapter {
  constructor(
    private readonly email: EmailAdapter,
    private readonly to: string,
  ) {}

  async send(alert: Alert): Promise<void> {
    const sev = alert.severity.toUpperCase();
    const text = [
      `${sev} · ${alert.kind}`,
      '',
      alert.body,
      '',
      `at ${new Date().toISOString()}`,
    ].join('\n');
    await this.email.send({
      to: this.to,
      subject: `[${sev}] ${alert.title} — Ceylon Hop ops`,
      html: `<pre style="font:14px/1.5 monospace">${text.replace(/</g, '&lt;')}</pre>`,
      text,
    });
  }
}

const DEFAULT_COOLDOWN_MS = 30 * 60_000;

export class ThrottledAlerts implements AlertAdapter {
  private readonly cooldownMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly inner: AlertAdapter,
    private readonly log: AlertLogRepo,
    opts?: { cooldownMs?: number; now?: () => Date },
  ) {
    this.cooldownMs = opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = opts?.now ?? ((): Date => new Date());
  }

  async send(alert: Alert): Promise<void> {
    try {
      const deliver = await this.log.shouldSend(
        alert.kind,
        alert.dedupeKey ?? alert.kind,
        this.cooldownMs,
        this.now(),
      );
      if (deliver) await this.inner.send(alert);
    } catch (err) {
      // Alerting must never take down the path that raised the alert.
      console.error(`alert delivery failed (${alert.kind}):`, err);
    }
  }
}
