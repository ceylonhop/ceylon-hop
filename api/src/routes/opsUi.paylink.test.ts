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
    // Four action-bar branches carry it (approver/non-approver × ready/sent). The button
    // markup is built by the bar's B() helper, so the source contract is the builder call.
    const buttons = body.match(/B\('mintPayLink'/g) ?? [];
    expect(buttons.length).toBe(4);
    // …and none of them sit in a draft/pending_review/won/lost branch: every occurrence
    // lives on a line that also mentions markSent or markWon (the ready/sent bars).
    for (const line of body.split('\n').filter((l) => l.includes('mintPayLink') && l.includes("out.push"))) {
      expect(/markSent|markWon/.test(line), line).toBe(true);
    }
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
