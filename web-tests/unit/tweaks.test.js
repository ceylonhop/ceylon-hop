// web-tests/unit/tweaks.test.js
// The tweaks applier repaints brand tokens from a persisted localStorage experiment. Two
// properties matter enough to guard: a retired palette entry must never be applicable again
// (a persisted teal kept repainting pre-rebrand colours over shipped fixes), and the key is
// versioned with the old generation cleaned up, so stale overrides die instead of silently
// outliving every sweep.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.resolve(__dirname, '../../tweaks.js'), 'utf8');

const KEY = 'ceylonhop_tweaks_v2';
const OLD_KEY = 'ceylonhop_tweaks';
const rootVar = (name) => document.documentElement.style.getPropertyValue(name);

function run() {
  // eslint-disable-next-line no-new-func
  new Function(src)();
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('style');
  document.documentElement.className = '';
});

describe('tweaks applier', () => {
  it('applies a persisted accent from the current palette', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ accent: 'saffron' }));
    run();
    expect(rootVar('--accent')).toBe('#F9A429');
    expect(rootVar('--accent-deep')).toBe('#a96b04');
  });

  it('ignores the retired teal accent — a stale experiment cannot repaint pre-rebrand colours', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ accent: 'teal', cta: 'teal' }));
    run();
    expect(rootVar('--accent')).toBe('');
    expect(rootVar('--accent-deep')).toBe('');
    expect(rootVar('--cta')).toBe('');
  });

  it('does not apply the old unversioned key, and removes it', () => {
    window.localStorage.setItem(OLD_KEY, JSON.stringify({ accent: 'blue' }));
    run();
    expect(rootVar('--accent')).toBe('');
    expect(window.localStorage.getItem(OLD_KEY)).toBeNull();
  });

  it('saves to the versioned key', () => {
    run();
    window.__tweaks.save({ cta: 'ink' });
    expect(window.localStorage.getItem(KEY)).toBe('{"cta":"ink"}');
    expect(window.localStorage.getItem(OLD_KEY)).toBeNull();
  });

  it('still marks the document as js-capable when storage is empty', () => {
    run();
    expect(document.documentElement.classList.contains('js')).toBe(true);
  });
});
