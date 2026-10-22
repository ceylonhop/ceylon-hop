import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTransfers } from './_load.js';

// ride-fomo.js — seats to go, when names close, the private car a seat beats, and the words a
// traveller shares (plan 2026-10-19-ride-board-fomo). Pure: "now" is an argument.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let F;
beforeAll(() => {
  loadTransfers();
  // eslint-disable-next-line no-new-func
  new Function(readFileSync(path.join(ROOT, 'ride-fomo.js'), 'utf8'))();
  F = window.CHRideFomo;
});
const H = 3600000;
const NOW = Date.parse('2099-08-10T00:00:00Z');

describe('seatsToGo', () => {
  it('counts the seats a gathering ride still needs', () => {
    expect(F.seatsToGo({ minSeats: 3, committed: 1 })).toEqual({ need: 2, text: '2 seats to go', hot: false });
  });
  it('is hot with one seat to go', () => {
    expect(F.seatsToGo({ minSeats: 3, committed: 2 })).toEqual({ need: 1, text: '1 seat to go', hot: true });
  });
  it('says nothing once the ride has its minimum, or is confirmed', () => {
    expect(F.seatsToGo({ minSeats: 3, committed: 3 })).toBeNull();
    expect(F.seatsToGo({ minSeats: 3, committed: 1, confirmed: true })).toBeNull();
  });
});

describe('closesText', () => {
  it('runs a red clock inside a day', () => {
    expect(F.closesText(NOW + 9 * H + 12 * 60000, NOW)).toEqual({ text: 'Names close in 9h 12m', live: true, urgent: true });
  });
  it('runs a calm clock inside three days', () => {
    expect(F.closesText(NOW + 50 * H, NOW)).toEqual({ text: 'Names close in 2d 2h', live: true, urgent: false });
  });
  it('counts down to the second in the last hour', () => {
    expect(F.closesText(NOW + 12 * 60000 + 5000, NOW).text).toBe('Names close in 12m 05s');
  });
  it('gives the Sri Lanka date further out', () => {
    // 20:00 UTC on the 14th is 01:30 on the 15th in Colombo
    expect(F.closesText(Date.parse('2099-08-14T20:00:00Z'), NOW)).toEqual({ text: 'Names close Sat 15 Aug', live: false, urgent: false });
  });
  it('says names closed once the cutoff has passed', () => {
    expect(F.closesText(NOW - 1, NOW)).toEqual({ text: 'Names closed', live: false, urgent: false });
  });
  it('is null with no cutoff to go on', () => {
    expect(F.closesText(NaN, NOW)).toBeNull();
  });
});

describe('privateCarFare', () => {
  it("quotes the catalogue's private car for the pair", () => {
    const car = window.TRANSFERS.privateQuote('ella', 'mirissa').car;
    expect(F.privateCarFare('ella', 'mirissa', 28)).toBe(car);
  });
  it('is null when the pair is unknown', () => {
    expect(F.privateCarFare(null, 'mirissa', 28)).toBeNull();
    expect(F.privateCarFare('nowhere', 'mirissa', 28)).toBeNull();
  });
  it('is null when the car would not cost more than one seat', () => {
    const car = window.TRANSFERS.privateQuote('ella', 'mirissa').car;
    expect(F.privateCarFare('ella', 'mirissa', car)).toBeNull();
  });
});

describe('shareMessage', () => {
  const base = { route: 'Ella → Mirissa', when: 'Thu 22 Oct (7–9 am)', fare: '$28', priv: '$75', closes: 'Names close in 9h 12m' };
  it('speaks in the first person for someone on the ride', () => {
    expect(F.shareMessage({ ...base, mine: true, need: 1 })).toBe(
      "I'm taking a shared taxi Ella → Mirissa on Thu 22 Oct (7–9 am). 1 seat left to make it run — $28 each instead of $75 for a private car, nothing to pay unless it runs. Names close in 9h 12m. Join me:");
  });
  it('never claims "I\'m taking" for someone who is not on it', () => {
    expect(F.shareMessage({ ...base, mine: false, need: 1 })).toBe(
      'Shared taxi Ella → Mirissa on Thu 22 Oct (7–9 am). 1 seat left to make it run — $28 each instead of $75 for a private car, nothing to pay unless it runs. Names close in 9h 12m. Add your name:');
  });
  it('pluralises the seats', () => {
    expect(F.shareMessage({ ...base, mine: true, need: 2 })).toContain('2 seats left to make it run');
  });
  it('drops the comparison and the deadline when it has neither', () => {
    expect(F.shareMessage({ ...base, mine: true, need: 1, priv: null, closes: null })).toBe(
      "I'm taking a shared taxi Ella → Mirissa on Thu 22 Oct (7–9 am). 1 seat left to make it run — $28 each, nothing to pay unless it runs. Join me:");
  });
  it('says it is running when nothing more is needed', () => {
    expect(F.shareMessage({ ...base, mine: true, need: 0, closes: null })).toBe(
      "I'm taking a shared taxi Ella → Mirissa on Thu 22 Oct (7–9 am). It's running and there are seats left — $28 each instead of $75 for a private car. Join me:");
  });
});

describe('momentum + momentumText', () => {
  const ride = (o) => ({ minSeats: 3, committed: 1, confirmed: false, cancelled: false, cutoffMs: NOW + 2 * 24 * H, ...o });
  it('counts travellers on open rides, rides closing this week, and rides one short', () => {
    const m = F.momentum([
      ride({ committed: 2 }),                          // one short, closes in 2 days
      ride({ committed: 1, cutoffMs: NOW + 10 * 24 * H }),
      ride({ committed: 3, confirmed: true }),          // names closed — not counted
      ride({ committed: 2, cutoffMs: NOW - 1 }),        // cutoff passed — not counted
      { sched: true },                                  // a scheduled taxi row — not a ride
    ], NOW);
    expect(m).toEqual({ travellers: 3, closingThisWeek: 1, oneToGo: 1 });
  });
  it('words it, leaving out the parts that are zero', () => {
    expect(F.momentumText({ travellers: 9, closingThisWeek: 3, oneToGo: 1 }))
      .toEqual({ head: '9 travellers on the board right now', sub: '3 rides close this week · 1 needs just one more' });
    expect(F.momentumText({ travellers: 1, closingThisWeek: 0, oneToGo: 0 }))
      .toEqual({ head: '1 traveller on the board right now', sub: '' });
  });
  it('shows nothing rather than "0 travellers"', () => {
    expect(F.momentumText({ travellers: 0, closingThisWeek: 0, oneToGo: 0 })).toBeNull();
  });
});
