// The ONE place→town rule for reporting (2026-10-03): route report SQL (docs/analytics/
// route-report.sql, pinned to ALIASES by knownPlace.test.ts) and GA4 purchase facts.
//
// Stored places are free text or Google labels. The town is found by WHOLE-token equality
// against known aliases (the hot-zone rule, hotZones.ts endpointTokens: "Bella Vista" never
// matches "Ella"), trying the whole string first, then each comma component from the END,
// because a Google label ends in its town. Anything unmatched is "Other" — never the raw
// string: a typed home address is personal data.

import { KNOWN_PLACES } from '../../adapters/maps';

export interface KnownPlace {
  town: string;
  region: string;
  type: 'airport' | 'town' | 'address' | 'unknown';
}

const AIRPORT = 'Colombo Airport (CMB)';
// Same test as payPageCopy.ts AIRPORT_RE and the ops shell's airport flag.
const AIRPORT_RE = /airport|cmb|katunayake/i;

export const REGION_OF: Readonly<Record<string, string>> = {
  'Colombo Airport (CMB)': 'Airport & Negombo', Negombo: 'Airport & Negombo',
  'Colombo City': 'Colombo',
  Bentota: 'South coast', Hikkaduwa: 'South coast', Galle: 'South coast', Unawatuna: 'South coast',
  Ahangama: 'South coast', Weligama: 'South coast', Mirissa: 'South coast', Hiriketiya: 'South coast',
  Tangalle: 'South coast',
  Kandy: 'Hill country', 'Nuwara Eliya': 'Hill country', Ella: 'Hill country', 'Nanu Oya': 'Hill country',
  Hatton: 'Hill country', "Adam's Peak": 'Hill country', Haputale: 'Hill country',
  'Horton Plains': 'Hill country', Kitulgala: 'Hill country',
  'Sigiriya / Dambulla': 'Cultural triangle', Dambulla: 'Cultural triangle', Habarana: 'Cultural triangle',
  Polonnaruwa: 'Cultural triangle', Anuradhapura: 'Cultural triangle', Thanthirimale: 'Cultural triangle',
  Yala: 'Safari south', Tissamaharama: 'Safari south', Udawalawe: 'Safari south',
  'Arugam Bay': 'East coast', Trincomalee: 'East coast', 'Nilaveli Beach': 'East coast', Nilaveli: 'East coast',
  Pasikudah: 'East coast',
  Jaffna: 'North & west', Wilpattu: 'North & west', Kalpitiya: 'North & west',
};

// Every alias → its KNOWN_PLACES display name. Lower-case, whitespace-collapsed. Kept explicit
// (not derived) so the SQL report can carry the identical table (parity-tested).
export const ALIASES: readonly (readonly [string, string])[] = [
  ["adam's peak", "Adam's Peak"], ['ahangama', 'Ahangama'], ['anuradhapura', 'Anuradhapura'],
  ['arugam bay', 'Arugam Bay'], ['bentota', 'Bentota'],
  ['colombo airport (cmb)', 'Colombo Airport (CMB)'], ['colombo airport', 'Colombo Airport (CMB)'],
  ['colombo city', 'Colombo City'], ['colombo', 'Colombo City'],
  ['dambulla', 'Dambulla'], ['ella', 'Ella'], ['galle', 'Galle'], ['habarana', 'Habarana'],
  ['haputale', 'Haputale'], ['hatton', 'Hatton'], ['hikkaduwa', 'Hikkaduwa'], ['hiriketiya', 'Hiriketiya'],
  ['horton plains', 'Horton Plains'], ['jaffna', 'Jaffna'], ['kalpitiya', 'Kalpitiya'], ['kandy', 'Kandy'],
  ['kitulgala', 'Kitulgala'], ['mirissa', 'Mirissa'], ['nanu oya', 'Nanu Oya'], ['negombo', 'Negombo'],
  ['nilaveli beach', 'Nilaveli Beach'], ['nilaveli', 'Nilaveli'], ['nuwara eliya', 'Nuwara Eliya'],
  ['pasikudah', 'Pasikudah'], ['polonnaruwa', 'Polonnaruwa'],
  ['sigiriya / dambulla', 'Sigiriya / Dambulla'], ['sigiriya', 'Sigiriya / Dambulla'],
  ['tangalle', 'Tangalle'], ['thanthirimale', 'Thanthirimale'], ['tissamaharama', 'Tissamaharama'],
  ['trincomalee', 'Trincomalee'], ['udawalawe', 'Udawalawe'], ['unawatuna', 'Unawatuna'],
  ['weligama', 'Weligama'], ['wilpattu', 'Wilpattu'], ['yala', 'Yala'],
];

const BY_ALIAS = new Map(ALIASES);
const OTHER: KnownPlace = { town: 'Other', region: 'Other', type: 'unknown' };

// The SQL report applies the same four steps (route-report.sql, CTE `tok`).
function token(part: string): string {
  return part.trim().toLowerCase().replace(/\s+/g, ' ')
    .replace(/,?\s*sri lanka$/, '')
    .replace(/^\d{4,6}\s+|\s+\d{4,6}$/g, '')
    .replace(/^colombo\s+\d{1,2}$/, 'colombo')
    .trim();
}

export function knownPlace(place: string | null | undefined): KnownPlace {
  const s = String(place ?? '').trim();
  if (!s) return OTHER;
  if (AIRPORT_RE.test(s)) return { town: AIRPORT, region: REGION_OF[AIRPORT], type: 'airport' };
  const whole = BY_ALIAS.get(token(s));
  if (whole) return { town: whole, region: REGION_OF[whole] ?? 'Other', type: 'town' };
  const parts = s.split(',').map(token).filter(Boolean).reverse();
  for (const t of parts) {
    const town = BY_ALIAS.get(t);
    if (town) return { town, region: REGION_OF[town] ?? 'Other', type: 'address' };
  }
  return OTHER;
}
