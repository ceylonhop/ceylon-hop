import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The chooser's decisions are pure functions inside ops-ui.html — extract by source marker and
// eval (same trick as ops-pay-selection.test.js), so this exercises the REAL page code.
function loadFn(signature) {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const re = new RegExp('function ' + signature.replace(/[()]/g, '\\$&') + ' \\{[\\s\\S]*?\\n\\}');
  const m = html.match(re);
  if (!m) throw new Error(signature + ' not found in ops-ui.html');
  // eslint-disable-next-line no-new-func
  return new Function('return (' + m[0] + ')')();
}
const payServiceOptions = loadFn('payServiceOptions(payOptions)');
const payLinkOutService = loadFn('payLinkOutService(payOptions, sessionService, hasLink)');
const payLinkOutText = loadFn('payLinkOutText(service)');

const BOTH = {
  primary: { service: 'private', totalCents: 14900 },
  alternative: { service: 'chauffeur', totalCents: 22300, depositCents: 5000 },
  linkedService: null,
};

describe('payServiceOptions', () => {
  it('lists point-to-point then chauffeur-guide with their totals', () => {
    expect(payServiceOptions(BOTH)).toEqual([
      { service: 'private', label: 'Point-to-point', totalCents: 14900, depositCents: 0 },
      { service: 'chauffeur', label: 'Chauffeur-guide', totalCents: 22300, depositCents: 5000 },
    ]);
  });

  it('is empty without an alternative: no payOptions, null, or a primary on its own', () => {
    expect(payServiceOptions(undefined)).toEqual([]);
    expect(payServiceOptions(null)).toEqual([]);
    expect(payServiceOptions({ primary: BOTH.primary, linkedService: null })).toEqual([]);
  });

  it('carries a zero deposit through when none applies', () => {
    const o = payServiceOptions({ ...BOTH, alternative: { ...BOTH.alternative, totalCents: 12000, depositCents: 0 } });
    expect(o[1].depositCents).toBe(0);
  });
});

describe('payLinkOutService — which option’s link is out', () => {
  it('prefers what this session minted', () => {
    expect(payLinkOutService(BOTH, 'chauffeur', true)).toBe('chauffeur');
    expect(payLinkOutService({ ...BOTH, linkedService: 'chauffeur' }, 'private', true)).toBe('private');
  });
  it('else reads the server’s linkedService', () => {
    expect(payLinkOutService({ ...BOTH, linkedService: 'chauffeur' }, null, false)).toBe('chauffeur');
  });
  it('else is point-to-point when a link is known to be out, and nothing when none is', () => {
    expect(payLinkOutService(BOTH, null, true)).toBe('private');
    expect(payLinkOutService(BOTH, null, false)).toBeNull();
  });
  it('is nothing on a quote without options', () => {
    expect(payLinkOutService(null, 'chauffeur', true)).toBeNull();
  });
});

describe('payLinkOutText', () => {
  it('names the option and says the other one replaces it', () => {
    expect(payLinkOutText('chauffeur')).toBe('Chauffeur-guide link is out — sending the other option replaces it');
    expect(payLinkOutText('private')).toBe('Point-to-point link is out — sending the other option replaces it');
    expect(payLinkOutText(null)).toBe('');
  });
});
