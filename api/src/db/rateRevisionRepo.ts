import { randomUUID } from 'node:crypto';
import { revisionVersion, type RateInputs } from '../quote/rateRevision';

// One saved rate set (spec 2026-09-26 §8.1). Append-only: a change or a revert is a NEW row, so the
// history of who set which prices, and when, is never rewritten.
export interface RateRevision {
  id: string;
  seq: number;
  version: string;
  rates: RateInputs;
  revertedToVersion: string | null;
  createdBy: string;
  createdAt: Date;
}

export interface NewRateRevision {
  rates: RateInputs;
  // The version the editor opened (null = no revision yet, i.e. the code defaults). A save is
  // refused when a newer revision exists, so two editors can never silently overwrite each other.
  baseVersion: string | null;
  revertedToVersion?: string | null;
  createdBy: string;
}

export class StaleRatesError extends Error {
  constructor(readonly current: RateRevision | null) {
    super('stale_rates');
    this.name = 'StaleRatesError';
  }
}

export interface RateRevisionRepo {
  latest(): Promise<RateRevision | null>;
  list(): Promise<RateRevision[]>; // newest first
  create(r: NewRateRevision, now?: Date): Promise<RateRevision>;
}

export class InMemoryRateRevisionRepo implements RateRevisionRepo {
  private rows: RateRevision[] = [];

  async latest(): Promise<RateRevision | null> {
    return this.rows[this.rows.length - 1] ?? null;
  }

  async list(): Promise<RateRevision[]> {
    return [...this.rows].reverse();
  }

  async create(r: NewRateRevision, now: Date = new Date()): Promise<RateRevision> {
    const latest = await this.latest();
    if ((latest?.version ?? null) !== r.baseVersion) throw new StaleRatesError(latest);
    const seq = (latest?.seq ?? 0) + 1;
    const row: RateRevision = {
      id: randomUUID(),
      seq,
      version: revisionVersion(now, seq),
      rates: structuredClone(r.rates),
      revertedToVersion: r.revertedToVersion ?? null,
      createdBy: r.createdBy,
      createdAt: now,
    };
    this.rows.push(row);
    return row;
  }
}
