import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_PLACES } from '../../adapters/maps';
import { createDb } from '../../db/client';
import { ALIASES, REGION_OF, REPORT_ONLY_TOWNS, knownPlace } from './knownPlace';

// The ONE place→town rule for reporting (2026-10-03). A stored place is free text or a Google
// label; reports need a known TOWN and REGION, and anything we can't name must read "Other",
// never the raw string, because a typed home address is personal data (and GA4 noise).

describe('knownPlace', () => {
  it.each([
    ['Colombo Airport (CMB)', { town: 'Colombo Airport (CMB)', region: 'Airport & Negombo', type: 'airport' }],
    ['Bandaranaike International Airport, Katunayake, Sri Lanka', { town: 'Colombo Airport (CMB)', region: 'Airport & Negombo', type: 'airport' }],
    ['Ella', { town: 'Ella', region: 'Hill country', type: 'town' }],
    ['Sigiriya', { town: 'Sigiriya / Dambulla', region: 'Cultural triangle', type: 'town' }],
    ['Granbell Hotel Colombo, Marine Drive, Colombo, Sri Lanka', { town: 'Colombo City', region: 'Colombo', type: 'address' }],
    ['84/2/A, Poruthota Road, Ethukale, Negombo, 11500 Negombo, Sri Lanka', { town: 'Negombo', region: 'Airport & Negombo', type: 'address' }],
    ['Ella town, ඇල්ල නගරය, Police Station Road, Ella, Sri Lanka', { town: 'Ella', region: 'Hill country', type: 'address' }],
    ['Lighthouse Hotel, Colombo 03, Sri Lanka', { town: 'Colombo City', region: 'Colombo', type: 'address' }],
    ['Galle Face Green, Colombo, Sri Lanka', { town: 'Colombo City', region: 'Colombo', type: 'address' }],
  ])('%j', (place, want) => {
    expect(knownPlace(place)).toEqual(want);
  });

  // 2026-10-07: a third of paid bookings' ends read "Other" (52 of 156 since Sep 1). These are
  // the shapes behind it, taken from those bookings.
  it.each([
    // A town spelled as Google spells it, or a town near a catalogue one.
    ['Amba Kola Cafe & Hotel, Sugar Factory Road, Udawalawa, Sri Lanka', { town: 'Udawalawe', region: 'Safari south', type: 'address' }],
    ['Kaas Villas, Pehebiya Road, Dikwella, Sri Lanka', { town: 'Hiriketiya', region: 'South coast', type: 'address' }],
    ['Heritance Tea Factory, Tea Factory Road, Kandapola, Sri Lanka', { town: 'Nuwara Eliya', region: 'Hill country', type: 'address' }],
    ['Beliatta, Southern Province, Sri Lanka', { town: 'Tangalle', region: 'South coast', type: 'address' }],
    ['Beragala, Sri Lanka', { town: 'Haputale', region: 'Hill country', type: 'town' }],
    ['Roys Villa, Sigirya, Sri Lanka', { town: 'Sigiriya / Dambulla', region: 'Cultural triangle', type: 'address' }],
    ['Mount Lodge Boutique Hotel, Hotel Road, Dehiwala-Mount Lavinia, Sri Lanka', { town: 'Colombo City', region: 'Colombo', type: 'address' }],
    // Towns we report on but don't quote from (REPORT_ONLY_TOWNS).
    ['Avani Kalutara Resort, Kalutara, Sri Lanka', { town: 'Kalutara', region: 'South coast', type: 'address' }],
    ['The Glenrock Wellness Nature Resort, Galagama, Belihuloya, Sri Lanka', { town: 'Belihuloya', region: 'Hill country', type: 'address' }],
    ['Batticaloa, Sri Lanka', { town: 'Batticaloa', region: 'East coast', type: 'town' }],
    // A known town as whole words inside a name with no comma.
    ['Urban Galle Villa', { town: 'Galle', region: 'South coast', type: 'address' }],
    ['Hotel Cassendra - Hotels in Kandy', { town: 'Kandy', region: 'Hill country', type: 'address' }],
    ['The Ledge Ella', { town: 'Ella', region: 'Hill country', type: 'address' }],
    ['Aathi Beach Resort Uppuveli', { town: 'Trincomalee', region: 'East coast', type: 'address' }],
    ['Nuwara-Eliya', { town: 'Nuwara Eliya', region: 'Hill country', type: 'address' }],
  ])('%j', (place, want) => {
    expect(knownPlace(place)).toEqual(want);
  });

  it('an exact part beats a town inside a name', () => {
    expect(knownPlace('Kandy Hotel, Colombo, Sri Lanka').town).toBe('Colombo City');
    expect(knownPlace('Chill Vibes Hiriketiya, Hiriketiya Road, Dikwella, Sri Lanka').town).toBe('Hiriketiya');
  });

  it('a town name followed by a street word is a street, not the town', () => {
    for (const s of ['Galle Road Hotel, Wellawatte, Sri Lanka', 'Galle Face Hotel', 'Kandy Road, Kadawatha']) {
      expect(knownPlace(s), s).toEqual({ town: 'Other', region: 'Other', type: 'unknown' });
    }
  });

  it('matches whole tokens only — "Bella Vista" is not Ella', () => {
    expect(knownPlace('Bella Vista, Ratnapura, Sri Lanka')).toEqual({ town: 'Other', region: 'Other', type: 'unknown' });
    expect(knownPlace('Bella Vista Guest House')).toEqual({ town: 'Other', region: 'Other', type: 'unknown' });
  });

  it('never returns typed free text — an unknown place is "Other"', () => {
    for (const s of ['No 12 Temple Road Matara', 'my villa near the lighthouse', '', null, undefined]) {
      expect(knownPlace(s)).toEqual({ town: 'Other', region: 'Other', type: 'unknown' });
    }
  });

  it('covers every KNOWN_PLACES town with an alias and a region', () => {
    const aliased = new Set(ALIASES.map(([, town]) => town));
    for (const town of KNOWN_PLACES) {
      expect(aliased.has(town), `alias for ${town}`).toBe(true);
      expect(REGION_OF[town], `region for ${town}`).toBeTruthy();
    }
  });

  it('every alias is lower-case and points at a known town', () => {
    for (const [alias, town] of ALIASES) {
      expect(alias).toBe(alias.toLowerCase().trim());
      expect([...KNOWN_PLACES, ...REPORT_ONLY_TOWNS]).toContain(town);
    }
  });

  // Report-only towns stay out of KNOWN_PLACES: that list is the quote tool's offline autocomplete
  // and its distance pins, so a town added there changes quoting, not just reporting.
  it('report-only towns have a region and are not catalogue towns', () => {
    for (const town of REPORT_ONLY_TOWNS) {
      expect(REGION_OF[town], `region for ${town}`).toBeTruthy();
      expect(KNOWN_PLACES).not.toContain(town);
    }
  });
});

