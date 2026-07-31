import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../app';

// Dark-mode contrast contract. The ops shell's dark theme INVERTS its text tokens
// (--ink / --black go from near-black to near-white). Anything that used one of those as a
// BACKGROUND therefore flipped to a near-white panel while its hardcoded `color: #fff` text
// stayed white — the toasts were unreadable in dark mode (reported 2026-07-31).
//
// The rule this suite defends: a surface is never expressed as a text token.

let body = '';
beforeAll(async () => { body = await (await createApp().request('/ops')).text(); });

/** The CSS declarations inside the ops shell's <style> blocks. */
function css(): string {
  return body.match(/<style>([\s\S]*?)<\/style>/g)?.join('\n') ?? '';
}

describe('dark theme: surfaces are never text tokens', () => {
  it('nothing paints a background with --ink or --black', () => {
    // Both are redefined light→dark by :root[data-theme="dark"], so using either as a
    // background is a guaranteed inversion bug. Use --pop-bg (defined per theme) instead.
    const offenders = css().match(/background(-color)?:\s*var\(--(ink|black)\)/g) ?? [];
    expect(offenders, `use var(--pop-bg) instead: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the overlay token is defined in BOTH themes, so neither can inherit the other', () => {
    // Light scope (ops shell + .qv), then the two dark overrides.
    expect(css()).toContain('--pop-bg:#241f1d');       // ops light
    expect(css()).toContain('--pop-bg: #241f1d');      // .qv light
    const darkDefs = css().match(/--pop-bg:#33302c/g) ?? [];
    expect(darkDefs.length, 'dark must define --pop-bg for the root AND the .qv scope').toBe(2);
  });

  it('both toasts consume the overlay token rather than a hardcoded white', () => {
    // The ops dashboard toast and the quote builder toast are separate elements with
    // separate rules; the bug hit both, so both are pinned.
    expect(css()).toMatch(/\.toast\{[^}]*background:var\(--pop-bg\);color:var\(--pop-fg\)/);
    expect(css()).toMatch(/\.qv \.ch-toast \{[^}]*background: var\(--pop-bg\); color: var\(--pop-fg\)/);
  });

  it('the dark overlay is a LIFTED surface, not an inverted one', () => {
    // Every --pop-bg the dark theme declares must still be a DARK colour: a toast should
    // read as floating above the page, not as a near-white flashbang over a dark ops
    // screen at night. Checked over every declaration that isn't one of the two light ones.
    const all = [...css().matchAll(/--pop-bg:\s*#([0-9a-f]{6})/gi)].map((m) => m[1].toLowerCase());
    expect(all.length).toBeGreaterThanOrEqual(4); // 2 light + 2 dark
    const dark = all.filter((hex) => hex !== '241f1d');
    expect(dark.length, 'expected exactly two dark-theme declarations').toBe(2);
    for (const hex of dark) {
      const channels = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
      // Lifted above --surface (#262523) but nowhere near the inverted #eceae5 that broke it.
      expect(Math.max(...channels), `--pop-bg #${hex} is too light for a dark overlay`).toBeLessThan(0x80);
      expect(Math.max(...channels)).toBeGreaterThan(0x26);
    }
  });
});
