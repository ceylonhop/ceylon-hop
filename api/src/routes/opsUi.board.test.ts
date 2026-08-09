import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../app';

// ────────────────────────────────────────────────────────────────────────────
//  Ops shell — ride-board van rows (2026-07-26).
//
//  The shell is one inlined script, so (like requestMismatch elsewhere in this
//  suite) we lift the pure helpers out and table-test them, and assert the rest
//  by pinning the source that wires them up. The point of these tests is the
//  SAFETY rail: a board row must never reach a /bookings/:id mutation, because
//  there is no booking behind it.
// ────────────────────────────────────────────────────────────────────────────

let body: string;

/** Pull `function NAME(` … matching brace out of the shell. */
function lift(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name} not found in the ops shell`).toBeGreaterThan(-1);
  let depth = 0; let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

/**
 * Pull a `const NAME=…;` arrow helper out, however many lines and braces it
 * spans — stop at the first `;` that sits at brace/paren depth zero.
 */
function liftConst(src: string, name: string): string {
  const start = src.indexOf(`const ${name}=`);
  expect(start, `${name} not found in the ops shell`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ';' && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} never terminated`);
}

beforeAll(async () => {
  body = await (await createApp().request('/ops')).text();
});

describe('board row helpers', () => {
  it('isBoard distinguishes a van row from a booking row', () => {
    const src = liftConst(body, 'isBoard');
    const isBoard = new Function(`${src}; return isBoard;`)() as (t: unknown) => boolean;
    expect(isBoard({ source: 'ride_board' })).toBe(true);
    expect(isBoard({ source: 'booking' })).toBe(false);
    expect(isBoard(null)).toBeFalsy();
    expect(isBoard(undefined)).toBeFalsy();
    expect(isBoard({})).toBe(false);
  });

  it('boardSeats says whether the van actually runs', () => {
    const src = liftConst(body, 'boardSeats');
    const f = new Function(`${src}; return boardSeats;`)() as (t: unknown) => string;

    expect(f({ board: { seatsCommitted: 2, minSeats: 3, capacity: 6 } }))
      .toBe('2 of 3 seats · needs more');
    expect(f({ board: { seatsCommitted: 3, minSeats: 3, capacity: 6 } }))
      .toBe('3 of 3 seats · van runs · 3 spare');
    expect(f({ board: { seatsCommitted: 6, minSeats: 3, capacity: 6 } }))
      .toBe('6 of 3 seats · van runs · 0 spare');
  });

  it('boardSeats is silent on a row with no board payload', () => {
    const src = liftConst(body, 'boardSeats');
    const f = new Function(`${src}; return boardSeats;`)() as (t: unknown) => string;
    expect(f({ board: null })).toBe('');
  });
});

describe('stageLabel keeps grouping and wording separate', () => {
  function labeller() {
    const src = `${liftConst(body, 'isBoard')}\n${/const STAGE=\{[\s\S]*?\n\};/.exec(body)![0]}\n${liftConst(body, 'stageLabel')}`;
    return new Function(`${src}; return stageLabel;`)() as (t: unknown) => string;
  }

  it('never calls a van "Paid" — that would contradict a held or failed card', () => {
    // The row groups under the 'paid' stage so it sits with real bookings that
    // need a vehicle, but a confirmed van's money may still be merely held.
    const f = labeller();
    expect(f({ source: 'ride_board', stage: 'paid', board: { listStatus: 'confirmed' } }))
      .toBe('Van confirmed');
  });

  it('labels a still-gathering van plainly', () => {
    expect(labeller()({ source: 'ride_board', stage: 'gathering', board: { listStatus: 'gathering' } }))
      .toBe('Gathering names');
  });

  it('leaves real bookings on their normal stage wording', () => {
    const f = labeller();
    expect(f({ source: 'booking', stage: 'paid' })).toBe('Paid');
    expect(f({ source: 'booking', stage: 'awaiting_payment' })).toBe('Awaiting payment');
  });
});

describe('reason() never nags about a van', () => {
  it('returns nothing for a ride-board row whatever its stage', () => {
    // reason() consults CLOSED to stay silent about finished bookings, so lift both.
    const src = `${liftConst(body, 'CLOSED')} ${liftConst(body, 'reason')}`;
    const reason = new Function(`${src}; return reason;`)() as (t: unknown) => string;
    expect(reason({ source: 'ride_board', stage: 'gathering' })).toBe('');
    expect(reason({ source: 'ride_board', stage: 'paid' })).toBe('');
    // a real booking still nags
    expect(reason({ source: 'booking', stage: 'paid' })).toBe('Vehicle not confirmed yet');
    // …but a closed one never does, whichever way it closed.
    for (const stage of ['completed', 'no_show', 'cancelled', 'refunded']) {
      expect(reason({ source: 'booking', stage })).toBe('');
    }
  });
});

describe('the ops shell wires board rows up safely', () => {
  it('knows the gathering stage and the ride-board mode label', () => {
    expect(body).toContain("gathering:{label:'Gathering names'");
    expect(body).toContain("board:'Ride board'");
  });

  it('keeps gathering OUT of the booking pipeline and its advance map', () => {
    // STAGES / NEXT drive the advance buttons — a van must never appear there.
    const stages = /const STAGES=\[(.*?)\];/.exec(body)?.[1] ?? '';
    expect(stages).not.toContain('gathering');
    const next = body.slice(body.indexOf('const NEXT={'), body.indexOf('};', body.indexOf('const NEXT={')));
    expect(next).not.toContain('gathering');
  });

  it('short-circuits openDetail so a van never fetches a booking that does not exist', () => {
    expect(body).toContain("if(String(id).indexOf('board:')===0)return;");
  });

  it('blocks every booking mutation for a board row', () => {
    expect(body).toContain(
      "if(isBoard(t)&&['advance','noshow','toggle','addnote','payreminder','paylink','cancelbooking','refundrequest','refundconfirm','refundexecute','refundcancel'].includes(act))return;",
    );
  });

  it('renders the read-only van sheet instead of the booking sheet', () => {
    expect(body).toContain('function boardSheetHtml(');
    expect(body).toContain('if(isBoard(t)){sh.innerHTML=boardSheetHtml(t,st);');
    // the van sheet must not offer note-taking or flag switches
    const sheet = body.slice(body.indexOf('function boardSheetHtml('), body.indexOf('function renderSheet()'));
    expect(sheet).not.toContain("data-act=\"toggle\"");
    expect(sheet).not.toContain("data-act=\"addnote\"");
    expect(sheet).not.toContain("data-act=\"advance\"");
  });

  it('carries source and board through the row → ticket mapping', () => {
    const src = lift(body, 'rowToTicket');
    expect(src).toContain("source:row.source||'booking'");
    expect(src).toContain('board:row.board||null');
  });
});
