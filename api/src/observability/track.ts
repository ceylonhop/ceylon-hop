// Error-tracking seam (M17). This is the ONLY module that touches @sentry/node —
// everything else calls track(), so tests never load the SDK and the whole feature is
// dormant until SENTRY_DSN is set (owner creates the account at launch, O2).

import * as Sentry from '@sentry/node';

let enabled = false;

export function initTracking(dsn: string | undefined, opts: { environment: string; release?: string }): void {
  if (!dsn) return; // dormant — no SDK init, track() stays a no-op
  Sentry.init({
    dsn,
    environment: opts.environment,
    release: opts.release,
    // Errors only — no perf tracing at this volume (free-tier friendly).
    tracesSampleRate: 0,
  });
  enabled = true;
}

export function track(err: unknown, ctx?: { route?: string; tag?: string; extra?: Record<string, unknown> }): void {
  if (!enabled) return;
  try {
    Sentry.withScope((scope) => {
      if (ctx?.route) scope.setTag('route', ctx.route);
      if (ctx?.tag) scope.setTag('source', ctx.tag);
      if (ctx?.extra) scope.setExtras(ctx.extra);
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
    });
  } catch {
    // Tracking must never break the request path.
  }
}

export function _isEnabledForTests(): boolean {
  return enabled;
}

export function _resetForTests(): void {
  enabled = false;
}
