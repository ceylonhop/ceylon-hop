import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../drizzle/0042_booking_legs.sql', import.meta.url),
  'utf8',
);

describe('0042_booking_legs', () => {
  it('creates the table', () => {
    expect(migration).toMatch(/create table[^;]*"?booking_legs"?/i);
  });

  it('constrains kind to the three derivable kinds', () => {
    expect(migration).toContain('booking_legs_kind_valid');
    for (const kind of ['leg', 'day', 'gap']) expect(migration).toContain(`'${kind}'`);
  });

  it('makes (booking_id, seq) unique so a re-run cannot duplicate a journey', () => {
    expect(migration).toContain('booking_legs_booking_seq_unique');
  });

  // The migration must MOVE NO DATA. Migrations auto-apply on Render boot and fail closed, so a
  // malformed historical row could keep the API down; the backfill is a separate script (Task 5).
  it('moves no data', () => {
    expect(migration).not.toMatch(/\binsert\s+into\b/i);
    expect(migration).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
  });
});
