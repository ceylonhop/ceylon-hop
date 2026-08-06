import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');

// Extract the real functions from ops-ui.html (house loadFn pattern). shortenRouteLabel calls
// shortPlace, so both are evaluated together in one scope.
function loadPair() {
  const grab = (sig) => {
    const re = new RegExp('function ' + sig.replace(/[()]/g, '\\$&') + '\\s*\\{[\\s\\S]*?\\n\\}');
    const m = html.match(re);
    if (!m) throw new Error(sig + ' not found in ops-ui.html');
    return m[0];
  };
  // eslint-disable-next-line no-new-func
  return new Function(
    grab('shortPlace(full)') + '\n' + grab('shortenRouteLabel(label)') +
    '\nreturn { shortPlace: shortPlace, shortenRouteLabel: shortenRouteLabel };',
  )();
}
const { shortPlace, shortenRouteLabel } = loadPair();

// These MUST match api/src/quote/shortPlace.test.ts — the ops copy and the server copy render the
// same places on different surfaces, and a customer comparing their email to what ops told them
// must not see two different names.
describe('ops shortPlace mirrors the server', () => {
  it('drops the street and the country', () => {
    expect(shortPlace('The Den 23, Norris Canal Road, Colombo, Sri Lanka')).toBe('The Den 23 · Colombo');
    expect(shortPlace('Deltora Villa, Bope Cross Road, Galle, Sri Lanka')).toBe('Deltora Villa · Galle');
  });

  it('keeps the venue alone when it already names its town', () => {
    expect(shortPlace('Ella Mount View Guest Inn, Waterfall Road, Ella, Sri Lanka')).toBe('Ella Mount View Guest Inn');
    expect(shortPlace('Dambulla Cave Temple, Kandy - Jaffna Highway, Dambulla, Sri Lanka')).toBe('Dambulla Cave Temple');
  });

  it('does not mistake a town for part of a longer word', () => {
    expect(shortPlace('Umbrella Cafe, Main Street, Ella, Sri Lanka')).toBe('Umbrella Cafe · Ella');
  });

  it('leaves short and free-text names alone', () => {
    expect(shortPlace('Arugam Bay Beach, Sri Lanka')).toBe('Arugam Bay Beach');
    expect(shortPlace('Colombo Airport (CMB)')).toBe('Colombo Airport (CMB)');
    expect(shortPlace('the blue house past the temple')).toBe('the blue house past the temple');
  });

  it('never throws on empty input', () => {
    expect(shortPlace('')).toBe('');
    expect(shortPlace(undefined)).toBe('');
  });
});

describe('ops shortenRouteLabel', () => {
  it('shortens both sides and keeps the vehicle suffix', () => {
    expect(shortenRouteLabel('The Den 23, Norris Canal Road, Colombo, Sri Lanka → Sigiri dilu villa, Thalkote Road, Sigiriya, Sri Lanka (car)'))
      .toBe('The Den 23 · Colombo → Sigiri dilu villa · Sigiriya (car)');
  });

  it('leaves rows that are not routes alone', () => {
    expect(shortenRouteLabel('Final price adjustment')).toBe('Final price adjustment');
  });
});
