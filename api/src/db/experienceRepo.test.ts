import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';
import { InMemoryExperienceRepo, SlugTakenError, type ExperienceRepo } from './experienceRepo';
import { PostgresExperienceRepo } from './postgresExperienceRepo';
import { ExperienceInputSchema, type ExperienceInput } from '../experiences/experience';

// One contract, two implementations: the in-memory fake the route tests lean on must behave like
// the Postgres repo, or those tests prove nothing.
const TEST_URL = process.env.DATABASE_URL_TEST;
// The test database outlives the run and is shared, so every Postgres row carries a per-run prefix.
const PREFIX = `t${Date.now()}-`;

function input(slug: string, over: Partial<ExperienceInput> = {}): ExperienceInput {
  return ExperienceInputSchema.parse({
    slug, name: `Name ${slug}`, partnerName: 'Atherya Spa', areaLabel: 'Sigiriya',
    summary: 'A summary.', details: 'Some details.', priceCents: 3500, priceUnit: 'per_person',
    durationText: '90 min', openWeekdays: [1, 2, 3], startTimes: ['09:00', '14:30'],
    lat: 7.977, lng: 80.76, radiusKm: 8, photos: ['guides/sigiriya/ayurveda'], partnerContact: '+94 77 000 0000',
    active: true, ...over,
  });
}

function contract(name: string, make: () => Promise<ExperienceRepo>, slugPrefix: string) {
  describe(name, () => {
    let repo: ExperienceRepo;
    beforeAll(async () => { repo = await make(); });
    const s = (x: string) => `${slugPrefix}${x}`;

    it('create -> get round-trips every field, arrays included, currency USD', async () => {
      const made = await repo.create({ ...input(s('round-trip')), createdBy: 'ops@x.com' });
      expect(made.currency).toBe('USD');
      const got = await repo.get(made.id);
      expect(got).toMatchObject({
        slug: s('round-trip'), name: `Name ${s('round-trip')}`, partnerName: 'Atherya Spa', areaLabel: 'Sigiriya',
        summary: 'A summary.', details: 'Some details.', priceCents: 3500, currency: 'USD', priceUnit: 'per_person',
        durationText: '90 min', openWeekdays: [1, 2, 3], startTimes: ['09:00', '14:30'], lat: 7.977, lng: 80.76,
        radiusKm: 8, photos: ['guides/sigiriya/ayurveda'], partnerContact: '+94 77 000 0000', active: true,
        createdBy: 'ops@x.com', updatedBy: null,
      });
      expect(got!.createdAt).toBeInstanceOf(Date);
      expect(got!.updatedAt).toBeInstanceOf(Date);
    });

    it('get of an unknown id is null', async () => {
      expect(await repo.get('00000000-0000-4000-8000-000000000000')).toBeNull();
    });

    it('listActive excludes inactive; list orders active first, then name', async () => {
      const b = await repo.create(input(s('ord-b'), { name: `${slugPrefix}B` }));
      const a = await repo.create(input(s('ord-a'), { name: `${slugPrefix}A` }));
      const off = await repo.create(input(s('ord-off'), { name: `${slugPrefix}0 off`, active: false }));
      const active = (await repo.listActive()).map((e) => e.id);
      expect(active).toContain(a.id);
      expect(active).not.toContain(off.id);
      const mine = (await repo.list()).filter((e) => [a.id, b.id, off.id].includes(e.id)).map((e) => e.id);
      expect(mine).toEqual([a.id, b.id, off.id]);
    });

    it('getMany returns only the asked ids, and [] for none', async () => {
      const x = await repo.create(input(s('many-x')));
      const y = await repo.create(input(s('many-y')));
      await repo.create(input(s('many-z')));
      expect((await repo.getMany([x.id, y.id])).map((e) => e.id).sort()).toEqual([x.id, y.id].sort());
      expect(await repo.getMany([])).toEqual([]);
    });

    it('patch changes only the given fields and bumps updatedAt', async () => {
      const made = await repo.create(input(s('patch')));
      await new Promise((r) => setTimeout(r, 5));
      const patched = await repo.patch(made.id, { priceCents: 4000, active: false, updatedBy: 'f@x.com' });
      expect(patched).toMatchObject({
        priceCents: 4000, active: false, updatedBy: 'f@x.com',
        name: made.name, summary: made.summary, openWeekdays: [1, 2, 3], photos: ['guides/sigiriya/ayurveda'],
        partnerContact: '+94 77 000 0000',
      });
      expect(patched!.updatedAt.getTime()).toBeGreaterThan(made.updatedAt.getTime());
      expect((await repo.get(made.id))!.priceCents).toBe(4000);
    });

    it('patch can clear a nullable field', async () => {
      const made = await repo.create(input(s('clear')));
      expect((await repo.patch(made.id, { partnerContact: null, durationText: null }))).toMatchObject({
        partnerContact: null, durationText: null,
      });
    });

    it('patch of an unknown id is null', async () => {
      expect(await repo.patch('00000000-0000-4000-8000-000000000000', { active: false })).toBeNull();
    });

    it('a duplicate slug is a SlugTakenError on create and on patch', async () => {
      const first = await repo.create(input(s('dup-1')));
      const second = await repo.create(input(s('dup-2')));
      await expect(repo.create(input(s('dup-1')))).rejects.toBeInstanceOf(SlugTakenError);
      await expect(repo.patch(second.id, { slug: first.slug })).rejects.toBeInstanceOf(SlugTakenError);
      // patching to its own slug is not a clash
      expect(await repo.patch(first.id, { slug: first.slug })).not.toBeNull();
    });
  });
}

contract('InMemoryExperienceRepo', async () => new InMemoryExperienceRepo(), 'mem-');

describe.skipIf(!TEST_URL)('PostgresExperienceRepo', () => {
  contract('PostgresExperienceRepo contract', async () => {
    const conn = createDb(TEST_URL as string);
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    return new PostgresExperienceRepo(conn.db);
  }, PREFIX);
});
