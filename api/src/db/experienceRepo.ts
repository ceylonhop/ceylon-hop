import { randomUUID } from 'node:crypto';
import type { Experience, ExperienceInput } from '../experiences/experience';

// The partner-experience catalogue (spec 2026-10-06 D4). No `remove`: interests reference an
// experience and the owner's counts need the history, so ops switches one off instead (spec D14).
export class SlugTakenError extends Error {
  constructor(slug: string) {
    super(`slug_taken: ${slug}`);
    this.name = 'SlugTakenError';
  }
}

export interface ExperiencePatch extends Partial<ExperienceInput> {
  updatedBy?: string | null;
}

export interface ExperienceRepo {
  /** Active first, then by name. */
  list(): Promise<Experience[]>;
  listActive(): Promise<Experience[]>;
  get(id: string): Promise<Experience | null>;
  getMany(ids: string[]): Promise<Experience[]>;
  /** Throws SlugTakenError when the slug exists. */
  create(e: ExperienceInput & { createdBy?: string | null }): Promise<Experience>;
  /** null for an unknown id; throws SlugTakenError when the new slug exists. */
  patch(id: string, p: ExperiencePatch): Promise<Experience | null>;
}

export function byActiveThenName(a: Experience, b: Experience): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export class InMemoryExperienceRepo implements ExperienceRepo {
  private rows = new Map<string, Experience>();

  async list(): Promise<Experience[]> {
    return [...this.rows.values()].map((r) => ({ ...r })).sort(byActiveThenName);
  }

  async listActive(): Promise<Experience[]> {
    return (await this.list()).filter((e) => e.active);
  }

  async get(id: string): Promise<Experience | null> {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }

  async getMany(ids: string[]): Promise<Experience[]> {
    return ids.flatMap((id) => {
      const r = this.rows.get(id);
      return r ? [{ ...r }] : [];
    });
  }

  async create(e: ExperienceInput & { createdBy?: string | null }): Promise<Experience> {
    this.assertSlugFree(e.slug);
    const { createdBy, ...fields } = e;
    const now = new Date();
    const row: Experience = {
      ...fields, id: randomUUID(), currency: 'USD', createdBy: createdBy ?? null, updatedBy: null,
      createdAt: now, updatedAt: now,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async patch(id: string, p: ExperiencePatch): Promise<Experience | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    if (p.slug !== undefined && p.slug !== row.slug) this.assertSlugFree(p.slug);
    for (const [k, v] of Object.entries(p)) {
      if (v !== undefined) (row as unknown as Record<string, unknown>)[k] = v;
    }
    row.updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
    return { ...row };
  }

  private assertSlugFree(slug: string): void {
    for (const r of this.rows.values()) if (r.slug === slug) throw new SlugTakenError(slug);
  }
}
