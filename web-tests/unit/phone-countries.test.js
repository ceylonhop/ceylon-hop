import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// phone-countries.js is the shared country/dial-code list the pay page loads;
// booking.js still carries its own inline copy. This pins them byte-identical so an
// edit to one can't silently strand the other.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const grab = (file, re) => {
  const m = readFileSync(`${root}/${file}`, 'utf8').match(re);
  if (!m) throw new Error(`list not found in ${file}`);
  return m[1];
};

describe('PHONE_COUNTRIES stays in sync', () => {
  it('booking.js and phone-countries.js carry the identical list', () => {
    const wizard = grab('booking.js', /const PHONE_COUNTRIES = \[\n([\s\S]*?)\n\];/);
    const shared = grab('phone-countries.js', /window\.PHONE_COUNTRIES = \[\n([\s\S]*?)\n\];/);
    expect(shared).toBe(wizard);
  });
});
