// Route text for the ops Quotes queue search (spec 2026-07-25 §1). Route names live only
// inside quotes.request_json.legs[] — there are no from/to columns — so the list projection
// derives this string instead of storing it (spec D5: no migration for a search box).
//
// ONE implementation, used by both the Postgres and in-memory repos, so the two can never
// disagree about what a quote's route says.
//
// The separator is load-bearing: ops-ui.html's quoteRouteWindow() splits on this exact
// string to window the route around a search match. Change one, change both.
const SEP = ' · ';

// Safely pull `legs` off a stored request_json blob. Everything about that blob is untrusted:
// it round-trips through the DB and predates several schema revisions.
export function requestLegs(request: unknown): unknown {
  if (!request || typeof request !== 'object') return undefined;
  const r = request as { tool?: unknown; legs?: unknown };
  // POST /save persists `{ tool, engine }` — "V19: persist the reopenable tool payload
  // alongside the engine request" (internalQuote.ts) — so the place names as the operator
  // typed or picked them live at request.tool.legs, NOT at the top level. Rows written before
  // that change, and repo-level callers that pass a bare request, keep legs at the top; fall
  // back rather than silently lose their route.
  if (r.tool && typeof r.tool === 'object') {
    const legs = (r.tool as { legs?: unknown }).legs;
    if (legs !== undefined) return legs;
  }
  return r.legs;
}

export function quoteRouteText(legs: unknown): string | null {
  if (!Array.isArray(legs)) return null;
  const places: string[] = [];
  for (const leg of legs) {
    if (!leg || typeof leg !== 'object') continue;
    const l = leg as { from?: unknown; to?: unknown; stops?: unknown };
    // `stops` is the full ordered chain when present (from/to are its first/last), so
    // preferring it avoids emitting the endpoints twice.
    const chain = Array.isArray(l.stops) ? l.stops : [l.from, l.to];
    for (const raw of chain) {
      if (typeof raw !== 'string') continue;
      const place = raw.trim();
      if (!place) continue;
      // Leg N's `to` is normally leg N+1's `from`. Collapse only that CONSECUTIVE repeat —
      // a trip that genuinely returns to Colombo later should still say so.
      if (places.length && places[places.length - 1].toLowerCase() === place.toLowerCase()) continue;
      places.push(place);
    }
  }
  return places.length ? places.join(SEP) : null;
}
