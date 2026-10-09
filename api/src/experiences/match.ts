import { haversineKm } from '../adapters/maps';
import type { Experience } from './experience';

// Spec D6/D7: an experience shows for a stop when the straight-line distance from the stop to its
// pin is within ITS OWN radius (a spa 3 km out and a safari 25 km out both belong to "Sigiriya").
// One function for both pages — the booking page reaches it via GET /experiences/near, the quote
// page in-process — so the two can never disagree about what is "near".
export interface StopPoint { label: string; lat: number; lng: number }
export interface StopMatch<E> { place: string; items: Array<{ experience: E; distanceKm: number }> }
export const MAX_PER_STOP = 6;

type Matchable = Pick<Experience, 'id' | 'lat' | 'lng' | 'radiusKm' | 'active'>;

export function matchExperiences<E extends Matchable>(stops: StopPoint[], experiences: E[]): StopMatch<E>[] {
  const shown = new Set<string>();
  const out: StopMatch<E>[] = [];
  for (const stop of stops) {
    const items = experiences
      .filter((e) => e.active && !shown.has(e.id))
      .map((e) => ({ experience: e, distanceKm: haversineKm([stop.lat, stop.lng], [e.lat, e.lng]) }))
      .filter((m) => m.distanceKm <= m.experience.radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, MAX_PER_STOP);
    for (const m of items) shown.add(m.experience.id);
    if (items.length) out.push({ place: stop.label, items });
  }
  return out;
}
