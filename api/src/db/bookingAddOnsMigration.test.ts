import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';
import { PostgresBookingRepo } from './postgresBookingRepo';

const TEST_URL = process.env.DATABASE_URL_TEST;

// Add-ons after booking (spec 2026-11-14 §5): a request and its lines, each line on one stored leg,
// plus the payment purpose and the two email kinds they need.
const TAG = '0079_booking_add_ons';
const migration = readFileSync(new URL(`../../drizzle/${TAG}.sql`, import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

// The list as of 0077, which this migration must keep verbatim.
const OLD_KINDS = ['confirmation', 'details_needed', 'booking_confirmed', 'cancellation', 'refund', 'no_show_notice',
  'trip_reminder', 'review_request', 'payment_recovery', 'payment_failed', 'deposit_received', 'balance_received',
  'schedule_set', 'details_reminder_1', 'details_reminder_2', 'pay_on_day_confirmed'];
const NEW_KINDS = ['add_on_request', 'add_on_paid'];

describe(TAG, () => {
  it('creates both tables and protects them with row-level security', () => {
    expect(sql).toMatch(/create table if not exists "booking_add_on_requests"/i);
    expect(sql).toMatch(/create table if not exists "booking_add_ons"/i);
    expect(sql).toMatch(/alter table "booking_add_on_requests" enable row level security;/i);
    expect(sql).toMatch(/alter table "booking_add_ons" enable row level security;/i);
  });

  it('keeps every existing payment purpose and adds add_on', () => {
    expect(sql).toMatch(/"purpose" in \('full', 'deposit', 'balance', 'add_on'\)/);
  });

  it('keeps every existing email kind and adds the two add-on kinds', () => {
    for (const k of [...OLD_KINDS, ...NEW_KINDS]) expect(sql).toContain(`'${k}'`);
  });

  it('can be run again: nothing is created or added without a guard', () => {
    expect(sql.match(/create table (?!if not exists)/gi)).toBeNull();
    expect(sql.match(/create index (?!if not exists)/gi)).toBeNull();
    const added = [...sql.matchAll(/alter table "(\w+)" add constraint "(\w+)"/gi)].map((m) => `${m[1]}.${m[2]}`);
    const dropped = [...sql.matchAll(/alter table "(\w+)" drop constraint if exists "(\w+)"/gi)].map((m) => `${m[1]}.${m[2]}`);
    expect(added.sort()).toEqual(['customer_communications.customer_communications_kind_valid', 'payments.payments_purpose_valid']);
    expect(dropped.sort()).toEqual(added.sort());
  });

  it('changes no rows and drops no table or column', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+table|drop\s+column)\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
  });

  it('is journalled after every earlier migration (drizzle skips an older `when`)', () => {
    const me = journal.entries.find((e) => e.tag === TAG);
    expect(me).toBeTruthy();
    const earlier = journal.entries.filter((e) => e.idx < me!.idx).map((e) => e.when);
    expect(me!.when).toBeGreaterThan(Math.max(...earlier));
    expect(new Set(journal.entries.map((e) => e.idx)).size).toBe(journal.entries.length);
  });
});

