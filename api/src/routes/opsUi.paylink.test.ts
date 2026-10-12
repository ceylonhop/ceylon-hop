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

  it('reads the server’s refusal REASON rather than blaming approval status', () => {
    // The 409 body carries `reason`. Both mint paths must route through the one mapper, or a
    // discounted quote gets told to fix a status that was correct all along (2026-08-10).
    expect(body).toContain('function payLinkRefusal(err, fallback)');
    expect(body).toMatch(/err\.reason === 'discounted'/);
    expect(body).toContain('A discounted quote can only take a full-total payment link');
    // Both pay-link call sites go through it — the bodyless mint and the partial picker.
    // (The separate /quote-link handler keeps its own inline text: that route has no `reason`.)
    const callers = body.split('\n').filter((l) => l.includes('showToast(payLinkRefusal(err,'));
    expect(callers.length).toBe(2);
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

// Spec 2026-10-07 §5.4: ops mints one ordinary pay link and the CUSTOMER picks deposit or full on
// it, so the estimate chip says what the customer will be offered rather than "pay in full".
describe('ops shell: the estimate chip names the deposit option', () => {
  it('says the customer can pay a deposit or in full, with both figures, when the quote is eligible', () => {
    expect(body).toContain('Customer can pay a deposit of ');
    expect(body).toContain(' (balance ');
    expect(body).toContain(' later) or in full on the pay link');
    // Driven by the engine's own deposit figure — the same rule /quotes/pay/view applies — never
    // a second copy of the eligibility rule in the browser.
    expect(body).toMatch(/est\.deposit && est\.deposit\.cents > 0/);
  });

  it('keeps the old chip for a quote that is not deposit-eligible', () => {
    expect(body).toContain('Pay in full to confirm');
    expect(body).toContain('no balance due after checkout');
  });
});

// Pay link for either option of a "both" quote (spec 2026-10-12 §4.4). The chooser is a second
// way INTO the same mint, not a second mint: one function, one refusal mapper.
describe('ops shell: the "both" quote payment-link chooser', () => {
  it('opens from payLinkPress only when the quote carries an alternative, and leaves the plain path alone', () => {
    const press = body.slice(body.indexOf('async function payLinkPress()'));
    const fn = press.slice(0, press.indexOf('\n}\n'));
    // The chooser branch comes first, gated on the server's payOptions…
    expect(fn).toMatch(/payServiceOptions\(state\.payOptions\)\.length/);
    expect(fn.indexOf('openPayChooser()')).toBeGreaterThan(-1);
    expect(fn.indexOf('openPayChooser()')).toBeLessThan(fn.indexOf('if (_payLink) { copyPayLink(); return; }'));
    // …and the existing copy-synchronously-then-mint lines are still there, unchanged.
    expect(fn).toContain('if (_payLink) { copyPayLink(); return; }');
    expect(fn).toContain('await mintPayLink() && _payLink');
  });

  it('delegates the pick and the cancel through the action switch', () => {
    expect(body).toContain("action === 'payChoose'");
    expect(body).toContain("action === 'cancelPayChoose'");
    expect(body).toContain('data-action="payChoose"');
    expect(body).toContain('data-action="cancelPayChoose"');
    // No inline handler — onclick= is dead under the page CSP.
    expect(body).not.toMatch(/onclick="pickPayService/);
  });

  it('mints through the SAME mintPayLink, sending only the service — never an amount', () => {
    expect(body).toContain('async function mintPayLink(service)');
    expect(body).toMatch(/JSON\.stringify\(\{ service: service \}\)/);
    expect(body).toMatch(/await mintPayLink\(service\)/);
    // The refusal mapper still has exactly its two callers (bodyless/service mint + part picker).
    const callers = body.split('\n').filter((l) => l.includes('showToast(payLinkRefusal(err,'));
    expect(callers.length).toBe(2);
  });

  it('names the product in the toast and the sandbox warning, and says what a refusal means', () => {
    expect(body).toContain(' payment link copied');
    expect(body).toMatch(/err\.reason === 'no_alternative'/);
    expect(body).toContain('This quote has no Chauffeur-guide price saved \\u2014 reopen the quote and save it again to get one');
  });

  it('warns, never blocks, when a payment was started on the current link (D5)', () => {
    expect(body).toContain('A payment was started on the current link — it is not cancelled by switching.');
  });

  it('keeps Part of trip as its own point-to-point-only path', () => {
    expect(body).toContain("action === 'openPayPart'");
    expect(body).toContain("'/pay-lines'");
  });
});
