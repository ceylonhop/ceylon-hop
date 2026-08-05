import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The three picker functions are pure (no DOM, no state) inside ops-ui.html — extract them by
// source markers and eval, same trick as ops-quote-search.test.js. The test exercises the REAL
// page code, so the picker's maths can never drift from what this file asserts.
function loadFn(signature) {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const re = new RegExp('function ' + signature.replace(/[()]/g, '\\$&') + ' \\{[\\s\\S]*?\\n\\}');
  const m = html.match(re);
  if (!m) throw new Error(signature + ' not found in ops-ui.html');
  // eslint-disable-next-line no-new-func
  return new Function('return (' + m[0] + ')')();
}
const paySelectionState = loadFn('paySelectionState(lines)');
const togglePayLine = loadFn('togglePayLine(state, lines, line)');
const paySelectionSummary = loadFn('paySelectionSummary(state, lines)');

const lines = [
  { kind: 'leg', index: 0, label: 'Colombo → Kandy (car)', amountCents: 5000 },
  { kind: 'leg', index: 1, label: 'Kandy → Ella (car)', amountCents: 6000 },
  { kind: 'extra', index: 0, label: 'Luggage rack — Kandy → Ella', amountCents: 500, legIndex: 1 },
];

describe('pay selection picker', () => {
  it('starts with everything ticked — the untouched picker IS the full-total link', () => {
    const s = paySelectionState(lines);
    expect(s.legIndexes).toEqual([0, 1]);
    expect(s.extraIndexes).toEqual([0]);
  });

  it('unticking a leg unticks the extras attributed to it', () => {
    const s = togglePayLine(paySelectionState(lines), lines, { kind: 'leg', index: 1 });
    expect(s.legIndexes).toEqual([0]);
    expect(s.extraIndexes).toEqual([]);
  });

  it('re-ticking the leg re-ticks them', () => {
    let s = togglePayLine(paySelectionState(lines), lines, { kind: 'leg', index: 1 });
    s = togglePayLine(s, lines, { kind: 'leg', index: 1 });
    expect(s.legIndexes).toEqual([0, 1]);
    expect(s.extraIndexes).toEqual([0]);
  });

  it('an extra can be dropped on its own', () => {
    const s = togglePayLine(paySelectionState(lines), lines, { kind: 'extra', index: 0 });
    expect(s.legIndexes).toEqual([0, 1]);
    expect(s.extraIndexes).toEqual([]);
  });

  it('summarises coverage and the running total', () => {
    const s = togglePayLine(paySelectionState(lines), lines, { kind: 'leg', index: 1 });
    expect(paySelectionSummary(s, lines)).toEqual({
      soldLegs: 1, totalLegs: 2, amountCents: 5000, gapAfter: null,
    });
  });

  it('names the gap when a middle leg is dropped', () => {
    const three = [
      lines[0], lines[1],
      { kind: 'leg', index: 2, label: 'Ella → Galle (car)', amountCents: 9000 },
    ];
    const s = togglePayLine(paySelectionState(three), three, { kind: 'leg', index: 1 });
    expect(paySelectionSummary(s, three).gapAfter).toBe('Colombo → Kandy (car)');
  });
});
