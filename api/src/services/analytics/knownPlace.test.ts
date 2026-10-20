import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_PLACES } from '../../adapters/maps';
import { ALIASES, REGION_OF, knownPlace } from './knownPlace';

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

  it('matches whole tokens only — "Bella Vista" is not Ella', () => {
    expect(knownPlace('Bella Vista, Ratnapura, Sri Lanka')).toEqual({ town: 'Other', region: 'Other', type: 'unknown' });
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
      expect(KNOWN_PLACES).toContain(town);
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
