import { KNOWN_PLACES, haversineKm, knownCoords } from '../adapters/maps';

// Area for a business picked from Google (2026-10-18): our own nearest catalogue town, not Google's
// locality — for Athreya Google says "Kimbissa", while travellers and the booking page know it as Sigiriya.
// It's our data, so it carries none of Google's caching limits. "Sigiriya / Dambulla" → "Sigiriya": the
// area label is one place. The airport is a pickup point, never an experience's area.
const MAX_KM = 25;

export function nearestCatalogTown(lat: number, lng: number): string | null {
  let best: { name: string; km: number } | null = null;
  for (const name of KNOWN_PLACES) {
    if (/airport/i.test(name)) continue;
    const at = knownCoords(name);
    if (!at) continue;
    const km = haversineKm([lat, lng], at);
    if (km <= MAX_KM && (!best || km < best.km)) best = { name, km };
  }
  return best ? best.name.split(' / ')[0]!.trim() : null;
}
