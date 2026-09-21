// web-tests/unit/gtm-meta-conversions.test.js
// The Meta pixel loaded on every page and reported no conversions: "Purchase",
// "InitiateCheckout" and "AddToCart" appeared ZERO times in the published container
// (audited 2026-09-20). Meta was told visitors arrived and never told one bought, so its
// optimiser had no signal to learn from and no ad spend was measurable.
//
// THE BUG THIS FILE EXISTS TO PREVENT. GTM substitutes a variable's value as RAW TEXT into
// Custom HTML. The first version of this tag read:
//     fbq('track','Purchase',{value: {{DLV - value}}, currency: {{DLV - currency}}})
// which renders as `currency: USD` — a ReferenceError — and, when the variable is empty,
// `value: ` — a syntax error that kills the tag silently. Every substitution must sit INSIDE
// quotes and be coerced in JS. That is not a style preference; it is the difference between
// a working tag and one that throws on every purchase.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENTS, PIXEL_ID } from '../../tools/analytics/build-gtm-meta-conversions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = JSON.parse(readFileSync(path.join(ROOT, 'docs/analytics/gtm-meta-conversions.json'), 'utf8'));
const tags = file.containerVersion.tag;
const htmlOf = (t) => t.parameter.find((p) => p.key === 'html').value;

/** Render a tag the way GTM would, then run it against a stub fbq. */
function fire(tag, vars) {
  let body = htmlOf(tag).replace(/<\/?script>/g, '');
  for (const [k, v] of Object.entries(vars)) body = body.split(`{{${k}}}`).join(v);
  const calls = [];
  // eslint-disable-next-line no-new-func
  new Function('fbq', body)((...a) => calls.push(a));
  return calls;
}

const FULL = { 'DLV - value': '140', 'DLV - currency': 'USD', 'DLV - transaction_id': 'CH-ABCDE' };
const EMPTY = { 'DLV - value': '', 'DLV - currency': '', 'DLV - transaction_id': '' };

describe('Meta pixel conversion tags', () => {
  it('covers the three events, and the file matches the generator', () => {
    expect(tags.map((t) => t.name).sort()).toEqual(EVENTS.map((e) => `Meta - ${e.name}`).sort());
  });

  it('never substitutes a GTM variable outside quotes', () => {
    for (const t of tags) {
      for (const m of htmlOf(t).matchAll(/(.?)\{\{[^}]+\}\}(.?)/g)) {
        expect(m[1], `${t.name}: opening quote missing before ${m[0]}`).toBe('"');
        expect(m[2], `${t.name}: closing quote missing after ${m[0]}`).toBe('"');
      }
    }
  });

  it('sends real value, currency and a dedupe id on Purchase', () => {
    const [call] = fire(tags.find((t) => t.name === 'Meta - Purchase'), FULL);
    expect(call[0]).toBe('track');
    expect(call[1]).toBe('Purchase');
    expect(call[2]).toMatchObject({ value: 140, currency: 'USD' });
    // eventID lets Meta dedupe against server-side CAPI if it is ever added. Without it,
    // adding CAPI later double-counts every sale.
    expect(call[3]).toEqual({ eventID: 'CH-ABCDE' });
  });

  it('degrades safely when GTM renders the variables empty', () => {
    for (const t of tags) {
      const calls = fire(t, EMPTY);
      expect(calls, `${t.name} must still fire`).toHaveLength(1);
      const props = calls[0][2];
      expect(props, `${t.name} must not send NaN`).not.toHaveProperty('value', NaN);
      expect(Number.isNaN(props.value), `${t.name} value must never be NaN`).toBe(false);
    }
  });

  it('does not fire at all when the base pixel is absent', () => {
    for (const t of tags) {
      const body = htmlOf(t).replace(/<\/?script>/g, '').replace(/\{\{[^}]+\}\}/g, '');
      // No fbq in scope: the guard must return rather than throw into the page.
      expect(() => new Function(body)(), `${t.name} threw without fbq`).not.toThrow();
    }
  });

  it('gates every tag on ad_storage, not analytics_storage', () => {
    for (const t of tags) {
      expect(t.consentSettings.consentStatus).toBe('NEEDED');
      expect(t.consentSettings.consentType.list[0].value, `${t.name}: advertising tags need ad_storage`)
        .toBe('ad_storage');
    }
  });

  it('sends no personal data to Meta', () => {
    const forbidden = /\b(em|ph|fn|ln|external_id|email|phone|user_data)\b/;
    for (const t of tags) {
      expect(htmlOf(t), `${t.name} must not include advanced matching / PII`).not.toMatch(forbidden);
    }
    expect(PIXEL_ID).toMatch(/^\d+$/);
  });
});
