import { desc } from 'drizzle-orm';
import type { Db } from './client';
import { rateCardRevisions } from './schema';
import { pgUniqueViolation } from './postgresBookingRepo';
import { RATE_CARD } from '../quote/rateCard';
import { ratesFromCard, readStoredRates, revisionVersion } from '../quote/rateRevision';
import { StaleRatesError, type NewRateRevision, type RateRevision, type RateRevisionRepo } from './rateRevisionRepo';

type Row = typeof rateCardRevisions.$inferSelect;
const DEFAULTS = ratesFromCard(RATE_CARD);

function toRevision(r: Row): RateRevision {
  return {
    id: r.id,
    seq: r.seq,
    version: r.version,
    rates: readStoredRates(r.rates, DEFAULTS),
    revertedToVersion: r.revertedToVersion,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}

export class PostgresRateRevisionRepo implements RateRevisionRepo {
  constructor(private readonly db: Db) {}

  async latest(): Promise<RateRevision | null> {
    const rows = await this.db.select().from(rateCardRevisions).orderBy(desc(rateCardRevisions.seq)).limit(1);
    return rows[0] ? toRevision(rows[0]) : null;
  }

  async list(): Promise<RateRevision[]> {
    const rows = await this.db.select().from(rateCardRevisions).orderBy(desc(rateCardRevisions.seq));
    return rows.map(toRevision);
  }

  async create(r: NewRateRevision, now: Date = new Date()): Promise<RateRevision> {
    const latest = await this.latest();
    if ((latest?.version ?? null) !== r.baseVersion) throw new StaleRatesError(latest);
    const seq = (latest?.seq ?? 0) + 1;
    try {
      const rows = await this.db
        .insert(rateCardRevisions)
        .values({
          seq,
          version: revisionVersion(now, seq),
          rates: r.rates,
          revertedToVersion: r.revertedToVersion ?? null,
          createdBy: r.createdBy,
          createdAt: now,
        })
        .returning();
      return toRevision(rows[0]);
    } catch (e) {
      // Two saves raced from the same base: the unique seq lets exactly one in.
      if (pgUniqueViolation(e)) throw new StaleRatesError(await this.latest());
      throw e;
    }
  }
}
