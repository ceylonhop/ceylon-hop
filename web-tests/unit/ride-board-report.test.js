import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTransfers } from './_load.js';

// ────────────────────────────────────────────────────────────────────────────
//  Ride-board error reporting (2026-07-26).
//
//  Handled ride-board failures used to die in console.error + a GA4 'exception'
//  and never reached Sentry, so nobody found out when joins started failing.
//  These pin the two pure decisions behind the new reporter: WHAT is worth
//  reporting, and WHAT the payload looks like. The sending itself is a beacon.
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

let RB;
beforeAll(() => {
  loadTransfers();
  const src = readFileSync(path.join(ROOT, 'board.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(src)();
  RB = window.RideBoard;
});

describe('shouldReport(err)', () => {
  it('reports a genuine failure', () => {
    expect(RB.shouldReport(new Error('boom'))).toBe(true);
    expect(RB.shouldReport({ status: 500, message: 'server' })).toBe(true);
    expect(RB.shouldReport({ status: 0, message: 'network down' })).toBe(true);
  });

  it('stays quiet about a missing list — a stale share link is not a bug', () => {
    expect(RB.shouldReport({ status: 404 })).toBe(false);
  });

  it('stays quiet about sign-in required — that is a normal state, not a fault', () => {
    expect(RB.shouldReport({ status: 401 })).toBe(false);
  });

  it('stays quiet about a full van and a closed list — both are expected outcomes', () => {
    expect(RB.shouldReport({ status: 409 })).toBe(false);
  });

  it('reports when handed nothing at all, rather than silently dropping it', () => {
    expect(RB.shouldReport(null)).toBe(true);
    expect(RB.shouldReport(undefined)).toBe(true);
  });
});

describe('errorPayload(ctx, err)', () => {
  it('tags the subsystem and the calling context so Sentry groups it usefully', () => {
    const p = RB.errorPayload('join', new Error('card declined'));
    expect(p.message).toBe('[ride-board] join: card declined');
  });

  it('falls back to a stable label when the error has no message', () => {
    expect(RB.errorPayload('load', {}).message).toBe('[ride-board] load: board_error');
    expect(RB.errorPayload('load', null).message).toBe('[ride-board] load: board_error');
  });

  it('carries the stack when there is one', () => {
    const e = new Error('x');
    e.stack = 'Error: x\n    at somewhere';
    expect(RB.errorPayload('c', e).stack).toContain('at somewhere');
  });

  it('tolerates a missing stack', () => {
    expect(RB.errorPayload('c', { message: 'x' }).stack).toBe('');
  });

  it('truncates to the limits the /errors/client endpoint enforces', () => {
    const e = new Error('m'.repeat(900));
    e.stack = 's'.repeat(3000);
    const p = RB.errorPayload('ctx', e);
    expect(p.message.length).toBeLessThanOrEqual(500);
    expect(p.stack.length).toBeLessThanOrEqual(1500);
  });

  it('never lets a hostile error object throw the reporter', () => {
    const nasty = { get message() { throw new Error('nope'); } };
    expect(() => RB.errorPayload('ctx', nasty)).not.toThrow();
    expect(RB.errorPayload('ctx', nasty).message).toContain('[ride-board]');
  });
});
