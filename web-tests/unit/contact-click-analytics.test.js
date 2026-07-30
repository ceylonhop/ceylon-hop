import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ────────────────────────────────────────────────────────────────────────────
//  Outbound WhatsApp contact tracking (2026-07-30).
//
//  `wa.me/94779669662` links sit on 12+ pages and fired nothing, so the single
//  most common way a traveller actually reaches us looked like a bounce in GA4.
//  One delegated listener in analytics.js covers every link, including markup
//  rendered later by search.js / plan.js / booking.js.
//
//  The trap this pins: board.js also builds `wa.me/?text=…` links with NO phone
//  number — those are the traveller SHARING a van with a friend, not contacting
//  us. Counting them as contacts would inflate the metric with the board's own
//  virality loop.
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const src = readFileSync(path.join(ROOT, 'analytics.js'), 'utf8');

const CONTACT = 'https://wa.me/94779669662';
const SHARE = 'https://wa.me/?text=shared%20van';

function loadAnalytics() {
  document.body.innerHTML = '';
  window.dataLayer = [];
  // eslint-disable-next-line no-new-func
  new Function(src)();
}

function clickLink(html) {
  document.body.innerHTML = html;
  const el = document.getElementById('target') || document.querySelector('a');
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return window.dataLayer.filter((e) => e.event === 'contact_whatsapp');
}

beforeEach(loadAnalytics);

describe('WhatsApp contact links are tracked', () => {
  it('fires contact_whatsapp when a link to our number is clicked', () => {
    const hits = clickLink(`<a id="target" href="${CONTACT}">WhatsApp us</a>`);
    expect(hits).toHaveLength(1);
  });

  it('fires when the click lands on an icon INSIDE the link, not the anchor', () => {
    // Every real CTA on the site wraps an svg/span — an anchor-only listener
    // would miss the majority of real clicks.
    const hits = clickLink(`<a href="${CONTACT}"><svg id="target"></svg> Ask us</a>`);
    expect(hits).toHaveLength(1);
  });

  it('still fires when the link already carries a prefilled ?text=', () => {
    const hits = clickLink(`<a id="target" href="${CONTACT}?text=Hi%20there">Ask</a>`);
    expect(hits).toHaveLength(1);
  });
});

describe('share links are not miscounted as contacts', () => {
  it('ignores a phone-less wa.me share link (board.js "share this van")', () => {
    expect(clickLink(`<a id="target" href="${SHARE}">Share</a>`)).toHaveLength(0);
  });

  it('ignores ordinary internal links', () => {
    expect(clickLink('<a id="target" href="/plan.html">Plan a trip</a>')).toHaveLength(0);
  });

  it('ignores a lookalike host that merely contains wa.me', () => {
    expect(clickLink('<a id="target" href="https://evil-wa.me.example.com/9477">x</a>')).toHaveLength(0);
  });
});

describe('the event carries useful, non-personal params', () => {
  it('reports which page and which button the contact came from', () => {
    const [hit] = clickLink(`<a id="target" href="${CONTACT}">Ask</a>`);
    expect(hit.link_id).toBe('target');
    expect(hit.page).toBe(window.location.pathname);
    expect(hit.method).toBe('whatsapp');
  });

  it('tolerates a link with no id rather than dropping the event', () => {
    const [hit] = clickLink(`<a href="${CONTACT}">Ask</a>`);
    expect(hit).toBeTruthy();
    expect(hit.link_id).toBe('');
  });

  it('never puts the phone number or raw href in the payload', () => {
    const [hit] = clickLink(`<a id="target" href="${CONTACT}?text=Hi">Ask</a>`);
    expect(JSON.stringify(hit)).not.toContain('94779669662');
    expect(JSON.stringify(hit)).not.toContain('wa.me');
  });
});

describe('analytics must never break the page', () => {
  it('does not preventDefault — the link must still open WhatsApp', () => {
    document.body.innerHTML = `<a id="target" href="${CONTACT}">Ask</a>`;
    const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('target').dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('counts one contact per click even if analytics.js is included twice', () => {
    // Two <script src="analytics.js"> tags would otherwise double every
    // contact in GA4 — silently, and only on the page that regressed.
    loadAnalytics();
    loadAnalytics();
    expect(clickLink(`<a id="target" href="${CONTACT}">Ask</a>`)).toHaveLength(1);
  });

  it('swallows a hostile dataLayer instead of throwing on click', () => {
    window.dataLayer = { push() { throw new Error('boom'); } };
    document.body.innerHTML = `<a id="target" href="${CONTACT}">Ask</a>`;
    expect(() => document.getElementById('target').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true }),
    )).not.toThrow();
  });
});

describe("search.js's programmatic 6+ pax handoff", () => {
  it('tracks the group-quote WhatsApp redirect, which no click listener can see', () => {
    // search.js sets location.href directly, so the delegated listener never
    // runs. This is the highest-intent contact on the site — it needs its own
    // explicit call or it stays invisible.
    const searchSrc = readFileSync(path.join(ROOT, 'search.js'), 'utf8');
    expect(searchSrc).toMatch(/chTrack\(\s*'contact_whatsapp'/);
  });
});
