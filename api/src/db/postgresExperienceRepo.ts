import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from './client';
import { experiences } from './schema';
import { pgUniqueViolation } from './postgresBookingRepo';
import { SlugTakenError, type ExperiencePatch, type ExperienceRepo } from './experienceRepo';
import type { Experience, ExperienceInput } from '../experiences/experience';

type Row = typeof experiences.$inferSelect;

function toExperience(r: Row): Experience {
  return {
    id: r.id, slug: r.slug, name: r.name, partnerName: r.partnerName, areaLabel: r.areaLabel,
    summary: r.summary, details: r.details, priceCents: r.priceCents, currency: 'USD',
    priceUnit: r.priceUnit as Experience['priceUnit'], durationText: r.durationText,
    openWeekdays: r.openWeekdays, startTimes: r.startTimes, lat: r.lat, lng: r.lng, radiusKm: r.radiusKm,
    photos: r.photos, partnerContact: r.partnerContact, active: r.active,
    createdBy: r.createdBy, updatedBy: r.updatedBy, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

// Drizzle wraps the driver error, so the unique violation is found by walking `.cause`
// (pgUniqueViolation) — a bare `err.code === '23505'` would miss it and the route would 500, not 409.
function mapSlugClash(err: unknown, slug: string | undefined): never {
  if (pgUniqueViolation(err)?.constraint === 'experiences_slug_unique') throw new SlugTakenError(slug ?? '');
  throw err;
}

export class PostgresExperienceRepo implements ExperienceRepo {
  constructor(private readonly db: Db) {}

  async list(): Promise<Experience[]> {
    const rows = await this.db.select().from(experiences).orderBy(desc(experiences.active), asc(experiences.name));
    return rows.map(toExperience);
  }

  async listActive(): Promise<Experience[]> {
    const rows = await this.db.select().from(experiences).where(eq(experiences.active, true)).orderBy(asc(experiences.name));
    return rows.map(toExperience);
  }

  async get(id: string): Promise<Experience | null> {
    const rows = await this.db.select().from(experiences).where(eq(experiences.id, id)).limit(1);
    return rows[0] ? toExperience(rows[0]) : null;
  }

  async getMany(ids: string[]): Promise<Experience[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.select().from(experiences).where(inArray(experiences.id, ids));
    return rows.map(toExperience);
  }

  async create(e: ExperienceInput & { createdBy?: string | null }): Promise<Experience> {
    try {
      const rows = await this.db.insert(experiences).values({ ...e, createdBy: e.createdBy ?? null }).returning();
      return toExperience(rows[0]!);
    } catch (err) {
      return mapSlugClash(err, e.slug);
    }
  }

  async patch(id: string, p: ExperiencePatch): Promise<Experience | null> {
    // Build the SET map from only the provided fields, so a partial patch never clobbers a column.
    const set: Partial<typeof experiences.$inferInsert> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(p)) {
      if (v !== undefined) (set as Record<string, unknown>)[k] = v;
    }
    try {
      const rows = await this.db.update(experiences).set(set).where(eq(experiences.id, id)).returning();
      return rows[0] ? toExperience(rows[0]) : null;
    } catch (err) {
      return mapSlugClash(err, p.slug);
    }
  }
}
