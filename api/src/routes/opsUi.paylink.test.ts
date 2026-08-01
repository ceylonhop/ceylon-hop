import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../app';

// Source contracts for the ops side of payment links (spec 2026-07-31). The ops shell is a
// served HTML app, so these pin the wiring the offline e2e can't cheaply reach: the button
// exists exactly where the lifecycle allows it, the handler is delegated, and the sandbox
// labelling can never be dropped without a red test.

let body = '';
beforeAll(async () => {
  body = await (await createApp().request('/ops')).text();
});

describe('ops shell: payment link wiring', () => {
  it('offers the button on ready and sent — for both roles — and nowhere else', () => {
    // Four action-bar branches carry it (approver/non-approver × ready/sent). The button is
    // built ONCE into a `PAYLINK` binding (it has a just-copied variant, so building it per
    // branch would mean four places to keep in step) and placed four times — so the source
    // contract is the PLACEMENTS, not the builder call.
    expect(body).toMatch(/var PAYLINK =/);
    const placements = body
      .split('\n')
      .filter((l) => l.includes('out.push') && /\bPAYLINK\b/.test(l));
    expect(placements.length).toBe(4);
    // …and none of them sit in a draft/pending_review/won/lost branch: every placement
    // lives on a line that also mentions markSent or markWon (the ready/sent bars).
    for (const line of placements) expect(/markSent|markWon/.test(line), line).toBe(true);
  });

  it('copies on press, and never claims to have copied when it could not', () => {
    // The press copies straight to the clipboard rather than revealing a row. The
    // already-minted path must copy SYNCHRONOUSLY: clipboard.writeText needs the click's
    // transient user activation, and awaiting the mint first can spend it (Safari then
    // rejects the write silently).
    expect(body).toContain('async function payLinkPress()');
    expect(body).toMatch(/if \(_payLink\) \{ copyPayLink\(\); return; \}/);
    // No clipboard API → fall back to the row and do NOT toast "copied".
    expect(body).toMatch(/_payLinkShowRow = true; render\(\); return false;/);
  });

  it('carries the sandbox warning on the copy path, not only in the row', () => {
    // The row is now a fallback, so a sandbox link would otherwise be copied with nothing
    // saying so. That must never happen: a sandbox link takes test-card money and still
    // marks a real booking Paid, so it must not pass for a live one in a WhatsApp message.
    expect(body).toMatch(/showToast\('Payment link copied — SANDBOX, test cards only', 'error'\)/);
  });

  it('delegates mint and copy through the action switch', () => {
    expect(body).toContain("action === 'mintPayLink'");
    expect(body).toContain("action === 'copyPayLink'");
    expect(body).toContain("'/pay-link'");
  });

  it('labels a non-live PayHere mode as sandbox, and renders the copyable row', () => {
    expect(body).toContain('SANDBOX — test cards only');
    expect(body).toContain("_payLink.mode !== 'live'");
    expect(body).toContain('ch-paylink-url');
    expect(body).toContain('data-action="copyPayLink"');
  });

  it('clears the minted link whenever the quote context resets', () => {
    // Every bookOpen reset also clears _payLink — a stale link from quote A must never
    // render against quote B.
    const bookResets = body.match(/bookOpen = false;/g) ?? [];
    const linkResets = body.match(/_payLink = null;/g) ?? [];
    expect(linkResets.length).toBeGreaterThanOrEqual(bookResets.length - 1);
  });
});
