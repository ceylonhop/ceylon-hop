import type { ExperienceRepo } from '../db/experienceRepo';
import type { BusinessPlacesAdapter } from '../adapters/businessPlaces';

// Google lets us keep Places latitude/longitude for at most 30 consecutive days (Maps Platform Service
// Specific Terms §14.3) and place ids indefinitely. So every experience filled from Google has its pin
// re-fetched by place id once a day (the daily tick, admin.ts). A pin Google moved is rewritten; an
// unchanged one has still been re-fetched, so it isn't rewritten (no audit churn). A place Google no
// longer answers for keeps its pin and is counted as failed, so it shows in the tick's result.
export async function refreshExperiencePins(deps: {
  experiences: ExperienceRepo;
  business: BusinessPlacesAdapter;
}): Promise<{ checked: number; moved: number; failed: number }> {
  const out = { checked: 0, moved: 0, failed: 0 };
  for (const e of await deps.experiences.list()) {
    if (!e.googlePlaceId) continue;
    out.checked++;
    const loc = await deps.business.location(e.googlePlaceId);
    if (!loc) {
      out.failed++;
      console.error(`[experiences] pin refresh: no location from Google for ${e.slug} (${e.googlePlaceId})`);
      continue;
    }
    if (loc.lat === e.lat && loc.lng === e.lng) continue;
    await deps.experiences.patch(e.id, { lat: loc.lat, lng: loc.lng, updatedBy: 'google-pin-refresh' });
    out.moved++;
  }
  return out;
}