describe('docs/analytics/route-report.sql', () => {
  const sql = readFileSync(join(import.meta.dirname, '../../../../docs/analytics/route-report.sql'), 'utf8');
  const un = (s: string) => s.replace(/''/g, "'");
  const rows = [...sql.matchAll(/\('((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)'\)/g)]
    .map((m) => [un(m[1]), un(m[2]), un(m[3])]);

  it('carries exactly the ALIASES table, with REGION_OF regions', () => {
    const want = ALIASES.map(([alias, town]) => [alias, town, REGION_OF[town]]);
    expect(rows).toEqual(want);
  });
});

// The alias rows above are only half the rule: the report also has to MATCH the way knownPlace
// does. So run the file's own alias table and tok → matched → place CTEs on Postgres, fed these
// places instead of bookings, and compare every answer with knownPlace's.
const TEST_URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!TEST_URL)('docs/analytics/route-report.sql place rule (Postgres)', () => {
  const file = readFileSync(join(import.meta.dirname, '../../../../docs/analytics/route-report.sql'), 'utf8');
  const cut = (from: string, to: string): string => {
    const a = file.indexOf(from);
    const b = file.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error(`route-report.sql: no "${from}" … "${to}"`);
    return file.slice(a, b).trim().replace(/,$/, '');
  };
  const places = [
    'Colombo Airport (CMB)', 'Bandaranaike International Airport, Katunayake, Sri Lanka', 'Ella', 'Sigiriya',
    'Granbell Hotel Colombo, Marine Drive, Colombo, Sri Lanka',
    '84/2/A, Poruthota Road, Ethukale, Negombo, 11500 Negombo, Sri Lanka',
    'Ella town, ඇල්ල නගරය, Police Station Road, Ella, Sri Lanka', 'Lighthouse Hotel, Colombo 03, Sri Lanka',
    'Galle Face Green, Colombo, Sri Lanka',
    'Amba Kola Cafe & Hotel, Sugar Factory Road, Udawalawa, Sri Lanka', 'Kaas Villas, Pehebiya Road, Dikwella, Sri Lanka',
    'Heritance Tea Factory, Tea Factory Road, Kandapola, Sri Lanka', 'Beliatta, Southern Province, Sri Lanka',
    'Beragala, Sri Lanka', 'Roys Villa, Sigirya, Sri Lanka',
    'Mount Lodge Boutique Hotel, Hotel Road, Dehiwala-Mount Lavinia, Sri Lanka',
    'Avani Kalutara Resort, Kalutara, Sri Lanka', 'The Glenrock Wellness Nature Resort, Galagama, Belihuloya, Sri Lanka',
    'Batticaloa, Sri Lanka', 'Urban Galle Villa', 'Hotel Cassendra - Hotels in Kandy', 'The Ledge Ella',
    'Aathi Beach Resort Uppuveli', 'Nuwara-Eliya', 'Kandy Hotel, Colombo, Sri Lanka',
    'Chill Vibes Hiriketiya, Hiriketiya Road, Dikwella, Sri Lanka', 'Galle Road Hotel, Wellawatte, Sri Lanka',
    'Galle Face Hotel', 'Kandy Road, Kadawatha', 'Bella Vista, Ratnapura, Sri Lanka', 'Bella Vista Guest House',
    'No 12 Temple Road Matara', 'my villa near the lighthouse', 'Roys Villa', '',
  ];
  let db: ReturnType<typeof createDb>['sql'];

  beforeAll(() => { db = createDb(TEST_URL as string).sql; });
  afterAll(async () => { await db.end(); });

  it('names the same town as knownPlace for every sample place', async () => {
    const ends = places.map((p, i) => `(${i}, 'pickup', '${p.replace(/'/g, "''")}')`).join(',\n');
    const query = `${cut('with alias(', 'booking as (')},
ends(id, side, place) as (values ${ends}),
${cut('tok as (', 'money as (')}
select id, town from place order by id`;
    const got = await db.unsafe<{ id: number; town: string }[]>(query);
    expect(got.map((r) => [places[r.id], r.town])).toEqual(places.map((p) => [p, knownPlace(p).town]));
  });
});
