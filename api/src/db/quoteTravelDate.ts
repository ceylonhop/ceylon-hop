// Travel date for the ops Quotes queue (spec 2026-08-01). Travel dates live only inside
// quotes.request_json.legs[].date — there is no travel_date column — so the list projection
// derives this the same way quoteRouteText derives the route, off the same requestLegs().
//
// ONE implementation, used by both the Postgres and in-memory repos, so the two can never
// disagree about when a quote's trip is over.
//
// The LAST travel day wins, not the first: a 10-day trip that departed three days ago is still
// under way, and a quote for it is still live. "Trip is definitively over" is the only claim
// this value is allowed to support.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function quoteTravelDate(legs: unknown): string | null {
  if (!Array.isArray(legs)) return null;
  let latest: string | null = null;
  for (const leg of legs) {
    if (!leg || typeof leg !== 'object') continue;
    const raw = (leg as { date?: unknown }).date;
    if (typeof raw !== 'string') continue;
    const date = raw.trim();
    // Shape-check before comparing. request_json is untrusted and predates several schema
    // revisions, and these are compared as strings — an unchecked 'next Tuesday' would sort
    // above every real date and silently become the quote's travel date.
    if (!ISO_DATE.test(date) || !isRealDate(date)) continue;
    if (latest === null || date > latest) latest = date;
  }
  return latest;
}

// ISO_DATE only proves the shape; '2026-13-45' passes it. Round-trip through Date to reject
// impossible calendar dates (and, incidentally, normalise nothing — the input string is what
// gets stored and compared).
function isRealDate(iso: string): boolean {
  const t = Date.parse(iso + 'T00:00:00Z');
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === iso;
}
