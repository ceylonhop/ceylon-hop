// Colombo-local day/week bucketing for analytics. Sri Lanka is a FIXED UTC+5:30 (no DST since
// 2006), so "shift then slice" is exact and needs no timezone library. If the country ever
// changes offset, this constant is the single place to touch.
const COLOMBO_OFFSET_MS = 5.5 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

function shifted(d: Date): Date {
  return new Date(d.getTime() + COLOMBO_OFFSET_MS);
}

/** YYYY-MM-DD of the Colombo-local calendar day containing this instant. */
export function colomboDayKey(d: Date): string {
  return shifted(d).toISOString().slice(0, 10);
}

/** YYYY-MM-DD of the Monday starting the Colombo-local ISO week containing this instant. */
export function colomboWeekKey(d: Date): string {
  const s = shifted(d);
  const dow = s.getUTCDay(); // 0=Sun … 6=Sat in the shifted frame
  const daysSinceMonday = (dow + 6) % 7;
  return new Date(s.getTime() - daysSinceMonday * DAY_MS).toISOString().slice(0, 10);
}

/** Key for the given bucket granularity. */
export function colomboBucketKey(d: Date, bucket: 'day' | 'week'): string {
  return bucket === 'day' ? colomboDayKey(d) : colomboWeekKey(d);
}

/** The next bucket key after `key` (used to zero-fill chart series without gaps). */
export function nextBucketKey(key: string, bucket: 'day' | 'week'): string {
  const step = bucket === 'day' ? DAY_MS : 7 * DAY_MS;
  return new Date(Date.parse(`${key}T00:00:00.000Z`) + step).toISOString().slice(0, 10);
}
