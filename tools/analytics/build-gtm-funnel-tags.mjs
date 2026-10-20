// tools/analytics/build-gtm-funnel-tags.mjs
// Emit a GTM container import for the CORE booking funnel, plus the Google Ads purchase
// conversion. Re-audited against the published container (gtm.js?id=GTM-NL6K22CM, v20) on
// 2026-09-28:
//   - the nine events below had NO GA4 tag. The 2026-09-20 audit had listed them as "tagged
//     and live" and gtm-event-coverage.test.js exempted them on that word, so no search,
//     checkout or purchase from the site ever reached GA4. A live search page sent only
//     `page_view` while `search` and `view_item_list` sat in dataLayer.
//   - Google Ads' only conversion fired on URLs containing /my-account/ (WordPress), a path the
//     new site does not have, and there was no conversion linker.
//
// Same shape as build-gtm-missing-tags.mjs (which imported cleanly): `gaawe` tags, one
// custom-event trigger each, analytics_storage gating. Import with Admin → Import Container →
// Existing workspace → Merge → OVERWRITE conflicting: the DLVs shared with the earlier imports
// (value, currency, item_list_id, …) are defined identically, so overwriting is a no-op for
// them and nothing is duplicated.
//
// Run:  node tools/analytics/build-gtm-funnel-tags.mjs docs/analytics/gtm-funnel-tags.json
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MEASUREMENT_ID = 'G-XEW62ZD7B3';

/* Params were read off the production call sites; an event sends the union of what its
   emitters pass (a DLV that is unset on a given push is simply not sent). */
const EVENTS = [
  { name: 'search', params: ['from', 'to', 'date', 'pax', 'pax_set', 'source', 'estimate_state', 'freetext_place', 'route_fingerprint'],
    why: 'Top of the funnel: a results page was shown (search.js). freetext_place says which ends were typed, not picked.' },
  { name: 'view_item_list', params: ['item_list_id', 'item_list_name', 'currency', 'items', 'lapsed', 'board_count', 'filter_from', 'filter_to'],
    why: 'What was put in front of them: search results, the planner, a customer quote, or the ride board.' },
  { name: 'select_item', params: ['item_list_id', 'mode', 'item_variant', 'stops', 'item_id', 'item_name', 'seats_committed', 'seats_needed', 'currency', 'items'],
    why: 'They picked one: a result, a quote option, a board van, or the planner dates step.' },
  { name: 'begin_checkout', params: ['currency', 'value', 'mode', 'route', 'item_list_id', 'stops', 'flow', 'item_id'],
    why: 'Entered checkout: booking page, pay link, manage balance, board join, or planner hand-off.' },
  { name: 'checkout_step', params: ['step', 'name'],
    why: 'Forward progress through the booking steps (when / where / pax or service / payment).' },
  { name: 'add_payment_info', params: ['payment_type', 'currency', 'value'],
    why: 'Chose a payment plan (booking) or reached the pay step (pay link).' },
  { name: 'purchase', params: ['transaction_id', 'value', 'currency', 'payment_type', 'items'],
    why: 'Revenue. Gated in code to real hosts and de-duplicated per booking reference.' },
  { name: 'view_item', params: ['item_category', 'value', 'currency'],
    why: 'A pay link was opened on something payable.' },
  { name: 'exception', params: ['description'],
    why: 'The ride board hit an error it could not recover from.' },
];

/* The EXISTING conversion action, reused (owner, 2026-09-28). */
const ADS = { id: '16942077888', label: 'CHodCMCvtMMaEMCvzo4_' };
const ALL_PAGES = '2147479553'; // GTM's built-in "All Pages" trigger

const dlv = (n) => `DLV - ${n}`;
const base = { accountId: '0', containerId: '0' };
const consent = (type) => ({
  consentStatus: 'NEEDED',
  consentType: { type: 'LIST', list: [{ type: 'TEMPLATE', value: type }] },
});
const customEvent = (triggerId, event, name = `CE - ${event}`) => ({
  ...base, triggerId, name, type: 'CUSTOM_EVENT',
  customEventFilter: [{
    type: 'EQUALS',
    parameter: [
      { type: 'TEMPLATE', key: 'arg0', value: '{{_event}}' },
      { type: 'TEMPLATE', key: 'arg1', value: event },
    ],
  }],
});

