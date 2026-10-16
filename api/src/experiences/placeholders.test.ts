import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PLACEHOLDERS, placeholderSql } from './placeholders';
import { ExperienceInputSchema } from './experience';
import { matchExperiences } from './match';

// Spec D20: three Sigiriya placeholders for staging tests, loaded by SQL paste. The point of the test
// is the geometry: they must show for a Sigiriya drop-off and for NO other catalogue place, so a
// staging tester can see the "no section" case on Kandy / Ella / the airport.
const ROOT = resolve(__dirname, '../../..');
const places = [...readFileSync(resolve(ROOT, 'transfers-data.js'), 'utf8')
  .matchAll(/\{\s*id:\s*'([^']+)',\s*name:\s*'([^']+)'[^}]*?lat:\s*(-?\d+(?:\.\d+)?),\s*lng:\s*(-?\d+(?:\.\d+)?)\s*\}/g)]
  .map((m) => ({ id: m[1]!, label: m[2]!, lat: Number(m[3]), lng: Number(m[4]) }));

const asExperiences = PLACEHOLDERS.map((p, i) => ({ ...p, id: `p${i}` }));
const matchesAt = (pt: { label: string; lat: number; lng: number }) =>
  matchExperiences([pt], asExperiences)[0]?.items.map((m) => m.experience.id) ?? [];

describe('staging placeholders (spec D20)', () => {
  it('reads the whole catalogue, with Sigiriya where the plan says', () => {
    expect(places.length).toBeGreaterThanOrEqual(19);
    const s = places.find((p) => p.id === 'sigiriya')!;
    expect([s.lat, s.lng]).toEqual([7.95, 80.76]);
  });

  it('is exactly three valid, placeholder-slugged experiences reaching at most 10 km', () => {
    expect(PLACEHOLDERS).toHaveLength(3);
    for (const p of PLACEHOLDERS) {
      expect(ExperienceInputSchema.safeParse(p).success, p.slug).toBe(true);
      expect(p.slug).toMatch(/^placeholder-/);
      expect(p.radiusKm).toBeLessThanOrEqual(10);
      expect(p.details.startsWith('PLACEHOLDER for staging tests.')).toBe(true);
    }
  });

  it('all three match a Sigiriya drop-off', () => {
    const s = places.find((p) => p.id === 'sigiriya')!;
    expect(matchesAt(s).sort()).toEqual(['p0', 'p1', 'p2']);
  });

  it('none matches any other catalogue place', () => {
    for (const p of places.filter((x) => x.id !== 'sigiriya')) expect(matchesAt(p), p.id).toEqual([]);
  });

  it('the committed SQL file equals the generator output', () => {
    expect(readFileSync(resolve(ROOT, 'api/scripts/experience-placeholders.sql'), 'utf8')).toBe(placeholderSql());
  });

  it('the SQL is a staging-only, idempotent insert and nothing else', () => {
    const sql = placeholderSql();
    expect(sql).toContain('STAGING ONLY');
    expect(sql).toContain('ON CONFLICT ("slug") DO NOTHING');
    expect(sql).toContain("'placeholder-seed'");
    const statements = sql.replace(/^--.*$/gm, '');
    expect(statements).not.toMatch(/\b(delete|update|drop|alter|truncate)\b/i);
    expect(statements.match(/INSERT INTO "experiences"/g)).toHaveLength(1);
  });
});
