import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../drizzle/0027_sh7_money_state_constraints.sql', import.meta.url),
  'utf8',
);

const constraints = [
  'bookings_total_nonnegative',
  'bookings_amount_due_now_valid',
  'bookings_currency_supported',
  'bookings_mode_valid',
  'bookings_status_valid',
  'payments_amount_positive',
  'payments_currency_supported',
  'payments_provider_supported',
  'payments_status_valid',
  'payments_succeeded_settled_at_required',
  'payments_succeeded_settlement_source_required',
  'corridor_seat_price_positive',
  'corridor_seat_capacity_positive',
  'shared_departure_seats_total_positive',
  'shared_departure_seats_booked_valid',
] as const;

describe('SH7 money/state migration contract', () => {
  it.each(constraints)('adds and validates named constraint %s', (name) => {
    expect(migration).toContain(`CONSTRAINT "${name}"`);
    expect(migration).toContain(`CONSTRAINT "${name}" CHECK`);
    expect(migration).toContain(`VALIDATE CONSTRAINT "${name}"`);
  });

  it('adds checks NOT VALID before validating them', () => {
    expect(migration.match(/CHECK \([\s\S]*?\) NOT VALID/g)).toHaveLength(constraints.length);
  });

  it('backfills legacy settlement evidence without claiming created_at is gateway evidence', () => {
    expect(migration).toMatch(
      /settled_at = coalesce\(settled_at, updated_at\),\s*settlement_source = 'legacy_backfill'/,
    );
    expect(migration).not.toMatch(/settled_at\s*=\s*(?:coalesce\([^)]*,\s*)?created_at/);
  });
});
