import { desc, eq } from 'drizzle-orm';
import type { Db } from './client';
import { coordinators } from './schema';
import type { CoordinatorRepo, Coordinator, NewCoordinator } from './coordinatorRepo';

type Row = typeof coordinators.$inferSelect;
const toCoordinator = (r: Row): Coordinator => ({
  id: r.id,
  name: r.name,
  whatsapp: r.whatsapp,
  regions: r.regions,
  active: r.active,
  createdAt: r.createdAt.toISOString(),
});

export class PostgresCoordinatorRepo implements CoordinatorRepo {
  constructor(private readonly db: Db) {}

  async create(c: NewCoordinator): Promise<Coordinator> {
    const [row] = await this.db
      .insert(coordinators)
      .values({ name: c.name, whatsapp: c.whatsapp, regions: c.regions ?? '' })
      .returning();
    return toCoordinator(row);
  }

  async get(id: string): Promise<Coordinator | null> {
    const [row] = await this.db.select().from(coordinators).where(eq(coordinators.id, id));
    return row ? toCoordinator(row) : null;
  }

  async list(opts?: { activeOnly?: boolean }): Promise<Coordinator[]> {
    const rows = await this.db.select().from(coordinators).orderBy(desc(coordinators.createdAt));
    const mapped = rows.map(toCoordinator);
    return opts?.activeOnly ? mapped.filter((c) => c.active) : mapped;
  }
}
