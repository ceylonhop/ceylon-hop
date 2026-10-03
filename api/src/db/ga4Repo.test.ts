import { describe, it, expect } from 'vitest';
import { InMemoryGa4EventLogRepo, InMemoryGaIdentityRepo, STALE_CLAIM_MS } from './ga4Repo';

const T0 = new Date('2026-10-03T10:00:00Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

describe('GA identity repo', () => {
  it('stores and returns the latest identity per booking', async () => {
    const repo = new InMemoryGaIdentityRepo();
    expect(await repo.get('b1')).toBeNull();
    await repo.set('b1', { clientId: '111.222', sessionId: '1700000000', adConsent: 'unknown' });
    await repo.set('b1', { clientId: '333.444', sessionId: null, adConsent: 'granted' });
    expect(await repo.get('b1')).toEqual({ clientId: '333.444', sessionId: null, adConsent: 'granted' });
  });
});

describe('GA4 event ledger', () => {
  it('first claim wins and stores the payload; a second claim gets nothing', async () => {
    const log = new InMemoryGa4EventLogRepo();
    expect(await log.claim('purchase:p1', 'purchase', { a: 1 }, T0)).toEqual({ eventKey: 'purchase:p1', kind: 'purchase', payload: { a: 1 }, attempts: 1 });
    expect(await log.claim('purchase:p1', 'purchase', { a: 2 }, T0)).toBeNull();
  });
  it('a sent event can never be claimed again', async () => {
    const log = new InMemoryGa4EventLogRepo();
    await log.claim('k', 'refund', {}, T0);
    await log.markSent('k', T0);
    expect(await log.claim('k', 'refund', {}, later(STALE_CLAIM_MS * 10))).toBeNull();
  });
  it('markFailed after markSent leaves it sent — never claimable or retryable', async () => {
    const log = new InMemoryGa4EventLogRepo();
    await log.claim('k', 'purchase', {}, T0);
    await log.markSent('k', T0);
    await log.markFailed('k', 'late_error_from_a_stale_process');
    const farLater = later(STALE_CLAIM_MS * 10);
    expect(await log.claim('k', 'purchase', {}, farLater)).toBeNull();
    expect(await log.listRetryable(new Date(0), farLater)).toEqual([]);
  });
  it('a failed event is re-claimable, keeps its FIRST payload, and counts attempts', async () => {
    const log = new InMemoryGa4EventLogRepo();
    await log.claim('k', 'purchase', { first: true }, T0);
    await log.markFailed('k', 'ga4_send_failed_500');
    const again = await log.claim('k', 'purchase', { first: false }, later(1000));
    expect(again).toEqual({ eventKey: 'k', kind: 'purchase', payload: { first: true }, attempts: 2 });
  });
  it('a claim abandoned for longer than STALE_CLAIM_MS is retryable; a fresh one is not', async () => {
    const log = new InMemoryGa4EventLogRepo();
    await log.claim('k', 'purchase', {}, T0);
    expect(await log.listRetryable(new Date(0), later(STALE_CLAIM_MS - 1))).toEqual([]);
    expect((await log.listRetryable(new Date(0), later(STALE_CLAIM_MS + 1))).map((r) => r.eventKey)).toEqual(['k']);
  });
  it('listRetryable ignores rows created before `since` (the 72 h MP window)', async () => {
    const log = new InMemoryGa4EventLogRepo();
    await log.claim('old', 'purchase', {}, T0);
    await log.markFailed('old', 'x');
    expect(await log.listRetryable(later(1), later(2))).toEqual([]);
  });
});
