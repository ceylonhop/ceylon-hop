import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTransfers } from './_load.js';

// board.js is a browser IIFE. It exposes pure helpers on window.RideBoard and
// only boots the DOM app when #board-grid exists. In the bare jsdom document
// there is no #board-grid, so evaluating the file just installs the helpers —
// no server, no fetch, no Google needed.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

let RB;
beforeAll(() => {
  loadTransfers();                 // sets window.TRANSFERS (enriches name→id lookup)
  const src = readFileSync(path.join(ROOT, 'board.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(src)();             // runs against the ambient jsdom window/document
  RB = window.RideBoard;
});

describe('window.RideBoard is exposed with pure helpers', () => {
  it('installs the expected API', () => {
    expect(RB).toBeTruthy();
    ['fmtCountdown', 'slotWindow', 'scarcityText', 'whenLine', 'normalizeList',
      'centsToDollars', 'money', 'flagOf', 'fmtDate', 'resolvePlaceId'].forEach((k) => {
      expect(typeof RB[k]).toBe('function');
    });
  });
});

describe('fmtCountdown(remainingMs)', () => {
  it('clamps at zero', () => {
    expect(RB.fmtCountdown(0)).toBe('0m 00s');
    expect(RB.fmtCountdown(-9999)).toBe('0m 00s');
  });
  it('formats seconds and minutes under an hour', () => {
    expect(RB.fmtCountdown(65 * 1000)).toBe('1m 05s');
    expect(RB.fmtCountdown(9 * 60 * 1000 + 3 * 1000)).toBe('9m 03s');
  });
  it('formats hours and minutes under a day', () => {
    expect(RB.fmtCountdown(60 * 60 * 1000)).toBe('1h 00m');
    expect(RB.fmtCountdown(90 * 60 * 1000)).toBe('1h 30m');
  });
  it('formats days and hours past 24h', () => {
    expect(RB.fmtCountdown((2 * 24 + 3) * 3600 * 1000)).toBe('2d 3h');
    expect(RB.fmtCountdown(24 * 3600 * 1000)).toBe('1d 0h');
  });
});

describe('slotWindow(slot)', () => {
  it('returns the matching window', () => {
    expect(RB.slotWindow('afternoon').label).toBe('afternoon');
    expect(RB.slotWindow('afternoon').opts).toContain('14:00');
    expect(RB.slotWindow('morning').range).toBe('departs 7–9 am');
  });
  it('defaults unknown slots to morning', () => {
    expect(RB.slotWindow('whenever')).toBe(RB.slotWindow('morning'));
    expect(RB.slotWindow(undefined).label).toBe('morning');
  });
});

describe('centsToDollars / money', () => {
  it('divides integer cents into dollars', () => {
    expect(RB.centsToDollars(2400)).toBe(24);
    expect(RB.centsToDollars(2450)).toBe(24.5);
    expect(RB.centsToDollars(null)).toBe(0);
  });
  it('formats money with no trailing .00 for whole dollars', () => {
    expect(RB.money(24)).toBe('$24');
    expect(RB.money(24.5)).toBe('$24.50');
    expect(RB.money(0)).toBe('$0');
  });
});

describe('flagOf(country)', () => {
  it('turns a 2-letter code into a flag emoji', () => {
    expect(RB.flagOf('LK')).toBe('🇱🇰');
    expect(RB.flagOf('fr')).toBe('🇫🇷');
    expect(RB.flagOf('GB')).toBe('🇬🇧');
  });
  it('passes through empties, emoji and non 2-letter codes', () => {
    expect(RB.flagOf('')).toBe('');
    expect(RB.flagOf(null)).toBe('');
    expect(RB.flagOf('🇬🇧')).toBe('🇬🇧');
    expect(RB.flagOf('USA')).toBe('USA');
  });
});

describe('fmtDate(iso)', () => {
  it('formats a date-only string without timezone drift', () => {
    expect(RB.fmtDate('2026-08-08')).toBe('Sat 8 Aug');
  });
  it('is graceful with junk / empty input', () => {
    expect(RB.fmtDate('')).toBe('');
    expect(RB.fmtDate('not-a-date')).toBe('not-a-date');
  });
});

describe('scarcityText(list)', () => {
  it('says how many to lock it in while gathering', () => {
    expect(RB.scarcityText({ committed: 2, minSeats: 4, capacity: 6, status: 'gathering' }))
      .toEqual({ cls: 'pill-saffron pill-dot', txt: '2 seats to lock it in' });
  });
  it('pulses at one away', () => {
    expect(RB.scarcityText({ committed: 3, minSeats: 4, capacity: 6, status: 'gathering' }))
      .toEqual({ cls: 'pill-tomato pill-dot pill-pulse', txt: '1 seat to lock it in — almost there' });
  });
  it('shows seats-left once locked (via seat count or confirmed status)', () => {
    expect(RB.scarcityText({ committed: 4, minSeats: 4, capacity: 6, status: 'gathering' }))
      .toEqual({ cls: 'pill-teal pill-dot', txt: 'Locked in 🚐 · 2 seats left' });
    expect(RB.scarcityText({ committed: 5, minSeats: 4, capacity: 6, status: 'confirmed' }))
      .toEqual({ cls: 'pill-teal pill-dot', txt: 'Locked in 🚐 · 1 seat left' });
  });
});

describe('normalizeList(publicList) — projection to a card model', () => {
  const pl = {
    code: 'EM-1', corridorId: 'ella-south', from: 'Ella', to: 'Mirissa',
    date: '2026-08-08', slot: 'morning', lockedTime: null,
    minSeats: 4, capacity: 6, seatPrice: 2400, status: 'gathering',
    note: 'surfboards welcome', cutoffAt: '2026-08-01T00:00:00Z', committed: 2,
    members: [
      { position: 1, firstName: 'Léa', country: 'FR', photoUrl: null, isStarter: true },
      { position: 2, firstName: 'Tom', country: 'GB', photoUrl: 'https://x/p.jpg', isStarter: false }
    ]
  };

  it('maps wire fields to the card model', () => {
    const L = RB.normalizeList(pl);
    expect(L.code).toBe('EM-1');
    expect(L.from).toBe('Ella');
    expect(L.to).toBe('Mirissa');
    expect(L.corridorId).toBe('ella-south');
    expect(L.cost).toBe(24);
    expect(L.seatPriceCents).toBe(2400);
    expect(L.whenLabel).toBe('Sat 8 Aug');
    expect(L.minSeats).toBe(4);
    expect(L.capacity).toBe(6);
    expect(L.committed).toBe(2);
    expect(L.confirmed).toBe(false);
    expect(L.status).toBe('gathering');
    expect(L.cutoffMs).toBe(Date.parse('2026-08-01T00:00:00Z'));
    expect(L.fromId).toBe('ella');
    expect(L.toId).toBe('mirissa');
  });

  it('maps members with flag + photo fallbacks', () => {
    const L = RB.normalizeList(pl);
    expect(L.members).toHaveLength(2);
    expect(L.members[0]).toMatchObject({ name: 'Léa', flag: '🇫🇷', isStarter: true, photoUrl: null });
    expect(L.members[1]).toMatchObject({ name: 'Tom', flag: '🇬🇧', isStarter: false, photoUrl: 'https://x/p.jpg' });
  });

  it('marks confirmed lists and honours a locked time', () => {
    const L = RB.normalizeList(Object.assign({}, pl, { status: 'confirmed', lockedTime: '07:30' }));
    expect(L.confirmed).toBe(true);
    expect(RB.whenLine(L)).toBe('Sat 8 Aug · departs 07:30');
  });

  it('is defensive against a null / empty payload', () => {
    const L = RB.normalizeList(null);
    expect(L.members).toEqual([]);
    expect(L.status).toBe('gathering');
    expect(L.minSeats).toBe(RB.MIN_DEFAULT);
  });
});

describe('whenLine(list) — the card "when" line', () => {
  it('shows the slot window while gathering', () => {
    const L = RB.normalizeList({ from: 'Ella', to: 'Mirissa', date: '2026-08-08', slot: 'morning', status: 'gathering' });
    expect(RB.whenLine(L)).toBe('Sat 8 Aug · morning · departs 7–9 am');
  });
});

describe('resolvePlaceId(name)', () => {
  it('resolves prototype short names and transfers full names', () => {
    expect(RB.resolvePlaceId('Ella')).toBe('ella');
    expect(RB.resolvePlaceId('Mirissa')).toBe('mirissa');
    expect(RB.resolvePlaceId('Airport (CMB)')).toBe('cmb-airport');
    expect(RB.resolvePlaceId('Colombo city')).toBe('colombo'); // from transfers-data.js
  });
  it('returns null for the unknown', () => {
    expect(RB.resolvePlaceId('Atlantis')).toBe(null);
    expect(RB.resolvePlaceId('')).toBe(null);
  });
});

/* One traveller can bring people with them — up to three seats on the one name. These
   three helpers decide what the picker offers and what the "you pay" line promises. */

describe('mySeatsOn(list) — the seats on your own name', () => {
  const L = (members) => RB.normalizeList({ code: 'X', capacity: 6, committed: 4, members });

  it('is zero when you are not on the list', () => {
    expect(RB.mySeatsOn(L([{ firstName: 'Ada', seats: 2 }]))).toBe(0);
    expect(RB.mySeatsOn(null)).toBe(0);
  });
  it('reads the seats off the member the API marked as you', () => {
    expect(RB.mySeatsOn(L([{ firstName: 'Ada', seats: 2 }, { firstName: 'Bo', seats: 3, isYou: true }]))).toBe(3);
  });
  it('treats a seatless legacy row as one seat', () => {
    expect(RB.mySeatsOn(L([{ firstName: 'Bo', isYou: true }]))).toBe(1);
  });
});

describe('seatsOnOffer(list) — how many seats the picker may show', () => {
  const L = (over) => RB.normalizeList({ code: 'X', capacity: 6, committed: 0, members: [], ...over });

  it('offers the per-traveller maximum on an empty van', () => {
    expect(RB.seatsOnOffer(L())).toBe(3);
  });
  it('offers only what is free when the van is nearly full', () => {
    expect(RB.seatsOnOffer(L({ committed: 4 }))).toBe(2);
    expect(RB.seatsOnOffer(L({ committed: 5 }))).toBe(1);
  });
  // Your own seats are yours to give back, so they count as available to you.
  it('counts the seats you already hold as room you can still use', () => {
    const full = L({ committed: 6, members: [{ firstName: 'Bo', seats: 2, isYou: true }] });
    expect(RB.seatsOnOffer(full)).toBe(2);
  });
  it('never offers zero — a full van is refused by the API, not hidden by the picker', () => {
    expect(RB.seatsOnOffer(L({ committed: 6 }))).toBe(1);
  });
});

describe('seatTotal(each, seats) — what you are told you will be charged', () => {
  it('multiplies the seat price by the seats taken', () => {
    expect(RB.seatTotal(24, 1)).toBe(24);
    expect(RB.seatTotal(24, 2)).toBe(48);
    expect(RB.seatTotal(24, 3)).toBe(72);
  });
  it('rounds to the cent so a fractional fare never shows a long float', () => {
    expect(RB.seatTotal(20.55, 3)).toBe(61.65);
  });
  it('falls back to a single seat on junk input', () => {
    expect(RB.seatTotal(24, 0)).toBe(24);
    expect(RB.seatTotal(24, undefined)).toBe(24);
  });
});