describe.skipIf(!TEST_URL)(`${TAG} (Postgres)`, () => {
  let conn: ReturnType<typeof createDb>;
  let bookingId: string;
  let legId: string;

  beforeAll(async () => {
    conn = createDb(TEST_URL as string);
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    const b = await new PostgresBookingRepo(conn.db).create({
      mode: 'single', total: 12100, amountDueNow: 12100, currency: 'USD',
      input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1, date: '2026-12-10', time: '09:00',
        customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' } },
    });
    bookingId = b.id;
    [{ id: legId }] = await conn.sql<{ id: string }[]>`select id from booking_legs where booking_id = ${bookingId} limit 1`;
  });
  afterAll(() => conn?.sql.end());

  const columns = async (table: string) => {
    const rows = await conn.sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = ${table}`;
    return Object.fromEntries(rows.map((r) => [r.column_name, `${r.data_type}${r.is_nullable === 'YES' ? ' null' : ''}`]));
  };

  // Each request takes the next seq on its own, so a case never trips over another's rows.
  let nextSeq = 100;
  const insertRequest = (over: { seq?: number; status?: string; total?: number; paymentId?: string | null; booking?: string } = {}) =>
    conn.sql<{ id: string }[]>`
      insert into booking_add_on_requests (booking_id, seq, status, total_cents, currency, rate_card_version, payment_id, created_by)
      values (${over.booking ?? bookingId}, ${over.seq ?? nextSeq++}, ${over.status ?? 'open'}, ${over.total ?? 1000}, 'USD', 'card-v1',
        ${over.paymentId ?? null}, 'ops@ceylonhop.com')
      returning id`;
  const insertLine = (requestId: string, over: { amount?: number; leg?: string; booking?: string } = {}) => conn.sql`
    insert into booking_add_ons (request_id, booking_id, leg_id, code, label, amount_cents)
    values (${requestId}, ${over.booking ?? bookingId}, ${over.leg ?? legId}, 'waiting', 'Waiting fee — Colombo Airport → Galle', ${over.amount ?? 1000})`;
  const insertPayment = (purpose: string) => conn.sql<{ id: string }[]>`
    insert into payments (booking_id, provider, order_id, amount, currency, status, idempotency_key, purpose)
    values (${bookingId}, 'fake', ${`CH-${randomUUID()}`}, 1000, 'USD', 'pending', ${randomUUID()}, ${purpose})
    returning id`;
  const insertCommunication = (kind: string) => conn.sql`
    insert into customer_communications (booking_id, kind, channel, template_key, template_version, recipient, source, actor_type, tracking_key, payload_sha256)
    values (${bookingId}, ${kind}, 'email', 'k', '1', 'm@x.com', 'ops', 'staff', ${randomUUID()}, ${'a'.repeat(64)})`;

  it('booking_add_on_requests has the columns of spec §5.1', async () => {
    expect(await columns('booking_add_on_requests')).toEqual({
      id: 'uuid',
      booking_id: 'uuid',
      seq: 'integer',
      status: 'text',
      total_cents: 'integer',
      currency: 'text',
      rate_card_version: 'text',
      payment_id: 'uuid null',
      created_by: 'text',
      created_at: 'timestamp with time zone',
      paid_at: 'timestamp with time zone null',
      cancelled_by: 'text null',
      cancelled_at: 'timestamp with time zone null',
      cancel_reason: 'text null',
    });
  });

  it('booking_add_ons has the columns of spec §5.2', async () => {
    expect(await columns('booking_add_ons')).toEqual({
      id: 'uuid',
      request_id: 'uuid',
      booking_id: 'uuid',
      leg_id: 'uuid',
      code: 'text',
      label: 'text',
      amount_cents: 'integer',
    });
  });

  it('stores a request and its line', async () => {
    const [{ id }] = await insertRequest();
    await insertLine(id);
    const [row] = await conn.sql`select status, total_cents, payment_id, paid_at from booking_add_on_requests where id = ${id}`;
    expect(row).toMatchObject({ status: 'open', total_cents: 1000, payment_id: null, paid_at: null });
    const [line] = await conn.sql`select leg_id, code, amount_cents from booking_add_ons where request_id = ${id}`;
    expect(line).toMatchObject({ leg_id: legId, code: 'waiting', amount_cents: 1000 });
  });

  it('admits open, paid and cancelled, and refuses any other status', async () => {
    for (const status of ['open', 'paid', 'cancelled']) await insertRequest({ status });
    await expect(insertRequest({ status: 'expired' })).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a request total of zero or less', async () => {
    await expect(insertRequest({ total: 0 })).rejects.toMatchObject({ code: '23514' });
    await expect(insertRequest({ total: -100 })).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a line amount of zero or less', async () => {
    const [{ id }] = await insertRequest();
    await expect(insertLine(id, { amount: 0 })).rejects.toMatchObject({ code: '23514' });
    await expect(insertLine(id, { amount: -1 })).rejects.toMatchObject({ code: '23514' });
  });

  it('allows one request per (booking, seq)', async () => {
    await insertRequest({ seq: 1 });
    await expect(insertRequest({ seq: 1 })).rejects.toMatchObject({ code: '23505' });
  });

  it('allows a payment on one request only, and any number of requests with none', async () => {
    const [{ id: paymentId }] = await insertPayment('add_on');
    await insertRequest({ paymentId });
    await expect(insertRequest({ paymentId })).rejects.toMatchObject({ code: '23505' });
    await insertRequest({ paymentId: null });
    await insertRequest({ paymentId: null });
  });

  it('ties a request to a real booking and payment, and a line to a real request, booking and leg', async () => {
    const ghost = '00000000-0000-4000-8000-0000000000ff';
    await expect(insertRequest({ booking: ghost })).rejects.toMatchObject({ code: '23503' });
    await expect(insertRequest({ paymentId: ghost })).rejects.toMatchObject({ code: '23503' });
    const [{ id }] = await insertRequest();
    await expect(insertLine(ghost)).rejects.toMatchObject({ code: '23503' });
    await expect(insertLine(id, { booking: ghost })).rejects.toMatchObject({ code: '23503' });
    await expect(insertLine(id, { leg: ghost })).rejects.toMatchObject({ code: '23503' });
  });

  it('indexes the lines by booking and by request', async () => {
    const rows = await conn.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'booking_add_ons'`;
    const defs = rows.map((r) => r.indexdef);
    expect(defs.some((d) => /\(booking_id\)/.test(d))).toBe(true);
    expect(defs.some((d) => /\(request_id\)/.test(d))).toBe(true);
  });

  it('accepts a payment with purpose add_on, still accepts the old three, and refuses any other', async () => {
    for (const purpose of ['full', 'deposit', 'balance', 'add_on']) await insertPayment(purpose);
    await expect(insertPayment('tip')).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts both new email kinds, still accepts every old kind, and refuses any other', async () => {
    for (const kind of [...OLD_KINDS, ...NEW_KINDS]) await insertCommunication(kind);
    await expect(insertCommunication('add_on_reminder')).rejects.toMatchObject({ code: '23514' });
  });
});
