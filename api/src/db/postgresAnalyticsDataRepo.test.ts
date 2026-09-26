import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./postgresAnalyticsDataRepo.ts', import.meta.url), 'utf8');

describe('PostgresAnalyticsDataRepo SQL', () => {
  it('queries the deployed booking_legs table', () => {
    expect(source).toContain('from booking_legs bl');
    expect(source).not.toMatch(/from booking_leg bl/);
  });
});
