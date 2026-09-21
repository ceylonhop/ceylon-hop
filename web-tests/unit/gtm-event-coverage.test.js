// web-tests/unit/gtm-event-coverage.test.js
// An event the site pushes but no GTM tag listens for is silently discarded, and GA4 does not
// backfill — so the loss is permanent and invisible. Audited against the published container
// on 2026-09-20: 31 events emitted, 21 with no tag, including `contact_whatsapp` (the
// conversion for a WhatsApp-first business) and every payment-failure event.
//
// This test does not read the live container (a unit test must not depend on the network).
// It pins the two things that drift in the repo: the generated import file must cover every
// event we intend to tag, and any NEW event added to the site must be consciously classified
// as tagged or deliberately untagged, rather than quietly joining the discarded pile.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENTS } from '../../tools/analytics/build-gtm-missing-tags.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP = new Set(['api', 'docs', 'tools', 'web-tests', 'img', 'node_modules', '.git', '.github', '.claude']);

/** Events already covered by tags in the LIVE container, verified 2026-09-20. */
const ALREADY_LIVE = new Set([
  'search', 'view_item_list', 'select_item', 'begin_checkout', 'checkout_step',
  'add_payment_info', 'purchase', 'view_item', 'exception',
]);
/** Deliberately never a GA4 event — it labels the session, it is not a thing that happened. */
const DELIBERATELY_UNTAGGED = new Set(['ch_context']);

function siteFiles(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || (dir === ROOT && SKIP.has(entry))) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) siteFiles(full, out);
    else if (/\.(js|html)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every event name the site pushes, from chTrack(…) / track(…) / ev(…) call sites. */
function emittedEvents() {
  const found = new Set();
  for (const f of siteFiles()) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:chTrack|[^A-Za-z]track|\bev)\(\s*'([a-z_]+)'/g)) found.add(m[1]);
  }
  return found;
}

const planned = new Set(EVENTS.map((e) => e.name));

describe('GTM import covers the events the site emits', () => {
  it('finds the call sites at all — a rename must not make this vacuous', () => {
    const e = emittedEvents();
    expect(e.size).toBeGreaterThan(20);
    expect(e.has('purchase'), 'purchase should be among the emitted events').toBe(true);
  });

  it('classifies every emitted event: live, planned, or deliberately untagged', () => {
    const orphans = [...emittedEvents()]
      .filter((e) => !ALREADY_LIVE.has(e) && !planned.has(e) && !DELIBERATELY_UNTAGGED.has(e));
    expect(orphans, `these events would be discarded — add a tag in tools/analytics/build-gtm-missing-tags.mjs, or list them as deliberately untagged`)
      .toEqual([]);
  });

  it('plans no tag for an event the site never emits', () => {
    const emitted = emittedEvents();
    expect([...planned].filter((p) => !emitted.has(p)), 'tag planned for a non-existent event').toEqual([]);
  });

  it('does not re-tag something the live container already handles', () => {
    expect([...planned].filter((p) => ALREADY_LIVE.has(p)), 'would create a duplicate tag').toEqual([]);
  });

  it('gives every planned tag a reason and real params', () => {
    for (const e of EVENTS) {
      expect(e.why, `${e.name} needs a why`).toBeTruthy();
      expect(Array.isArray(e.params), `${e.name} params`).toBe(true);
    }
  });

  it('keeps the committed import file in step with the generator', () => {
    const file = JSON.parse(readFileSync(path.join(ROOT, 'docs/analytics/gtm-missing-tags.json'), 'utf8'));
    const tagged = file.containerVersion.tag.map((t) => t.parameter.find((p) => p.key === 'eventName').value);
    expect(tagged.sort(), 'regenerate: node tools/analytics/build-gtm-missing-tags.mjs docs/analytics/gtm-missing-tags.json')
      .toEqual([...planned].sort());
    for (const t of file.containerVersion.tag) {
      expect(t.firingTriggerId, `${t.name} must fire on exactly one trigger`).toHaveLength(1);
      expect(t.consentSettings.consentStatus, `${t.name} must require consent`).toBe('NEEDED');
    }
  });
});
