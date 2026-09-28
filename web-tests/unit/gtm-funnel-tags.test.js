// web-tests/unit/gtm-funnel-tags.test.js
// The core booking funnel never reached GA4. The 2026-09-20 audit listed `search`,
// `view_item_list`, `select_item`, `begin_checkout`, `checkout_step`, `add_payment_info`,
// `purchase`, `view_item` and `exception` as "tagged and live", so gtm-event-coverage.test.js
// exempted them. The published container (v20, re-read 2026-09-28) had no GA4 tag for any of
// them, and a live search page sent only `page_view` to GA4 while `search` and
// `view_item_list` sat in dataLayer. No purchase has ever been recorded from the site.
//
// Google Ads was dark for the same reason from the other side: its only conversion tag fired
// on URLs containing /my-account/, a WordPress path the new site does not have.
//
// tools/analytics/build-gtm-funnel-tags.mjs emits one import for both. This pins it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENTS, ADS, container } from '../../tools/analytics/build-gtm-funnel-tags.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cv = container.containerVersion;
const tag = (name) => cv.tag.find((t) => t.name === name);
const param = (t, key) => (t.parameter.find((p) => p.key === key) || {}).value;
const sent = (t) => ((t.parameter.find((p) => p.key === 'eventSettingsTable') || {}).list || [])
  .map((row) => Object.fromEntries(row.map.map((m) => [m.key, m.value])));
const consentOf = (t) => t.consentSettings && t.consentSettings.consentType.list.map((c) => c.value);

const CORE = ['search', 'view_item_list', 'select_item', 'begin_checkout', 'checkout_step',
  'add_payment_info', 'purchase', 'view_item', 'exception'];

describe('GA4 tags for the core funnel', () => {
  it.each(CORE)('%s has a GA4 event tag on its own custom-event trigger', (name) => {
    const t = tag(`GA4 - ${name}`);
    expect(t, `no tag for ${name}`).toBeTruthy();
    expect(t.type).toBe('gaawe');
    expect(param(t, 'eventName')).toBe(name);
    expect(param(t, 'measurementIdOverride')).toBe('G-XEW62ZD7B3');
    const trig = cv.trigger.find((x) => x.triggerId === t.firingTriggerId[0]);
    expect(trig.type).toBe('CUSTOM_EVENT');
    expect(trig.customEventFilter[0].parameter.find((p) => p.key === 'arg1').value).toBe(name);
  });

  it.each(CORE)('%s is analytics, gated on analytics_storage only', (name) => {
    expect(consentOf(tag(`GA4 - ${name}`))).toEqual(['analytics_storage']);
  });

  // Params read off the production call sites (search.js, booking.js, board.js, plan.js,
  // pay.html, quote.html, manage.html). The revenue fields are the ones that must never drop.
  it('purchase carries the money and the booking reference', () => {
    const p = sent(tag('GA4 - purchase')).map((r) => r.parameter);
    for (const k of ['transaction_id', 'value', 'currency', 'payment_type']) expect(p).toContain(k);
  });

  it('list and select events carry the GA4 items array', () => {
    for (const n of ['view_item_list', 'select_item']) {
      const rows = sent(tag(`GA4 - ${n}`));
      expect(rows.find((r) => r.parameter === 'items'), `${n} items`).toEqual({ parameter: 'items', parameterValue: '{{DLV - items}}' });
    }
  });

  it('search keeps the fields the analytics docs ask to register', () => {
    const p = sent(tag('GA4 - search')).map((r) => r.parameter);
    for (const k of ['from', 'to', 'date', 'pax', 'source', 'estimate_state', 'freetext_place']) expect(p).toContain(k);
  });

  it('every parameter maps to its own same-named data-layer variable', () => {
    for (const t of cv.tag.filter((x) => x.type === 'gaawe')) {
      for (const r of sent(t)) expect(r.parameterValue).toBe(`{{DLV - ${r.parameter}}}`);
    }
  });

  it('defines every variable the tags reference, and no other', () => {
    const referenced = new Set(cv.tag.flatMap((t) => JSON.stringify(t).match(/\{\{DLV - [a-z_]+\}\}/g) || [])
      .map((s) => s.slice(2, -2)));
    expect(new Set(cv.variable.map((v) => v.name))).toEqual(referenced);
  });

  it('the EVENTS list and the emitted tags agree', () => {
    expect(EVENTS.map((e) => e.name).sort()).toEqual([...CORE].sort());
  });
});

describe('Google Ads purchase conversion', () => {
  const ads = () => tag('Google Ads - purchase');

  it('reuses the existing conversion action (owner, 2026-09-28)', () => {
    expect(param(ads(), 'conversionId')).toBe('16942077888');
    expect(param(ads(), 'conversionLabel')).toBe('CHodCMCvtMMaEMCvzo4_');
    expect(ADS.label).toBe('CHodCMCvtMMaEMCvzo4_');
  });

  it('fires on the purchase event, not on a URL', () => {
    const trig = cv.trigger.find((x) => x.triggerId === ads().firingTriggerId[0]);
    expect(trig.type).toBe('CUSTOM_EVENT');
    expect(trig.customEventFilter[0].parameter.find((p) => p.key === 'arg1').value).toBe('purchase');
  });

  it('reports the value, currency and order id, so revenue and de-duplication work', () => {
    expect(param(ads(), 'conversionValue')).toBe('{{DLV - value}}');
    expect(param(ads(), 'currencyCode')).toBe('{{DLV - currency}}');
    expect(param(ads(), 'orderId')).toBe('{{DLV - transaction_id}}');
  });

  // Advertising. In Europe ad_storage is denied until the cookie strip's Accept (#853).
  it('needs ad_storage', () => {
    expect(consentOf(ads())).toEqual(['ad_storage']);
  });

  it('ships a conversion linker on every page (GTM diagnostics: "Missing conversion linker")', () => {
    const linker = cv.tag.find((t) => t.type === 'gclidw');
    expect(linker, 'no conversion linker').toBeTruthy();
    expect(linker.firingTriggerId).toEqual(['2147479553']); // GTM's built-in All Pages
  });
});

describe('the committed import file is the builder output', () => {
  it('docs/analytics/gtm-funnel-tags.json is up to date', () => {
    const onDisk = readFileSync(path.join(ROOT, 'docs/analytics/gtm-funnel-tags.json'), 'utf8');
    expect(onDisk).toBe(JSON.stringify(container, null, 2) + '\n');
  });
});
