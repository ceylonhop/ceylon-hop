// The ONE place→town rule for reporting (2026-10-03): route report SQL (docs/analytics/
// route-report.sql, pinned to ALIASES by knownPlace.test.ts) and GA4 purchase facts.
//
// Stored places are free text or Google labels. The town is found by WHOLE-token equality
// against known aliases (the hot-zone rule, hotZones.ts endpointTokens: "Bella Vista" never
// matches "Ella"), trying the whole string first, then each comma component from the END,
// because a Google label ends in its town. Only when nothing matches exactly does a second pass
// look for a known name as WHOLE WORDS inside a component ("Urban Galle Villa"), skipping a name
// followed by a street word ("Galle Road", "Galle Face") — added 2026-10-07, when a third of paid
// bookings' ends read "Other". Anything unmatched is "Other" — never the raw string: a typed home
// address is personal data.

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
  Kalutara: 'South coast', Belihuloya: 'Hill country', Batticaloa: 'East coast',
};

// Towns customers book that the quote catalogue (KNOWN_PLACES) doesn't carry. Reporting only:
// KNOWN_PLACES is the quote tool's offline autocomplete and its distance pins, so a town added
// there would change quoting, not just reports.
export const REPORT_ONLY_TOWNS: readonly string[] = ['Kalutara', 'Belihuloya', 'Batticaloa'];

// Every alias → its KNOWN_PLACES (or REPORT_ONLY_TOWNS) display name. Lower-case, whitespace-collapsed. Kept explicit
// (not derived) so the SQL report can carry the identical table (parity-tested).
export const ALIASES: readonly (readonly [string, string])[] = [
  ["adam's peak", "Adam's Peak"], ['ahangama', 'Ahangama'], ['anuradhapura', 'Anuradhapura'],
  ['arugam bay', 'Arugam Bay'], ['batticaloa', 'Batticaloa'], ['belihuloya', 'Belihuloya'],
  ['beliatta', 'Tangalle'], ['bentota', 'Bentota'], ['beragala', 'Haputale'],
  ['colombo airport (cmb)', 'Colombo Airport (CMB)'], ['colombo airport', 'Colombo Airport (CMB)'],
  ['colombo city', 'Colombo City'], ['colombo', 'Colombo City'],
  ['dambulla', 'Dambulla'], ['dehiwala', 'Colombo City'], ['dikwella', 'Hiriketiya'],
  ['ella', 'Ella'], ['galle', 'Galle'], ['habarana', 'Habarana'],
  ['haputale', 'Haputale'], ['hatton', 'Hatton'], ['hikkaduwa', 'Hikkaduwa'], ['hiriketiya', 'Hiriketiya'],
  ['horton plains', 'Horton Plains'], ['jaffna', 'Jaffna'], ['kalpitiya', 'Kalpitiya'],
  ['kalutara', 'Kalutara'], ['kandapola', 'Nuwara Eliya'], ['kandy', 'Kandy'],
  ['kitulgala', 'Kitulgala'], ['mirissa', 'Mirissa'], ['mount lavinia', 'Colombo City'],
  ['nanu oya', 'Nanu Oya'], ['negombo', 'Negombo'],
  ['nilaveli beach', 'Nilaveli Beach'], ['nilaveli', 'Nilaveli'], ['nuwara eliya', 'Nuwara Eliya'],
  ['pasikudah', 'Pasikudah'], ['polonnaruwa', 'Polonnaruwa'],
  ['sigiriya / dambulla', 'Sigiriya / Dambulla'], ['sigiriya', 'Sigiriya / Dambulla'],
  ['sigirya', 'Sigiriya / Dambulla'],
  ['tangalle', 'Tangalle'], ['thanthirimale', 'Thanthirimale'], ['tissamaharama', 'Tissamaharama'],
  ['trincomalee', 'Trincomalee'], ['udawalawa', 'Udawalawe'], ['udawalawe', 'Udawalawe'],
  ['unawatuna', 'Unawatuna'], ['uppuveli', 'Trincomalee'],
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

// The word pass, same as route-report.sql (CTE `matched`): anything but a–z splits words, so
// "Bella Vista" has no word "ella" and "Nuwara-Eliya" has "nuwara eliya". Longest name first,
// ties in byte order, so the SQL can order the same way.
const words = (s: string): string => s.replace(/[^a-z]+/g, ' ').trim();
const BY_WORDS = ALIASES
  .map(([alias, town]) => [words(alias), town] as const)
  .sort(([a], [b]) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
  .map(([w, town]) => [new RegExp(` ${w} (?!(road|rd|street|st|mawatha|lane|face) )`), town] as const);

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
  for (const t of parts) {
    const padded = ` ${words(t)} `;
    const hit = BY_WORDS.find(([re]) => re.test(padded));
    if (hit) return { town: hit[1], region: REGION_OF[hit[1]] ?? 'Other', type: 'address' };
  }
  return OTHER;
}
