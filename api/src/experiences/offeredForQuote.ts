import type { ExperienceRepo } from '../db/experienceRepo';
import type { PlaceResolutionRepo } from '../db/placeResolutionRepo';
import { aboutKm, toPublicExperience, type Experience } from './experience';
import { matchExperiences, type StopMatch } from './match';
import { quoteStopPoints } from './quoteStops';

// The experiences near a stored quote's stops (spec 2026-10-06 D9) — ONE computation shared by a
// page's read and its POST's "is this one actually offered here" check, so the two can never
// disagree. Moved out of quoteView.ts when the section moved to the pay-link confirmation (owner,
// 2026-10-15). Without the catalogue or the place resolutions there is simply nothing offered.
export async function offeredForQuote(
  request: unknown,
  deps: { experiences?: ExperienceRepo; placeResolutions?: PlaceResolutionRepo },
): Promise<StopMatch<Experience>[]> {
  if (!deps.experiences || !deps.placeResolutions) return [];
  const stops = await quoteStopPoints(request, deps.placeResolutions);
  if (stops.length === 0) return [];
  return matchExperiences(stops, await deps.experiences.listActive());
}

// The customer wire shape: public fields only, a rounded distance, and whether this customer has
// already asked about it.
export function publicOffered(matched: StopMatch<Experience>[], interested: ReadonlySet<string>) {
  return matched.map((s) => ({
    place: s.place,
    items: s.items.map((m) => ({
      ...toPublicExperience(m.experience), aboutKm: aboutKm(m.distanceKm), interested: interested.has(m.experience.id),
    })),
  }));
}
