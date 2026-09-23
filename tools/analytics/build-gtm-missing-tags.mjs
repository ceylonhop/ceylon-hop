// tools/analytics/build-gtm-missing-tags.mjs
// Emit a GTM container JSON for the events the SITE ALREADY PUSHES but the live container has
// no tag for. Audited against the published container (gtm.js?id=GTM-NL6K22CM) on 2026-09-20:
// the code emits 31 events, 21 of which reach dataLayer and are discarded.
//
// GA4 DOES NOT BACKFILL. Every day one of these is untagged is a day of data that cannot be
// recovered, which is why this exists as an importable file rather than a list of 21 tags to
// build by hand in the UI.
//
// Format mirrors docs/analytics/gtm-ride-board-funnel.json, which imported cleanly — same
// exportFormatVersion, same `gaawe` tag type, same placeholder account/container ids (GTM
// rewrites those on import), same consent gating.
//
// Run:  node tools/analytics/build-gtm-missing-tags.mjs > docs/analytics/gtm-missing-tags.json
import { writeFileSync } from 'node:fs';

const MEASUREMENT_ID = 'G-XEW62ZD7B3';

/* Each entry: the event name, the params the code actually passes, and why it is worth a tag.
   Params were read off the call sites, not guessed — `withMoney()` on the pay page merges
   {value, currency} into whatever else is passed, so those appear on its events. */
const EVENTS = [
  // ---- the conversion this business actually runs on -------------------------------------
  { name: 'contact_whatsapp', params: ['method', 'link_id', 'page'], key: true,
    why: 'WhatsApp is how most customers reach us. Without this the main conversion is invisible.' },

  // ---- the payment funnel's missing middle ------------------------------------------------
  { name: 'payment_initiated', params: ['payment_type', 'value', 'currency'],
    why: 'The step between begin_checkout and purchase. Without it you cannot see where checkout leaks.' },
  { name: 'payment_failed', params: ['payment_type', 'value', 'currency'],
    why: 'A customer tried to pay and could not. The single most actionable failure on the site.' },
  { name: 'payment_dismissed', params: ['payment_type', 'value', 'currency'],
    why: 'Customer closed the payment overlay — hesitation, not an error.' },
  { name: 'payment_start_failed', params: ['reason'],
    why: 'Checkout could not even be started; `reason` carries the message.' },
  { name: 'payment_unconfirmed', params: ['leg', 'tries', 'reason', 'value', 'currency'],
    why: 'Paid but we never confirmed — the case where a customer is charged and left unsure.' },

  // ---- the ops-quoted sales channel, entirely dark today ----------------------------------
  { name: 'pay_link_opened', params: ['state', 'value', 'currency'],
    why: 'A pay link you sent was opened. The only measure of that channel working.' },
  { name: 'pay_form_invalid', params: ['reason', 'value', 'currency'],
    why: 'The pay page rejected the form before PayHere saw it.' },
  { name: 'quote_link_opened', params: ['state'],
    why: 'A customer opened a quote you sent on WhatsApp.' },
  { name: 'quote_lapsed_shown', params: ['item_list_id'],
    why: 'They opened it after it expired — you are losing sales to the 7-day window.' },
  { name: 'manage_opened', params: ['status', 'has_balance', 'value', 'currency'],
    why: 'Customer opened their booking. `has_balance` flags who still owes money.' },
  { name: 'manage_link_invalid', params: ['reason'],
    why: 'A manage link failed to open — a broken link in a real confirmation email.' },

  // ---- ride board ------------------------------------------------------------------------
  { name: 'login', params: [],
    why: 'Google sign-in on the ride board; the gate every join must pass.' },
  { name: 'scratch_ride', params: ['item_list_id'],
    why: 'A traveller withdrew from a list — the board\'s churn signal.' },
  { name: 'ride_board_refused', params: ['item_list_id', 'flow', 'item_id', 'reason', 'http_status'],
    why: 'The board turned a traveller away (list closed, van full, date too soon). `reason` is the API error code.' },
  { name: 'ride_board_payment_failed', params: ['item_list_id', 'reason'],
    why: 'A card approval for a board seat did not complete — cancelled, expired, or still pending.' },

  // ---- pricing behaviour -------------------------------------------------------------------
  { name: 'reprice_shown', params: ['extra_km'],
    why: 'We told the customer the price moved. Pair with reprice_accepted for the accept rate.' },
  { name: 'reprice_accepted', params: ['extra_km', 'new_value'],
    why: 'They accepted the new price. The other half of the reprice rate.' },
  { name: 'route_estimate_update', params: ['surface', 'estimate_state', 'material', 'route_fingerprint'],
    why: 'A live estimate replaced a catalogue one. Tells you if the engine is answering in time.' },
  { name: 'route_estimate_unavailable', params: ['surface', 'reason'],
    why: 'The engine did not answer and the customer saw a fallback price.' },

  // ---- location quality ---------------------------------------------------------------------
  { name: 'exact_location_deferred', params: ['which'],
    why: 'Customer skipped giving an exact pickup/drop — a driver-side problem later.' },
  { name: 'exact_location_out_of_range', params: ['which', 'km'],
    why: 'The pin was outside the serviceable radius; `km` sizes the demand you are refusing.' },
];

