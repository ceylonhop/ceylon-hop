// tools/analytics/build-gtm-meta-conversions.mjs
// Emit a GTM container JSON that makes the Meta Pixel report conversions.
//
// AUDITED 2026-09-20 against the published container: the Facebook base pixel loads on every
// page, and the strings "Purchase", "InitiateCheckout" and "AddToCart" appear ZERO times. So
// Meta has been told a visitor arrived and never told one bought. Every ad Ceylon Hop has run
// is unmeasurable on Meta's side, and Meta's own optimisation has had no conversion signal to
// learn from — which costs money quietly, in worse ad delivery, not just in reporting.
//
// Three events, chosen for what this business actually sells:
//   Purchase          on `purchase`          — the booking, with its real value
//   InitiateCheckout  on `begin_checkout`    — top of the paid funnel
//   Lead              on `contact_whatsapp`  — for a WhatsApp-first business this IS a
//                                              conversion; GA4 already treats it as a key event
//
// TWO THINGS THAT MAKE THIS SAFE TO IMPORT:
//
// 1. It defines only ONE variable (`DLV - transaction_id`). `DLV - value` and `DLV - currency`
//    already exist from the 2026-09-20 missing-tags import, and Custom HTML resolves `{{Name}}`
//    by name at publish time — so referencing them without redefining them avoids the duplicate
//    "DLV - value 1" that a re-import would otherwise create.
//
// 2. `eventID` is set to the booking reference on Purchase. If server-side CAPI is ever added,
//    Meta deduplicates browser and server events that share an eventID. Without it, adding CAPI
//    later silently double-counts every sale.
//
// CONSENT: these are advertising tags, so they require `ad_storage` — NOT the `analytics_storage`
// the GA4 tags use. Getting that wrong would fire ad pixels for someone who declined ads.
//
// NO PII. No email, phone or name is sent — advanced matching is deliberately not enabled. That
// would ship customer identifiers to Meta and is the owner's call, not a tagging detail.
import { writeFileSync } from 'node:fs';

const PIXEL_ID = '656008603498739';

const EVENTS = [
  {
    name: 'Purchase', on: 'purchase',
    why: 'The booking itself, with its real value — what every Meta ad should be optimised toward.',
    extra: `props.content_type = 'product';`,
    eventId: true,
  },
  {
    name: 'InitiateCheckout', on: 'begin_checkout',
    why: 'Top of the paid funnel. Gives Meta a mid-funnel signal on the many visitors who never reach Purchase.',
  },
  {
    name: 'Lead', on: 'contact_whatsapp',
    why: 'Most customers reach us on WhatsApp rather than paying online. GA4 counts it as a key event; Meta should too.',
    extra: `props.content_name = 'whatsapp_contact';`,
    noMoney: true,
  },
];

const base = { accountId: '0', containerId: '0' };

/* fbq is loaded by the existing base pixel tag. Guarding on typeof means that if the base tag
   is ever paused or blocked, these fire nothing instead of throwing a ReferenceError into the
   page — a tag that breaks the page is worse than a tag that misses a conversion.

   EVERY {{variable}} IS INSIDE QUOTES. GTM substitutes a variable's value as RAW TEXT, so an
   unquoted `currency: {{DLV - currency}}` renders as `currency: USD` — a ReferenceError — and
   an undefined value renders as `value: ` , a syntax error that kills the whole tag. Quoting
   and coercing in JS is the only form that survives a missing or non-numeric value. */
const html = (e) => `<script>
  (function () {
    if (typeof fbq !== 'function') return;
    var props = {};
${e.noMoney ? '' : `    var value = parseFloat("{{DLV - value}}");
    if (!isNaN(value)) { props.value = value; props.currency = "{{DLV - currency}}" || 'USD'; }
`}${e.extra ? `    ${e.extra}
` : ''}${e.eventId ? `    var ref = "{{DLV - transaction_id}}";
    fbq('track', ${JSON.stringify(e.name)}, props, ref ? {eventID: ref} : undefined);
` : `    fbq('track', ${JSON.stringify(e.name)}, props);
`}  })();
</script>`;

const variables = [{
  ...base, variableId: '1', name: 'DLV - transaction_id', type: 'v',
  parameter: [
    { type: 'INTEGER', key: 'dataLayerVersion', value: '2' },
    { type: 'BOOLEAN', key: 'setDefaultValue', value: 'false' },
    { type: 'TEMPLATE', key: 'name', value: 'transaction_id' },
  ],
}];

const triggers = EVENTS.map((e, i) => ({
  ...base, triggerId: String(i + 1), name: `CE - ${e.on} (Meta)`, type: 'CUSTOM_EVENT',
  customEventFilter: [{
    type: 'EQUALS',
    parameter: [
      { type: 'TEMPLATE', key: 'arg0', value: '{{_event}}' },
      { type: 'TEMPLATE', key: 'arg1', value: e.on },
    ],
  }],
}));

const tags = EVENTS.map((e, i) => ({
  ...base, tagId: String(i + 1), name: `Meta - ${e.name}`, type: 'html',
  notes: `${e.why} Pixel ${PIXEL_ID}. Requires ad_storage.`,
  parameter: [
    { type: 'TEMPLATE', key: 'html', value: html(e) },
    { type: 'BOOLEAN', key: 'supportDocumentWrite', value: 'false' },
  ],
  consentSettings: {
    consentStatus: 'NEEDED',
    consentType: { type: 'LIST', list: [{ type: 'TEMPLATE', value: 'ad_storage' }] },
  },
  firingTriggerId: [String(i + 1)],
}));

const container = {
  exportFormatVersion: 2,
  exportTime: '2026-09-20 00:00:00',
  containerVersion: {
    path: 'accounts/0/containers/0/versions/0',
    accountId: '0', containerId: '0', containerVersionId: '0',
    name: 'Meta pixel conversions (import)',
    container: { accountId: '0', containerId: '0', name: 'ceylonhop', publicId: 'GTM-NL6K22CM', usageContext: ['WEB'] },
    variable: variables, trigger: triggers, tag: tags,
  },
};

const json = JSON.stringify(container, null, 2) + '\n';
const out = process.argv[2];
if (out) { writeFileSync(out, json); console.error(`wrote ${out}: ${tags.length} tags, ${triggers.length} triggers, ${variables.length} variable`); }
else process.stdout.write(json);

export { EVENTS, PIXEL_ID, container };
