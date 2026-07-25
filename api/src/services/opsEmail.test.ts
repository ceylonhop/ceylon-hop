import { describe, it, expect } from 'vitest';
import { opsEmailShell, ctaBlock, heroRef, money } from './opsEmail';

describe('opsEmail', () => {
  it('shell wraps body with eyebrow + footer in html and text', () => {
    const { html, text } = opsEmailShell('<p>hi</p>', 'hi');
    expect(html).toContain('Ceylon Hop ops');
    expect(html).toContain('<p>hi</p>');
    expect(html).toContain("You're on the Ceylon Hop ops team.");
    expect(text).toContain('CEYLON HOP OPS');
    expect(text).toContain('hi');
  });

  it('ctaBlock renders a button with a link and a fallback line without one', () => {
    expect(ctaBlock('Open', 'https://x/ops?quote=1', 'Open from the tab')).toContain('href="https://x/ops?quote=1"');
    const none = ctaBlock('Open', '', 'Open from the tab');
    expect(none).not.toContain('href');
    expect(none).toContain('Open from the tab');
  });

  it('money formats USD and other currencies; heroRef escapes', () => {
    expect(money(66900, 'USD')).toBe('$669.00');
    expect(money(5000, 'LKR')).toBe('LKR 50.00');
    expect(heroRef('Q-<b>')).toContain('Q-&lt;b&gt;');
  });
});
