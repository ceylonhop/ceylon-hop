import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pay = readFileSync(path.resolve(__dirname, '../../pay.html'), 'utf8');

// Four live bookings were recorded under the owner's name because a pay link was opened in a
// staff browser and Chrome autofilled the EMPTY surname and email boxes (spec 2026-08-08).
describe('the pay form does not invite a password manager', () => {
  for (const field of ['f-firstName', 'f-lastName', 'f-email']) {
    it(`${field} does not advertise itself for autofill`, () => {
      const tag = pay.match(new RegExp(`<input id="${field}"[^>]*>`));
      expect(tag, `${field} input not found`).toBeTruthy();
      expect(tag[0]).toContain('autocomplete="off"');
      // Chrome ignores `off` on fields it recognises by name, so the names must be unfamiliar too.
      expect(tag[0]).not.toMatch(/name="(given-name|family-name|email)"/);
    });
  }

  it('no identity field still carries a standard autofill token', () => {
    expect(pay).not.toContain('autocomplete="given-name"');
    expect(pay).not.toContain('autocomplete="family-name"');
    expect(pay).not.toContain('autocomplete="email"');
  });

  // Mitigation, never a guarantee — Chrome also classifies from id and label text. The server
  // guard is what actually closes the hole, and this records why both exist.
  it('records that the attribute alone is not the fix', () => {
    expect(pay).toMatch(/Chrome classifies from id\/label too/);
  });
});
