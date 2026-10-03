import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Google Maps is OFF by default on test sites (local, LAN, staging): the e2e suite alone ran
// ~19 map loads + ~29 route queries per CI run against the live key, which was ~75% of
// September 2026's $122 Maps bill. Real sites keep their maps. isTestHost() exists TWICE on
// purpose, like mapPins(): the ops shell is a self-contained single-file app on another origin
// and cannot import ch-map.js — so this loads BOTH copies and asserts they agree.
function extract(file, sig) {
  const src = readFileSync(path.resolve(__dirname, '../../', file), 'utf8');
  const re = new RegExp('(?:^|\\n)([ \\t]*)function ' + sig.replace(/[()]/g, '\\$&') + '\\s*\\{[\\s\\S]*?\\n\\1\\}');
  const m = src.match(re);
  if (!m) throw new Error(sig + ' not found in ' + file);
  // eslint-disable-next-line no-new-func
  return new Function('return (' + m[0].trim() + ')')();
}
const copies = {
  'ch-map.js': extract('ch-map.js', 'isTestHost(host)'),
  'ops-ui.html': extract('api/src/routes/ops-ui.html', 'isTestHost(host)'),
};

// Every host a real customer or staff member uses — a false "test" here would take their map away.
const REAL = [
  'ceylonhop.com', 'www.ceylonhop.com', 'quote.ceylonhop.com', 'pay.ceylonhop.com',
  'ops.ceylonhop.com', 'ceylon-hop-api.onrender.com', 'ceylonhop.github.io',
  'stagingcoach.com', // "staging" only counts as its own label/segment
  '172.32.0.1',       // just outside the private 172.16/12 block
];
const TEST = [
  '', // file://
  'localhost', '127.0.0.1', '[::1]', '0.0.0.0', 'app.localhost',
  '192.168.1.20', '10.0.0.5', '172.16.4.2', '172.31.255.1', // phone-on-the-LAN previews
  'staging.ceylonhop.com', 'ops.staging.ceylonhop.com', 'ops-staging.ceylonhop.com',
  'pay-staging.ceylonhop.com', 'ceylon-hop-staging.onrender.com',
];

for (const [file, isTestHost] of Object.entries(copies)) {
  describe(`${file} isTestHost`, () => {
    it.each(REAL)('keeps live maps on %s', (h) => expect(isTestHost(h)).toBe(false));
    it.each(TEST)('treats "%s" as a test site', (h) => expect(isTestHost(h)).toBe(true));
    it('ignores case', () => expect(isTestHost('LOCALHOST')).toBe(true));
  });
}

describe('the two copies agree', () => {
  it.each([...REAL, ...TEST])('%s', (h) => {
    expect(copies['ops-ui.html'](h)).toBe(copies['ch-map.js'](h));
  });
});
