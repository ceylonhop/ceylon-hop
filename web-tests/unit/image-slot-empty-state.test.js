import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// <image-slot> shows an authoring placeholder ("Drop a photo — …", "Photo of Dinesh P.") when it
// has no image. Only 4 of ~30 slots on the site are filled, so on a live page that authoring text
// was reaching real visitors — including the footer band on every page. Authors still need it.

const src = readFileSync(join(__dirname, '..', '..', 'image-slot.js'), 'utf8');

const PLACEHOLDER = 'Photo of Dinesh P.';

beforeAll(() => {
  if (!window.ResizeObserver) {
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
  new Function(src)();
});

afterEach(() => {
  delete window.omelette;
  document.body.innerHTML = '';
});

function mount() {
  const el = document.createElement('image-slot');
  el.setAttribute('placeholder', PLACEHOLDER);
  document.body.appendChild(el);
  return el;
}

describe('image-slot empty state', () => {
  it('does not put the authoring placeholder in the DOM for a visitor', () => {
    const el = mount();
    expect(el.shadowRoot).toBeTruthy();
    expect(el.hasAttribute('data-editable')).toBe(false);
    // Not merely hidden with CSS — absent, so it can't be read by a screen reader or view-source.
    expect(el.shadowRoot.textContent).not.toContain(PLACEHOLDER);
    expect(el.shadowRoot.textContent).not.toContain('Drop an image');
  });

  it('still shows the placeholder to an author', () => {
    window.omelette = { writeFile() {} };
    const el = mount();
    expect(el.hasAttribute('data-editable')).toBe(true);
    expect(el.shadowRoot.textContent).toContain(PLACEHOLDER);
  });

  it('does not open a file picker when a visitor clicks an unfilled slot', () => {
    const el = mount();
    let opened = false;
    el.shadowRoot.querySelector('input[type=file]').click = () => { opened = true; };
    el.shadowRoot.querySelector('.empty').dispatchEvent(new window.Event('click'));
    expect(opened).toBe(false);
  });

  it('opens the file picker for an author', () => {
    window.omelette = { writeFile() {} };
    const el = mount();
    let opened = false;
    el.shadowRoot.querySelector('input[type=file]').click = () => { opened = true; };
    el.shadowRoot.querySelector('.empty').dispatchEvent(new window.Event('click'));
    expect(opened).toBe(true);
  });
});
