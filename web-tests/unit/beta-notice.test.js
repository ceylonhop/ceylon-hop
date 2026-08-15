// web-tests/unit/beta-notice.test.js
// The first-visit beta notice. It is the first thing a visitor arriving from the old site sees,
// so the bar is: it must appear once, go away for good when dismissed, and never be able to trap
// someone on the page — including when localStorage throws, which is Safari private mode.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.resolve(__dirname, '../../beta-notice.js'), 'utf8');

const KEY = 'ceylonhop_beta_notice_v2';
/** Execute the browser IIFE against this jsdom window, the way a <script> tag would. */
function run() {
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'localStorage', src)(window, document, window.localStorage);
}
const notice = () => document.querySelector('.ch-beta');
const button = () => document.querySelector('.ch-beta button');

beforeEach(() => {
  document.body.innerHTML = '';
  window.localStorage.clear();
});

describe('beta notice', () => {
  it('shows on a first visit', () => {
    run();
    expect(notice()).not.toBeNull();
  });

  it('does not show again once dismissed', () => {
    window.localStorage.setItem(KEY, 'dismissed');
    run();
    expect(notice()).toBeNull();
  });

  it('remembers the dismissal across visits', () => {
    run();
    button().click();
    expect(notice()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBe('dismissed');

    document.body.innerHTML = '';
    run(); // the next page load
    expect(notice()).toBeNull();
  });

  // The key is versioned so a redesigned notice can reach people who dismissed an earlier
  // generation — the unversioned key made the first dismissal permanent (#440 never rendered
  // for anyone who clicked through the original notice).
  it('shows again for a browser that only dismissed the old unversioned notice, and clears that key', () => {
    window.localStorage.setItem('ceylonhop_beta_notice', 'dismissed');
    run();
    expect(notice()).not.toBeNull();
    expect(window.localStorage.getItem('ceylonhop_beta_notice')).toBeNull();
  });

  it('announces itself as a dialog with a name', () => {
    run();
    const el = notice();
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('true');
    // Named by its own heading rather than a hardcoded aria-label, so the name can never drift
    // from what is on screen.
    const labelledBy = el.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy)?.textContent?.trim()).toBeTruthy();
  });

  it('moves focus to the dismiss button so a keyboard user is not stranded behind it', () => {
    run();
    expect(document.activeElement).toBe(button());
  });

  it('closes on Escape', () => {
    run();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(notice()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBe('dismissed');
  });

  // Safari private mode throws on setItem, and older WebKit threw on getItem too. A notice that
  // cannot be dismissed is worse than no notice at all: it would cover the site for good.
  it('still shows and still dismisses when localStorage throws', () => {
    const boom = () => { throw new Error('SecurityError'); };
    const store = window.localStorage;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem: boom, setItem: boom, removeItem: boom, clear: boom },
    });
    try {
      expect(() => run()).not.toThrow();
      expect(notice()).not.toBeNull();
      expect(() => button().click()).not.toThrow();
      expect(notice()).toBeNull();
    } finally {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: store });
    }
  });

  it('leaves the page scrollable again after it closes', () => {
    run();
    button().click();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  // iOS Safari ignores body{overflow:hidden} for touch scrolling, so the page kept moving
  // under the sheet (owner-reported 2026-08-15). The reliable lock is position:fixed on the
  // body, offset by the scroll position so the page doesn't visually jump to the top.
  describe('scroll lock that also holds on iOS', () => {
    let scrollTo;
    beforeEach(() => {
      scrollTo = window.scrollTo;
      window.scrollTo = () => {};
    });
    afterEach(() => { window.scrollTo = scrollTo; });

    it('pins the body with position:fixed while open, offset by the scroll position', () => {
      Object.defineProperty(window, 'pageYOffset', { configurable: true, value: 480 });
      try {
        run();
        expect(document.body.style.position).toBe('fixed');
        expect(document.body.style.top).toBe('-480px');
        expect(document.body.style.width).toBe('100%');
      } finally {
        Object.defineProperty(window, 'pageYOffset', { configurable: true, value: 0 });
      }
    });

    it('unpins the body and returns to the same scroll position on dismiss', () => {
      Object.defineProperty(window, 'pageYOffset', { configurable: true, value: 480 });
      const calls = [];
      window.scrollTo = (...a) => calls.push(a);
      try {
        run();
        button().click();
        expect(document.body.style.position).toBe('');
        expect(document.body.style.top).toBe('');
        expect(calls).toContainEqual([0, 480]);
      } finally {
        Object.defineProperty(window, 'pageYOffset', { configurable: true, value: 0 });
      }
    });
  });
});
