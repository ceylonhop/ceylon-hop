// Rate-card HOT ZONES (spec: docs/superpowers/specs/2026-07-22-rate-card-hot-zones-design.md).
// A hot zone is a premium town: when a priced trip touches it, the per-km rate is boosted by a
// founder-set percentage. This module is the PURE matching core — given an endpoint name (and
// optionally resolved coords) and the active zone list, it returns the boost multiplier to apply.
// Kept side-effect-free and DB-free so the engine, the cost side, and unit tests all share one
// implementation of the D3 matching rules.

// In-code shape of a zone (camelCase). The DB stores snake_case (place_name/boost_pct/radius_km)
// and the repo maps to this. Zones live only in the DB + inside a locked RateCard snapshot; the
// compiled RATE_CARD carries none.
export interface HotZone {
  placeName: string; // a KNOWN_PLACES town, e.g. "Ella" (the D3 match key)
  boostPct: number; // whole percent, e.g. 15 = +15%
  active?: boolean; // default true; inactive zones never match
  // Optional geo fallback (D3 step 5) — all-or-nothing trio.
  lat?: number;
  lng?: number;
  radiusKm?: number;
}

const norm = (s: string): string => s.trim().toLowerCase();

// The town names an endpoint can equal to count as "in" a zone: the zone's normalized name, plus
// each compound part (split on "/") with any parenthetical stripped. So a zone "Sigiriya / Dambulla"
// yields ["sigiriya / dambulla", "sigiriya", "dambulla"], and "Colombo Airport (CMB)" yields
// ["colombo airport (cmb)", "colombo airport"].
function zoneAliases(placeName: string): string[] {
  const full = norm(placeName);
  const aliases = new Set<string>([full]);
  for (const part of placeName.split('/')) {
    const stripped = norm(part.replace(/\([^)]*\)/g, ''));
    if (stripped) aliases.add(stripped);
  }
  return [...aliases];
}

// The candidate town tokens an endpoint string contributes: the whole normalized string, plus each
// comma-delimited address component ("Nine Arch Bridge, Ella, Sri Lanka" → the component "ella").
// Matching is on WHOLE tokens (equality), never substring — so "Bella Vista" never matches "Ella"
// and "Galle Face Green" never matches "Galle".
function endpointTokens(endpoint: string): string[] {
  const tokens = new Set<string>([norm(endpoint)]);
  for (const part of endpoint.split(',')) {
    const t = norm(part);
    if (t) tokens.add(t);
  }
  return [...tokens];
}

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function matches(endpoint: string, coords: [number, number] | undefined, zone: HotZone): boolean {
  const tokens = endpointTokens(endpoint);
  const aliases = zoneAliases(zone.placeName);
  // D3 steps 2–4: exact / compound-split / address-component are all whole-token equality between
  // an endpoint token and a zone alias.
  if (tokens.some((t) => aliases.includes(t))) return true;
  // D3 step 5: optional radius fallback for a GPS pickup the names miss.
  if (coords && zone.lat != null && zone.lng != null && zone.radiusKm != null && zone.radiusKm > 0) {
    if (haversineKm(coords, [zone.lat, zone.lng]) <= zone.radiusKm) return true;
  }
  return false;
}

// The boost multiplier (1 + pct/100) to apply to an endpoint, or 1 when nothing matches. When more
// than one active zone matches, returns the SINGLE largest (D7 — max, never the sum). Inactive zones
// are skipped. (The HOT_ZONES_DISABLED kill switch is honored upstream in zonesRepo.activeZones(),
// which returns [] — so a disabled system reaches here with an empty list.)
export function zoneBoostFor(
  endpoint: string,
  coords: [number, number] | undefined,
  zones: HotZone[] | undefined,
): number {
  if (!zones || zones.length === 0) return 1;
  let best = 1;
  for (const zone of zones) {
    if (zone.active === false) continue;
    if (!matches(endpoint, coords, zone)) continue;
    const mult = 1 + zone.boostPct / 100;
    if (mult > best) best = mult;
  }
  return best;
}

// The single active zone with the largest boost that any of the given stops touches, or null. A
// ride/chauffeur-day touches a zone if ANY of its stops does (D2 — any touch, direction-neutral);
// on a tie/overlap the largest boost wins (D7). Stops carry names only; coords are unavailable from
// the engine, so the radius fallback is a no-op here (name matching is primary).
export function winningZoneForStops(stops: string[], zones: HotZone[] | undefined): HotZone | null {
  if (!zones || zones.length === 0) return null;
  let best: HotZone | null = null;
  for (const stop of stops) {
    for (const zone of zones) {
      if (zone.active === false) continue;
      if (!matches(stop, undefined, zone)) continue;
      if (!best || zone.boostPct > best.boostPct) best = zone;
    }
  }
  return best;
}

// The boost multiplier for a ride/day (1 when no stop touches a zone).
export function zoneBoostForStops(stops: string[], zones: HotZone[] | undefined): number {
  const zone = winningZoneForStops(stops, zones);
  return zone ? 1 + zone.boostPct / 100 : 1;
}

// Founder-only annotation (D9) for a boosted ride/day's line-item meta, e.g. "Ella premium +15%".
// Never placed in warnings (those reach every role); stripped from meta for non-margin:view callers.
export interface ZoneAnnotation { placeName: string; boostPct: number; label: string }
export function zoneAnnotation(zone: HotZone): ZoneAnnotation {
  return { placeName: zone.placeName, boostPct: zone.boostPct, label: `${zone.placeName} premium +${zone.boostPct}%` };
}
