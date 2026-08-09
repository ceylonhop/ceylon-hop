// ============================================================================
// Outbound mail guard (spec: docs/notification-safety-rails-spec.md, rail R3).
//
// Two rules, both off by default so production behaviour is unchanged:
//
//   EMAIL_ALLOWLIST       — when set, ONLY these recipients can be mailed. This is what
//                           makes a non-production environment structurally unable to
//                           email a real customer. Until now that guarantee rested
//                           entirely on remembering to leave RESEND_API_KEY unset on
//                           staging (docs/staging-environment-plan.md) — a convention the
//                           code knew nothing about, and one prod→staging data refresh
//                           away from mailing every real address in the table.
//
//   NOTIFICATIONS_ENABLED — the lever you throw WHILE something is going wrong. Stops
//                           customer mail; deliberately does NOT stop ops alerts, for the
//                           same reason the burst cap never caps them.
//
// Wraps whichever adapter the process selected, so there is one place to reason about
// rather than fourteen call sites — the same argument hasDeliverableAddress() makes.
// ============================================================================

import type { EmailAdapter, EmailMessage } from './email';
import { hasDeliverableAddress } from './email';
import { logEvent } from '../observability/events';

export interface EmailPolicy {
  /** NOTIFICATIONS_ENABLED. Defaults to true — omitting the policy changes nothing. */
  enabled?: boolean;
  /** EMAIL_ALLOWLIST entries, already parsed. Empty means no filtering. */
  allowlist?: string[];
}

/** `"A@x.com, @ceylonhop.com"` → `['a@x.com', '@ceylonhop.com']`. Blank → no allowlist. */
export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * An entry beginning with `@` matches the recipient's whole DOMAIN; anything else must
 * match the address exactly. The domain is taken from the last `@` rather than by
 * substring, so `ceylonhop.com@evil.com` does not slip past an `@ceylonhop.com` entry.
 */
export function isAllowed(to: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  const address = to.trim().toLowerCase();
  const domain = address.slice(address.lastIndexOf('@'));
  return allowlist.some((entry) => (entry.startsWith('@') ? entry === domain : entry === address));
}

/** The domain alone — events.ts is contractually free of personal data. */
function domainOf(to: string): string {
  return to.trim().toLowerCase().split('@').pop() ?? '';
}

export class GuardedEmailAdapter implements EmailAdapter {
  private readonly enabled: boolean;
  private readonly allowlist: string[];

  constructor(
    private readonly inner: EmailAdapter,
    policy: EmailPolicy,
  ) {
    this.enabled = policy.enabled ?? true;
    this.allowlist = policy.allowlist ?? [];
  }

  async send(msg: EmailMessage): Promise<void> {
    // No address is a fact about the customer, not a suppression — let the inner adapter's
    // own guard handle it silently, exactly as before, and log nothing.
    if (!hasDeliverableAddress(msg.to)) return this.inner.send(msg);

    const audience = msg.audience ?? 'customer';

    if (!this.enabled && audience === 'customer') return this.drop(msg, 'disabled', audience);
    if (!isAllowed(msg.to, this.allowlist)) return this.drop(msg, 'allowlist', audience);

    return this.inner.send(msg);
  }

  private drop(msg: EmailMessage, reason: 'disabled' | 'allowlist', audience: string): void {
    // Loud on purpose: a silently swallowed email is the failure mode this whole spec is
    // about. The subject carries the booking reference, which is a code, not personal data.
    logEvent('notification.suppressed', {
      reason,
      audience,
      toDomain: domainOf(msg.to),
      subject: msg.subject,
    });
  }
}