const triggers = EVENTS.map((e, i) => customEvent(String(i + 1), e.name));

const tags = EVENTS.map((e, i) => ({
  ...base, tagId: String(i + 1), name: `GA4 - ${e.name}`, type: 'gaawe',
  notes: e.why,
  parameter: [
    { type: 'BOOLEAN', key: 'sendEcommerceData', value: 'false' },
    { type: 'TEMPLATE', key: 'eventName', value: e.name },
    {
      type: 'LIST', key: 'eventSettingsTable',
      list: e.params.map((p) => ({
        type: 'MAP',
        map: [
          { type: 'TEMPLATE', key: 'parameter', value: p },
          { type: 'TEMPLATE', key: 'parameterValue', value: `{{${dlv(p)}}}` },
        ],
      })),
    },
    { type: 'TEMPLATE', key: 'measurementIdOverride', value: MEASUREMENT_ID },
  ],
  consentSettings: consent('analytics_storage'),
  firingTriggerId: [String(i + 1)],
}));

// Google Ads: shares the GA4 `CE - purchase` trigger, needs advertising consent, and gets a
// linker so ad clicks can be attributed. (The Meta import keeps its own `CE - purchase (Meta)`.)
const purchaseTrigger = String(EVENTS.findIndex((e) => e.name === 'purchase') + 1);
tags.push({
  ...base, tagId: String(tags.length + 1), name: 'Google Ads - purchase', type: 'awct',
  notes: 'Replaces the WordPress-era conversion that fired on /my-account/ URLs, which the new site does not have.',
  parameter: [
    { type: 'TEMPLATE', key: 'conversionId', value: ADS.id },
    { type: 'TEMPLATE', key: 'conversionLabel', value: ADS.label },
    { type: 'TEMPLATE', key: 'conversionValue', value: `{{${dlv('value')}}}` },
    { type: 'TEMPLATE', key: 'currencyCode', value: `{{${dlv('currency')}}}` },
    { type: 'TEMPLATE', key: 'orderId', value: `{{${dlv('transaction_id')}}}` },
    { type: 'BOOLEAN', key: 'enableConversionLinker', value: 'true' },
  ],
  consentSettings: consent('ad_storage'),
  firingTriggerId: [purchaseTrigger],
});
tags.push({
  ...base, tagId: String(tags.length + 1), name: 'Conversion Linker', type: 'gclidw',
  notes: 'Keeps the Google Ads click id across pages so the purchase conversion can be attributed.',
  parameter: [{ type: 'BOOLEAN', key: 'enableCrossDomain', value: 'false' }],
  firingTriggerId: [ALL_PAGES],
});

const used = [...new Set(tags.flatMap((t) => JSON.stringify(t).match(/\{\{DLV - [a-z_]+\}\}/g) || [])
  .map((s) => s.slice(8, -2)))].sort();
const variables = used.map((p, i) => ({
  ...base, variableId: String(i + 1), name: dlv(p), type: 'v',
  parameter: [
    { type: 'INTEGER', key: 'dataLayerVersion', value: '2' },
    { type: 'BOOLEAN', key: 'setDefaultValue', value: 'false' },
    { type: 'TEMPLATE', key: 'name', value: p },
  ],
}));

const container = {
  exportFormatVersion: 2,
  exportTime: '2026-09-28 00:00:00',
  containerVersion: {
    path: 'accounts/0/containers/0/versions/0',
    accountId: '0', containerId: '0', containerVersionId: '0',
    name: 'Core funnel + Google Ads purchase (import)',
    container: { accountId: '0', containerId: '0', name: 'ceylonhop', publicId: 'GTM-NL6K22CM', usageContext: ['WEB'] },
    variable: variables, trigger: triggers, tag: tags,
  },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const json = JSON.stringify(container, null, 2) + '\n';
  const out = process.argv[2];
  if (out) { writeFileSync(out, json); console.error(`wrote ${out}: ${tags.length} tags, ${triggers.length} triggers, ${variables.length} variables`); }
  else process.stdout.write(json);
}

export { EVENTS, ADS, container };
