import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function productionTypescript(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return productionTypescript(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('booking status writer architecture', () => {
  it('keeps direct SQL status mutation inside the canonical transaction-aware writer', () => {
    const offenders = productionTypescript(SRC).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const directlyUpdatesStatus = /\.update\(bookings\)[\s\S]{0,500}?\.set\(\{[\s\S]{0,300}?\bstatus\s*:/.test(source);
      return directlyUpdatesStatus && !path.endsWith('postgresBookingRepo.ts')
        ? [relative(SRC, path)]
        : [];
    });

    expect(offenders).toEqual([]);
  });
});
