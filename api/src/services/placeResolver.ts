import { canonPlace, haversineKm } from '../adapters/maps';
import type { PlaceResolutionRepo } from '../db/placeResolutionRepo';

// Positive location identification (spec 2026-08-02).
//
// Q-CEVGM priced Yala -> Colombo Airport at 78 km instead of ~286 because the stop string
// "Yala, Sri Lanka" was handed to Google's geocoder, which confidently resolved it to a village
// near Horana. Measured on the live API, that query returns ONE result with
// partial_match=false: Google will not tell us when it is guessing, so nothing keyed on its
// confidence can protect us.
//
// So the rule is inverted. We never try to recognise a bad answer; we only price a place that
// has been positively identified — seeded catalog, or confirmed once by a human.

/** How close an independent geocode must land to an already-trusted place to be treated as it. */
export const AUTO_LINK_KM = 1.0;

export interface GeocodedPoint {
  lat: number;
  lng: number;
  displayName: string;
  area: string | null;
}

/** The slice of the maps adapter the resolver needs. Narrow on purpose: the resolver must not
 *  be able to ask for a distance, only for where a string might be. */
export interface Geocoder {
  geocode?(query: string): Promise<GeocodedPoint | null>;
}

export type Resolution =
  | { kind: 'resolved'; canonKey: string; displayName: string; lat: number; lng: number }
  | { kind: 'needs_confirmation'; name: string; canonKey: string };

export class PlaceResolver {
  constructor(
    private readonly repo: PlaceResolutionRepo,
    private readonly geocoder: Geocoder,
  ) {}

  async resolve(name: string): Promise<Resolution> {
    const canonKey = canonPlace(name);
    if (!canonKey) return { kind: 'needs_confirmation', name, canonKey };

    const known = await this.repo.get(canonKey);
    if (known) {
      return { kind: 'resolved', canonKey, displayName: known.displayName, lat: known.lat, lng: known.lng };
    }

    // Unknown string. A geocode is allowed HERE and only here, and its coordinate is never
    // adopted as-is — it is used solely to ask "is this a place we already trust?". That
    // distinction is the design: a geocode may identify a known place, never introduce a new one.
    const point = await this.safeGeocode(canonKey);
    if (!point) return { kind: 'needs_confirmation', name, canonKey };

    const anchors = await this.repo.all();
    const inRange = anchors.filter((a) => haversineKm([a.lat, a.lng], [point.lat, point.lng]) <= AUTO_LINK_KM);
    // Two anchors in range is a CHOICE between known places, which is exactly the thing a
    // human is for. Only an unambiguous single match may proceed unattended.
    if (inRange.length !== 1) return { kind: 'needs_confirmation', name, canonKey };

    const anchor = inRange[0];
    // Store the ANCHOR's coordinate, not the geocode's: the anchor is the verified one, and
    // copying the geocode would let trusted points drift a kilometre per alias.
    await this.repo.upsert({
      canonKey,
      displayName: anchor.displayName,
      lat: anchor.lat,
      lng: anchor.lng,
      source: 'auto_linked',
    });
    return { kind: 'resolved', canonKey, displayName: anchor.displayName, lat: anchor.lat, lng: anchor.lng };
  }

  // A geocoder outage must never look like "this place is unknown and therefore fine to
  // guess at" — it degrades to needs_confirmation, same as any unidentified place.
  private async safeGeocode(q: string): Promise<GeocodedPoint | null> {
    try {
      // No geocoder at all (a stub adapter, or a keyless environment) means no auto-link, so
      // every unknown string goes to a human. Fail-closed by construction.
      return (await this.geocoder.geocode?.(q)) ?? null;
    } catch {
      return null;
    }
  }
}

/** A resolved pair rendered for the Distance Matrix call: exact coordinates, never a name. */
export const asLatLng = (r: Extract<Resolution, { kind: 'resolved' }>): string => `${r.lat},${r.lng}`;
