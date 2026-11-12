import { z } from 'zod';
import { knownCoords, type MapsAdapter } from './maps';

// A stop the customer PICKED from Google's list carries Google's own place ID. Measuring the road by
// that ID asks Google about the exact place the customer chose; measuring by the name asks Google to
// find it again from words, and that is what failed for 46 customers in 28 days (analytics review
// 2026-11-10: booking.js held the pick but sent only its text). The name stays everywhere else —
// zones, the stored booking, ops and emails all read the name, never the ID.
//
// Google place IDs are URL-safe base64-ish; the bound keeps a body from smuggling anything else into
// the Distance Matrix query string (it is URI-encoded there too).
export const PlaceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{10,300}$/);

/** `maps`, measuring each named stop in `ids` by its place ID. A catalogue town keeps its exact
 *  coordinates (and with them the implausibly-short guard), whatever ID arrives with it. */
export function withPlaceIds(maps: MapsAdapter, ids: Record<string, string | undefined>): MapsAdapter {
  const byName = new Map<string, string>();
  for (const [name, id] of Object.entries(ids)) {
    if (id && knownCoords(name) === null) byName.set(name, `place_id:${id}`);
  }
  if (byName.size === 0) return maps;
  const sub = (s: string) => byName.get(s) ?? s;
  return Object.assign(Object.create(maps) as MapsAdapter, {
    distance: (from: string, to: string) => maps.distance(sub(from), sub(to)),
    distanceVariants: (from: string, to: string) => maps.distanceVariants(sub(from), sub(to)),
  });
}
