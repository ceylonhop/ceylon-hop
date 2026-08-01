import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// quoteTripOver + its qDaysBetween helper are self-contained (no DOM, no module state, `today`
// passed in) inside ops-ui.html — extract and eval, same trick as ops-quote-search.test.js.
// Both the constants and the helper come along: the policy is only meaningful as a whole.
function loadTripOver() {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const num = (name) => {
    const m = html.match(new RegExp('const ' + name + '\\s*=\\s*(\\d+)'));
    if (!m) throw new Error(name + ' not found in ops-ui.html');
    return `const ${name}=${m[1]};`;
  };
  const fn = (name) => {
    const m = html.match(new RegExp('function ' + name + '\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}'));
    if (!m) throw new Error(name + ' not found in ops-ui.html');
    return m[0];
  };
  // eslint-disable-next-line no-new-func
  return new Function(
    num('QTRIP_GRACE_DAYS') + fn('qDaysBetween') + fn('quoteTripOver') + 'return quoteTripOver;',
  )();
}
const quoteTripOver = loadTripOver();

// quoteTripOver takes "today" as a parameter, so the whole suite is anchored to a FIXED day in
// the past rather than the wall clock: nothing here can rot, and no literal sits in the
// no-date-bombs rotting window. Every other date is derived from this anchor.
const TODAY = '2020-06-15';
const shift = (n) => new Date(Date.parse(TODAY + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const daysBefore = (n) => shift(-n);
const daysAfter = (n) => shift(n);
const sent = (o) => ({ status: 'sent', travelDate: null, sentAt: null, ...o });

describe('quoteTripOver', () => {
  it('retires a sent quote whose trip ended well in the past', () => {
    expect(quoteTripOver(sent({ travelDate: daysBefore(10) }), TODAY)).toBe(true);
  });

  it('leaves a trip that ended yesterday alone — it may still be converting offline', () => {
    expect(quoteTripOver(sent({ travelDate: daysBefore(1) }), TODAY)).toBe(false);
  });

  it('holds the grace period to exactly 3 days', () => {
    expect(quoteTripOver(sent({ travelDate: daysBefore(3) }), TODAY)).toBe(false);
    expect(quoteTripOver(sent({ travelDate: daysBefore(4) }), TODAY)).toBe(true);
  });

  it('never retires a quote whose trip is still ahead', () => {
    expect(quoteTripOver(sent({ travelDate: daysAfter(120) }), TODAY)).toBe(false);
  });

  it('applies only to sent quotes — every other status is somebody\'s active work', () => {
    for (const status of ['draft', 'pending_review', 'changes_requested', 'ready', 'won', 'lost', 'expired']) {
      expect(quoteTripOver(sent({ status, travelDate: daysBefore(30) }), TODAY)).toBe(false);
    }
  });

  it('never judges an undated quote on its send age — that is the sweep\'s job', () => {
    // expireStaleQuotes owns send-age policy (180 days, PR #214). A second, shorter send-age
    // timer here would silently retire quotes the owner deliberately chose to protect.
    expect(quoteTripOver(sent({ sentAt: daysBefore(365) + 'T09:00:00.000Z' }), TODAY)).toBe(false);
    expect(quoteTripOver(sent({}), TODAY)).toBe(false);
  });

  it('judges on the travel date even for a quote sent long ago', () => {
    // Sent 90 days back but for a trip still to come — very much live.
    expect(quoteTripOver(
      sent({ travelDate: daysAfter(120), sentAt: daysBefore(90) + 'T09:00:00.000Z' }),
      TODAY,
    )).toBe(false);
  });

  it('fails safe on unparseable dates — never hides a quote it cannot judge', () => {
    expect(quoteTripOver(sent({ travelDate: 'next Tuesday' }), TODAY)).toBe(false);
    expect(quoteTripOver(null, TODAY)).toBe(false);
  });
});
