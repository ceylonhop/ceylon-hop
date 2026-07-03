import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { conciergeTasks } from './schema';
import type {
  ConciergeTaskRepo,
  ConciergeTask,
  ConciergeTaskType,
  ConciergeTaskStatus,
} from './conciergeTaskRepo';

type Row = typeof conciergeTasks.$inferSelect;
const toTask = (r: Row): ConciergeTask => ({
  id: r.id,
  bookingId: r.bookingId,
  type: r.type as ConciergeTaskType,
  status: r.status as ConciergeTaskStatus,
  note: r.note,
  createdAt: r.createdAt.toISOString(),
});

export class PostgresConciergeTaskRepo implements ConciergeTaskRepo {
  constructor(private readonly db: Db) {}

  async create(t: { bookingId: string; type: ConciergeTaskType; note?: string }): Promise<ConciergeTask> {
    const [row] = await this.db
      .insert(conciergeTasks)
      .values({ bookingId: t.bookingId, type: t.type, status: 'open', note: t.note ?? null })
      .returning();
    return toTask(row);
  }

  async listByBooking(bookingId: string): Promise<ConciergeTask[]> {
    const rows = await this.db
      .select()
      .from(conciergeTasks)
      .where(eq(conciergeTasks.bookingId, bookingId));
    return rows.map(toTask);
  }

  async list(): Promise<ConciergeTask[]> {
    const rows = await this.db.select().from(conciergeTasks);
    return rows.map(toTask);
  }
}
