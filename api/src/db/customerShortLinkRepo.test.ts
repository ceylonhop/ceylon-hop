import { describe, expect, it } from 'vitest';
import {
  CustomerShortLinkCollisionError,
  InMemoryCustomerShortLinkRepo,
} from './customerShortLinkRepo';

const VIEW = { kind: 'quote_view' as const, quoteId: '11111111-2222-4333-8444-555555555555' };
const PAY = {
  kind: 'quote_pay' as const,
  quoteId: '11111111-2222-4333-8444-555555555555',
  revision: 3,
  seq: 1,
};

describe('InMemoryCustomerShortLinkRepo', () => {
  it('misses, then stores and resolves both legal target shapes', async () => {
    const repo = new InMemoryCustomerShortLinkRepo();
    expect(await repo.getByDigest('a'.repeat(64))).toBeNull();

    await repo.put('a'.repeat(64), VIEW);
    await repo.put('b'.repeat(64), PAY);

    expect(await repo.getByDigest('a'.repeat(64))).toEqual(VIEW);
    expect(await repo.getByDigest('b'.repeat(64))).toEqual(PAY);
  });

  it('is idempotent when the same digest names the same target', async () => {
    const repo = new InMemoryCustomerShortLinkRepo();
    await repo.put('a'.repeat(64), VIEW);
    await expect(repo.put('a'.repeat(64), { ...VIEW })).resolves.toBeUndefined();
    expect(await repo.getByDigest('a'.repeat(64))).toEqual(VIEW);
  });

  it('fails closed instead of retargeting a digest collision', async () => {
    const repo = new InMemoryCustomerShortLinkRepo();
    await repo.put('a'.repeat(64), VIEW);
    await expect(repo.put('a'.repeat(64), PAY)).rejects.toBeInstanceOf(CustomerShortLinkCollisionError);
    expect(await repo.getByDigest('a'.repeat(64))).toEqual(VIEW);
  });
});