/* ch_context is deliberately NOT tagged. It carries ch_property / ch_env to label which
   property a session is on, and is meant to feed variables — turning it into its own GA4
   event would add one hit per page view and measure nothing. */

const dlv = (n) => `DLV - ${n}`;
const base = { accountId: '0', containerId: '0' };
const allParams = [...new Set(EVENTS.flatMap((e) => e.params))].sort();

const variables = allParams.map((p, i) => ({
  ...base, variableId: String(i + 1), name: dlv(p), type: 'v',
  parameter: [
    { type: 'INTEGER', key: 'dataLayerVersion', value: '2' },
    { type: 'BOOLEAN', key: 'setDefaultValue', value: 'false' },
    { type: 'TEMPLATE', key: 'name', value: p },
  ],
}));

const triggers = EVENTS.map((e, i) => ({
  ...base, triggerId: String(i + 1), name: `CE - ${e.name}`, type: 'CUSTOM_EVENT',
  customEventFilter: [{
    type: 'EQUALS',
    parameter: [
      { type: 'TEMPLATE', key: 'arg0', value: '{{_event}}' },
      { type: 'TEMPLATE', key: 'arg1', value: e.name },
    ],
  }],
}));

const tags = EVENTS.map((e, i) => ({
  ...base, tagId: String(i + 1), name: `GA4 - ${e.name}`, type: 'gaawe',
  notes: e.why,
  parameter: [
    { type: 'BOOLEAN', key: 'sendEcommerceData', value: 'false' },
    { type: 'TEMPLATE', key: 'eventName', value: e.name },
    ...(e.params.length ? [{
      type: 'LIST', key: 'eventSettingsTable',
      list: e.params.map((p) => ({
        type: 'MAP',
        map: [
          { type: 'TEMPLATE', key: 'parameter', value: p },
          { type: 'TEMPLATE', key: 'parameterValue', value: `{{${dlv(p)}}}` },
        ],
      })),
    }] : []),
    { type: 'TEMPLATE', key: 'measurementIdOverride', value: MEASUREMENT_ID },
  ],
  // Same gating the ride-board import used: these are analytics, not advertising.
  consentSettings: {
    consentStatus: 'NEEDED',
    consentType: { type: 'LIST', list: [{ type: 'TEMPLATE', value: 'analytics_storage' }] },
  },
  firingTriggerId: [String(i + 1)],
}));

const container = {
  exportFormatVersion: 2,
  exportTime: '2026-09-20 00:00:00',
  containerVersion: {
    path: 'accounts/0/containers/0/versions/0',
    accountId: '0', containerId: '0', containerVersionId: '0',
    name: 'Missing event tags (import)',
    container: { accountId: '0', containerId: '0', name: 'ceylonhop', publicId: 'GTM-NL6K22CM', usageContext: ['WEB'] },
    variable: variables, trigger: triggers, tag: tags,
  },
};

const json = JSON.stringify(container, null, 2) + '\n';
const out = process.argv[2];
if (out) { writeFileSync(out, json); console.error(`wrote ${out}: ${tags.length} tags, ${triggers.length} triggers, ${variables.length} variables`); }
else process.stdout.write(json);

export { EVENTS, container };
