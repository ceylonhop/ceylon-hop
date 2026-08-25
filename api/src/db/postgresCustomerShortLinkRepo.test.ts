import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Sql } from './client';
import { PostgresQuoteRepo } from './postgresQuoteRepo';
import { PostgresCustomerShortLinkRepo } from './postgresCustomerShortLinkRepo';
import { CustomerShortLinkCollisionError } from './customerShortLinkRepo';
import { createHash } from 'node:crypto';

const TEST_URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!TEST_URL)('PostgresCustomerShortLinkRepo (integration)', () => {
  let repo: PostgresCustomerShortLinkRepo;
  let quoteId: string;
  let sql: Sql;

  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    sql = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    repo = new PostgresCustomerShortLinkRepo(conn.db);
    const quote = await new PostgresQuoteRepo(conn.db).save({
      channel: 'ops',
      product: 'private',
      vehicle: 'car',
      customerName: 'Short Link Test',
      totalCents: 12000,
      currency: 'USD',
      rateCardVersion: 'short-link-test',
      request: {},
      result: {},
    });
    quoteId = quote.id;
  });

  const digest = (label: string) => createHash('sha256').update(`${label}:${quoteId}`).digest('hex');

  it('stores, resolves, and idempotently re-stores both target shapes', async () => {
    const view = { kind: 'quote_view' as const, quoteId };
    const pay = { kind: 'quote_pay' as const, quoteId, revision: 4, seq: 2 };
    const viewDigest = digest('view');
    const payDigest = digest('pay');

    await repo.put(viewDigest, view);
    await repo.put(viewDigest, view);
    await repo.put(payDigest, pay);

    expect(await repo.getByDigest(viewDigest)).toEqual(view);
    expect(await repo.getByDigest(payDigest)).toEqual(pay);
  });

  it('fails closed on a digest collision and preserves the original target', async () => {
    const collisionDigest = digest('collision');
    const original = { kind: 'quote_view' as const, quoteId };
    await repo.put(collisionDigest, original);
    await expect(repo.put(collisionDigest, {
      kind: 'quote_pay', quoteId, revision: 1, seq: 0,
    })).rejects.toBeInstanceOf(CustomerShortLinkCollisionError);
    expect(await repo.getByDigest(collisionDigest)).toEqual(original);
  });

  it('enforces legal kind/revision/sequence shapes in Postgres', async () => {
    await expect(sql`
      insert into customer_short_links
        (code_digest, kind, quote_id, quote_revision, pay_link_seq)
      values ('NOT-A-SHA256-DIGEST', 'quote_view', ${quoteId}, null, null)
    `).rejects.toBeTruthy();
    await expect(sql`
      insert into customer_short_links
        (code_digest, kind, quote_id, quote_revision, pay_link_seq)
      values (${digest('invalid-shape')}, 'quote_view', ${quoteId}, 1, null)
    `).rejects.toBeTruthy();
    await expect(sql`
      insert into customer_short_links
        (code_digest, kind, quote_id, quote_revision, pay_link_seq)
      values (${digest('missing-pay-seq')}, 'quote_pay', ${quoteId}, 1, null)
    `).rejects.toBeTruthy();
    await expect(sql`
      insert into customer_short_links
        (code_digest, kind, quote_id, quote_revision, pay_link_seq)
      values (${digest('missing-pay-revision')}, 'quote_pay', ${quoteId}, null, 0)
    `).rejects.toBeTruthy();
    await expect(sql`
      insert into customer_short_links
        (code_digest, kind, quote_id, quote_revision, pay_link_seq)
      values (${digest('invalid-kind')}, 'quote_other', ${quoteId}, null, null)
    `).rejects.toBeTruthy();
    await expect(sql`
      insert into customer_short_links
        (code_digest, kind, quote_id, quote_revision, pay_link_seq)
      values (${digest('zero-revision')}, 'quote_pay', ${quoteId}, 0, 0)
    `).rejects.toBeTruthy();
    await expect(sql`
      insert into customer_short_links
        (code_digest, kind, quote_id, quote_revision, pay_link_seq)
      values (${digest('negative-revision')}, 'quote_pay', ${quoteId}, -1, 0)
    `).rejects.toBeTruthy();
    await expect(sql`
      insert into customer_short_links
        (code_digest, kind, quote_id, quote_revision, pay_link_seq)
      values (${digest('negative-sequence')}, 'quote_pay', ${quoteId}, 1, -1)
    `).rejects.toBeTruthy();
  });

  it('cascades aliases when a quote is hard-deleted', async () => {
    const quote = await new PostgresQuoteRepo(createDb(TEST_URL as string).db).save({
      channel: 'ops', product: 'private', vehicle: 'car', totalCents: 1000, currency: 'USD',
      rateCardVersion: 'short-link-cascade', request: {}, result: {},
    });
    const cascadeDigest = createHash('sha256').update(`cascade:${quote.id}`).digest('hex');
    await repo.put(cascadeDigest, { kind: 'quote_view', quoteId: quote.id });
    await sql`delete from quotes where id = ${quote.id}`;
    expect(await repo.getByDigest(cascadeDigest)).toBeNull();
  });
});
