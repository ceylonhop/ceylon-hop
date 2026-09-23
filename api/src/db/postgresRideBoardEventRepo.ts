import { asc, gte } from 'drizzle-orm';
import type { Db } from './client';
import { rideBoardEvents } from './schema';
import {
  toEvent,
  type RideBoardAction,
  type RideBoardEvent,
  type RideBoardEventInput,
  type RideBoardEventRepo,
  type RideBoardOutcome,
} from './rideBoardEventRepo';

export class PostgresRideBoardEventRepo implements RideBoardEventRepo {
  constructor(private readonly db: Db) {}

  async record(e: RideBoardEventInput, now: Date = new Date()): Promise<void> {
    await this.db.insert(rideBoardEvents).values(toEvent(e, now));
  }

  async since(from: Date): Promise<RideBoardEvent[]> {
    const rows = await this.db
      .select()
      .from(rideBoardEvents)
      .where(gte(rideBoardEvents.at, from))
      .orderBy(asc(rideBoardEvents.at));
    return rows.map((r) => ({ ...r, action: r.action as RideBoardAction, outcome: r.outcome as RideBoardOutcome }));
  }
}
