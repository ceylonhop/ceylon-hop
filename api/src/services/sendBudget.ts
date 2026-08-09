// ============================================================================
// Blast-radius cap for outbound notifications (spec: docs/notification-safety-rails-spec.md,
// rail R1). One budget per cron tick, shared by every sweep that tick drives.
//
// The failure this exists for: a migration or a status backfill makes a batch of old
// bookings newly eligible, and the next tick mails all of them. The notification_log stops
// a REPEAT send, not a first one — so it is no defence at all here. This is.
//
// Deliberately fails closed: on hitting the cap a sweep stops sending rather than finishing
// its loop. A late reminder is recoverable; four hundred wrong emails are not. Nothing is
// retried automatically — a suppressed send is simply not ledgered, so the next run (once a
// human has raised the cap or fixed the data) picks it up normally.
// ============================================================================

import type { Alert } from '../adapters/alerts';

export interface BudgetReport {
  cap: number;
  sent: number;
  suppressed: number;
  /** Suppressed counts per notification kind — what the alert leads with. */
  kinds: Record<string, number>;
  /** First few references, so the alert names something a human can go and look at. */
  sample: string[];
}

const SAMPLE_MAX = 5;

export class SendBudget {
  private used = 0;
  private readonly tally = new Map<string, number>();
  private readonly refs: string[] = [];

  constructor(readonly cap: number) {}

  get sent(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.cap - this.used);
  }

  get exhausted(): boolean {
    return this.remaining === 0;
  }

  get anySuppressed(): boolean {
    return this.tally.size > 0;
  }

  /**
   * Reserve `n` sends. All-or-nothing: a claim that does not fit spends nothing, so a
   * caller with an indivisible batch (a Ride Board van, where charging half the travellers
   * would be worse than charging none) can ask before it starts.
   */
  tryClaim(n = 1): boolean {
    if (n > this.remaining) return false;
    this.used += n;
    return true;
  }

  /** Record a send that was decided on but not made, so the alert can describe it. */
  suppress(kind: string, ref: string, count = 1): void {
    this.tally.set(kind, (this.tally.get(kind) ?? 0) + count);
    if (this.refs.length < SAMPLE_MAX) this.refs.push(ref);
  }

  report(): BudgetReport {
    let suppressed = 0;
    const kinds: Record<string, number> = {};
    for (const [kind, n] of this.tally) {
      kinds[kind] = n;
      suppressed += n;
    }
    return { cap: this.cap, sent: this.used, suppressed, kinds, sample: [...this.refs] };
  }
}

/**
 * The page a suppressed burst raises. Returns null when the run behaved normally — the
 * overwhelmingly common case, and the reason this is a function rather than a branch at
 * every call site.
 *
 * Deduped per TICK, not per booking: a burst is one event however many records it spans,
 * and the throttle wrapper collapses a persisting one to a single email per cooldown.
 */
export function burstAlert(budget: SendBudget, tick: string): Alert | null {
  if (!budget.anySuppressed) return null;
  const r = budget.report();
  const breakdown = Object.entries(r.kinds)
    .map(([kind, n]) => `${kind}: ${n}`)
    .join(', ');
  return {
    severity: 'critical',
    kind: 'notification_burst_suppressed',
    title: `Notification burst suppressed — ${r.sent} sent, ${r.suppressed} held back`,
    body:
      `The ${tick} tick reached its cap of ${r.cap} outbound notifications and STOPPED sending.\n\n` +
      `Held back: ${breakdown}.\n` +
      `For example: ${r.sample.join(', ')}.\n\n` +
      `Nothing held back was recorded as sent, so a later run will still deliver it — which means ` +
      `this needs a decision before the next tick. Is it real demand (raise NOTIFY_MAX_PER_RUN and ` +
      `re-run), or did a data change make old records newly eligible — a migration or status backfill? ` +
      `If it is the latter, fix the data first: the next run will send all of it.`,
    dedupeKey: tick,
  };
}
