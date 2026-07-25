import { describe, it, expect } from 'vitest';
import { isIdempotencyCollision, isReferenceCollision, pgUniqueViolation } from './postgresBookingRepo';

// The real postgres.js error carries code/constraint_name directly; Drizzle wraps it as
// `Error: Failed query…` with that PostgresError on `.cause`. Both shapes must be recognised —
// the DB-gated postgres.test.ts can't run without a database, so these pure-function tests are
// what guard create()'s retry/idempotency detection locally.
const pgErr = (constraint: string) => ({ code: '23505', constraint_name: constraint });
const wrapped = (constraint: string) =>
  Object.assign(new Error('Failed query: insert into "bookings" …'), { cause: pgErr(constraint) });

describe('postgres unique-violation detectors', () => {
  it('detects an idempotency-key collision on a raw driver error', () => {
    expect(isIdempotencyCollision(pgErr('bookings_idempotency_key_unique'))).toBe(true);
    expect(isReferenceCollision(pgErr('bookings_idempotency_key_unique'))).toBe(false);
  });

  it("detects an idempotency-key collision through Drizzle's wrapping (.cause)", () => {
    // The exact shape that slipped past the old top-level check and 500ed the concurrent create in CI.
    expect(isIdempotencyCollision(wrapped('bookings_idempotency_key_unique'))).toBe(true);
    expect(isReferenceCollision(wrapped('bookings_idempotency_key_unique'))).toBe(false);
  });

  it('detects a reference collision through the cause chain', () => {
    expect(isReferenceCollision(wrapped('bookings_reference_unique'))).toBe(true);
    expect(isIdempotencyCollision(wrapped('bookings_reference_unique'))).toBe(false);
  });

  it('ignores non-unique-violation and non-object inputs', () => {
    expect(pgUniqueViolation({ code: '42P01' })).toBeNull(); // undefined_table, not a unique violation
    expect(pgUniqueViolation(new Error('plain'))).toBeNull();
    expect(pgUniqueViolation(null)).toBeNull();
    expect(isIdempotencyCollision('nope')).toBe(false);
  });
});
