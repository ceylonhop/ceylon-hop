import { canonPlace, knownCoords } from '../adapters/maps';
import { requestLegs } from '../db/quoteRouteText';
import type { PlaceResolutionRepo } from '../db/placeResolutionRepo';
import { drives } from '../quote/legCategory';
import type { StopPoint } from './match';

// The stops a stored quote visits, as points the experiences matcher can use (spec 2026-10-06 D9).
// A stop is a driving leg's DESTINATION, so the airport the trip starts from is never one. Names
// resolve only from what we already trust — the known-place catalogue / a literal "lat,lng", then
// the confirmed place_resolutions — and an unresolved name is skipped rather than geocoded:
// this runs on a public read, and a stop we cannot place simply shows no experiences.
export async function quoteStopPoints(request: unknown, placeResolutions: PlaceResolutionRepo): Promise<StopPoint[]> {
  const legs = requestLegs(request);
  if (!Array.isArray(legs)) return [];
  const seen = new Set<string>();
  const out: StopPoint[] = [];
  for (const leg of legs) {
    if (!leg || typeof leg !== 'object') continue;
    const l = leg as { to?: unknown; category?: string };
    if (!drives(l) || typeof l.to !== 'string') continue;
    const name = l.to.trim();
    const key = canonPlace(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const point = knownCoords(name) ?? await resolved(placeResolutions, key);
    if (!point) continue;
    out.push({ label: name.split(' / ')[0]!.trim(), lat: point[0], lng: point[1] });
  }
  return out;
}

async function resolved(repo: PlaceResolutionRepo, key: string): Promise<[number, number] | null> {
  const row = await repo.get(key);
  return row ? [row.lat, row.lng] : null;
}
