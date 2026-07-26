// ────────────────────────────────────────────────────────────────────────────
//  Structured business events (2026-07-26)
//
//  Sits alongside track() (which reports FAILURES to Sentry) and answers the
//  other question: what was the system doing? One JSON line per business event,
//  so "why did this van get called off" is a grep, not an archaeology dig.
//
//  Deliberately tiny — no logger dependency, no transport, no levels. Render
//  already collects stdout; this just makes the lines parseable. Never carries
//  personal data: codes, counts and statuses only.
// ────────────────────────────────────────────────────────────────────────────

export type EventFields = Record<string, unknown>;

/**
 * Emit one structured event line. Swallows every error it can produce — a
 * telemetry failure must never take down the request that triggered it.
 */
export function logEvent(event: string, fields: EventFields = {}): void {
  try {
    const line: EventFields = { event, at: new Date().toISOString() };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) line[k] = v;
    }
    console.log(JSON.stringify(line));
  } catch {
    // A cyclic field, a dead stdout — either way, drop it silently.
    try { console.log(JSON.stringify({ event, at: new Date().toISOString(), note: 'fields_unserialisable' })); }
    catch { /* nothing left to do */ }
  }
}
