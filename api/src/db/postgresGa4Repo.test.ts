import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Sql } from './client';
import { PostgresGa4EventLogRepo, PostgresGaIdentityRepo } from './postgresGa4Repo';
import { STALE_CLAIM_MS } from './ga4Repo';

const TEST_URL = process.env.DATABASE_URL_TEST;

// The in-memory repos back every route test; only a real Postgres proves migration 0063, the
// column mapping, the Date binding (#546) and — above all — that the ON CONFLICT claim is the
// atomic arbiter of "exactly once".
describe.skipIf(!TEST_URL)('Postgres GA4 repos (integration)', () => {
  let identities: PostgresGaIdentityRepo;
  let log: PostgresGa4EventLogRepo;
  let sql: Sql;
  // A per-run prefix so reruns never collide and cleanup touches only this run's rows.
  const run = randomUUID().slice(0, 8);
  const key = (name: string) => `test-${run}:${name}`;
  const bookingIds: string[] = [];
  const newBookingId = () => { const id = randomUUID(); bookingIds.push(id); return id; };

  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    sql = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    identities = new PostgresGaIdentityRepo(conn.db);
    log = new PostgresGa4EventLogRepo(conn.db);
  });

  afterAll(async () => {
    await sql`DELETE FROM ga4_event_log WHERE event_key LIKE ${`test-${run}:%`}`;
    if (bookingIds.length) await sql`DELETE FROM booking_ga_identity WHERE booking_id IN ${sql(bookingIds)}`;
  });

  it('identity: stores and returns the latest identity per booking', async () => {
    const id = newBookingId();
    expect(await identities.get(id)).toBeNull();
    await identities.set(id, { clientId: '111.222', sessionId: '1700000000', adConsent: 'unknown' });
    await identities.set(id, { clientId: '333.444', sessionId: null, adConsent: 'granted' });
    expect(await identities.get(id)).toEqual({ clientId: '333.444', sessionId: null, adConsent: 'granted' });
  });

  it('first claim wins and stores the payload; a second claim gets nothing', async () => {
    const k = key('first');
    expect(await log.claim(k, 'purchase', { a: 1 }, new Date())).toEqual({ eventKey: k, kind: 'purchase', payload: { a: 1 }, attempts: 1 });
    expect(await log.claim(k, 'purchase', { a: 2 }, new Date())).toBeNull();
  });

  it('payloadOf returns the stored payload, or null when there is no row', async () => {
    const k = key('payload-of');
    expect(await log.payloadOf(k)).toBeNull();
    await log.claim(k, 'purchase', { a: 1, nested: { b: 'x' } }, new Date());
    expect(await log.payloadOf(k)).toEqual({ a: 1, nested: { b: 'x' } });
  });

  it('two concurrent claims on a new key: exactly one wins', async () => {
    const k = key('race');
    const results = await Promise.all([
      log.claim(k, 'purchase', { n: 1 }, new Date()),
      log.claim(k, 'purchase', { n: 2 }, new Date()),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('a sent event can never be claimed again', async () => {
    const k = key('sent');
    const t0 = new Date();
    await log.claim(k, 'refund', {}, t0);
    await log.markSent(k, t0);
    expect(await log.claim(k, 'refund', {}, new Date(t0.getTime() + STALE_CLAIM_MS * 10))).toBeNull();
  });

  it('markFailed after markSent leaves it sent — never claimable or retryable', async () => {
    const k = key('sent-then-failed');
    const t0 = new Date();
    await log.claim(k, 'purchase', {}, t0);
    await log.markSent(k, t0);
    await log.markFailed(k, 'late_error_from_a_stale_process');
    const farLater = new Date(t0.getTime() + STALE_CLAIM_MS * 10);
    expect(await log.claim(k, 'purchase', {}, farLater)).toBeNull();
    expect((await log.listRetryable(new Date(t0.getTime() - 60_000), farLater, 10_000)).map((r) => r.eventKey)).not.toContain(k);
  });

  it('a failed event is re-claimable, keeps its FIRST payload, and counts attempts', async () => {
    const k = key('failed');
    const t0 = new Date();
    await log.claim(k, 'purchase', { first: true }, t0);
    await log.markFailed(k, 'ga4_send_failed_500');
    const again = await log.claim(k, 'purchase', { first: false }, new Date(t0.getTime() + 1000));
    expect(again).toEqual({ eventKey: k, kind: 'purchase', payload: { first: true }, attempts: 2 });
  });

  it('a claim abandoned for longer than STALE_CLAIM_MS is retryable; a fresh one is not', async () => {
    const k = key('stale');
    const t0 = new Date();
    const since = new Date(t0.getTime() - 60_000);
    await log.claim(k, 'purchase', {}, t0);
    const keys = async (now: Date) => (await log.listRetryable(since, now, 10_000)).map((r) => r.eventKey);
    expect(await keys(new Date(t0.getTime() + STALE_CLAIM_MS - 1))).not.toContain(k);
    expect(await keys(new Date(t0.getTime() + STALE_CLAIM_MS + 1))).toContain(k);
    // …and a take-over after the stale window succeeds, a take-over inside it does not.
    expect(await log.claim(k, 'purchase', {}, new Date(t0.getTime() + STALE_CLAIM_MS - 1))).toBeNull();
    expect((await log.claim(k, 'purchase', {}, new Date(t0.getTime() + STALE_CLAIM_MS + 1)))?.attempts).toBe(2);
  });

  it('listRetryable ignores rows created before `since` (the 72 h MP window)', async () => {
    const k = key('old');
    await log.claim(k, 'purchase', {}, new Date());
    await log.markFailed(k, 'x');
    const future = new Date(Date.now() + 3_600_000);
    expect((await log.listRetryable(future, future, 10_000)).map((r) => r.eventKey)).not.toContain(k);
    expect((await log.listRetryable(new Date(Date.now() - 3_600_000), future, 10_000)).map((r) => r.eventKey)).toContain(k);
  });

  it('listRetryable caps the batch at `limit`, as a prefix of the oldest-first list', async () => {
    const ks = [key('cap1'), key('cap2'), key('cap3')];
    for (const k of ks) {
      await log.claim(k, 'purchase', {}, new Date());
      await log.markFailed(k, 'x');
    }
    const since = new Date(Date.now() - 3_600_000);
    const future = new Date(Date.now() + 3_600_000);
    const keys = async (limit: number) => (await log.listRetryable(since, future, limit)).map((r) => r.eventKey);
    const all = await keys(10_000);
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(await keys(2)).toEqual(all.slice(0, 2));
  });
});
