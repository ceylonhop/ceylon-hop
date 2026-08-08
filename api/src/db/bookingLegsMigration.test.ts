import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../drizzle/0042_booking_legs.sql', import.meta.url),
  'utf8',
);

const journal = JSON.parse(
  readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
) as { entries: Array<{ idx: number; when: number; tag: string }> };

// SQL comments (`-- ...` to end of line) must never be able to satisfy a constraint assertion —
// a migration whose constraints exist only in prose is not a migration that creates them.
function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

describe('0042_booking_legs', () => {
  const sql = stripSqlComments(migration);

  it('creates the table', () => {
    expect(sql).toMatch(/create table[^;]*"?booking_legs"?/i);
  });

  it('constrains kind to exactly the three derivable kinds, attached to the kind column', () => {
    // Must be a real CONSTRAINT ... CHECK clause naming the `kind` column, not just the
    // constraint name and the value strings appearing anywhere in the file (e.g. in a comment).
    const match = sql.match(
      /CONSTRAINT\s+"booking_legs_kind_valid"\s+CHECK\s*\(\s*"kind"\s+in\s*\(([^)]*)\)\s*\)/i,
    );
    expect(match, 'expected a CONSTRAINT "booking_legs_kind_valid" CHECK ("kind" in (...)) clause').not.toBeNull();

    const allowedValues = (match![1] ?? '')
      .split(',')
      .map((v) => v.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    expect(new Set(allowedValues)).toEqual(new Set(['leg', 'day', 'gap']));
  });

  it('makes (booking_id, seq) unique so a re-run cannot duplicate a journey', () => {
    // Must be a real CONSTRAINT ... UNIQUE clause over booking_id and seq, not just the
    // constraint name appearing somewhere in the file.
    expect(sql).toMatch(
      /CONSTRAINT\s+"booking_legs_booking_seq_unique"\s+UNIQUE\s*\(\s*"booking_id"\s*,\s*"seq"\s*\)/i,
    );
  });

  // The migration must MOVE NO DATA and touch no existing table. Migrations auto-apply on Render
  // boot and fail closed, so a malformed historical row or an unintended schema change to an
  // existing table could keep the API down; the backfill is a separate script (Task 5).
  it('moves no data and touches no existing table', () => {
    expect(sql).not.toMatch(/\binsert\s+into\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    expect(sql).not.toMatch(/\balter\s+table\b/i);
  });
});

describe('drizzle journal', () => {
  it('has strictly increasing `when` values, so no future entry can accidentally out-rank a later one', () => {
    // Drizzle's migrator tracks a SINGLE high-water mark (the max applied `when`), not
    // per-migration hashes: it applies a migration only if `lastAppliedWhen < migration.when`.
    // If any entry's `when` is <= a preceding entry's `when`, that migration silently NEVER
    // runs once the preceding one is applied — no error, no failed boot, just a table (or
    // column) that never exists and a runtime "relation does not exist" failure later.
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1]!;
      const curr = journal.entries[i]!;
      expect(
        curr.when,
        `journal entry ${curr.idx} ("${curr.tag}", when=${curr.when}) is not strictly after ` +
          `entry ${prev.idx} ("${prev.tag}", when=${prev.when}). Drizzle's migrator applies a ` +
          `migration only when its "when" exceeds the highest "when" already applied — an entry ` +
          `that doesn't increase would be silently skipped forever, with no error and no failed ` +
          `boot, and its table/column would simply never exist in production.`,
      ).toBeGreaterThan(prev.when);
    }
  });
});
