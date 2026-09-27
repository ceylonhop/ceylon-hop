import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* route-choice.js is the shared "two roads" popup (search now, plan next). It is a classic
   script that hangs CH_ROUTE_CHOICE off window, so it runs here against jsdom's window the same
   way ch-map.js does in ch-map-route-memo.test.js. Re-run per test for a fresh closure. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, '..', '..', 'route-choice.js'), 'utf8');
function load() {
  // eslint-disable-next-line no-new-func
  new Function(src)();
  return window.CH_ROUTE_CHOICE;
}

const opts = (over = {}) => Object.assign({
  title: 'Two roads to Ella',
  sub: "The local road skips the expressway tolls. It's slower, but cheaper. Pick one and you can switch later.",
  fastest: { time: '5h', km: '335 km', price: '$140', extra: 'van $189' },
  local: { time: '6h 14m', slower: '+1h 15m', km: '213 km', price: '$91', extra: 'van $123', save: 'Save $49' },
  selected: 'fastest',
  onPick: vi.fn(),
  onDismiss: vi.fn(),
}, over);

const dialogs = () => document.querySelectorAll('[role="dialog"]');
const primary = () => document.querySelector('.ch-rc-primary');

describe('CH_ROUTE_CHOICE.open', () => {
  let RC, opener;
  beforeEach(() => {
    document.body.innerHTML = '<button id="opener">open</button>';
    document.body.style.overflow = 'scroll';
    document.head.querySelectorAll('#ch-rc-style').forEach((n) => n.remove());
    RC = load();
    opener = document.getElementById('opener');
    opener.focus();
  });
  afterEach(() => { document.body.innerHTML = ''; });

  it('renders a labelled modal dialog with both roads, the expressway pre-selected', () => {
    RC.open(opts());
    const d = dialogs();
    expect(d).toHaveLength(1);
    expect(d[0].getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(d[0].getAttribute('aria-labelledby'));
    expect(title.textContent).toBe('Two roads to Ella');
    expect(d[0].textContent).toContain('$140');
    expect(d[0].textContent).toContain('$91');
    expect(d[0].textContent).toContain('Save $49');
    expect(d[0].textContent).toContain('Fastest');
    expect(d[0].textContent).toContain('335 km · tolls included · van $189');
    expect(d[0].textContent).toContain('213 km · no tolls · van $123');
    expect(d[0].textContent).toContain('Best for a flight or a tight schedule');
    expect(d[0].textContent).toContain("Best if you'd rather pay less");
    const checked = document.querySelector('input[name="ch-rc-road"]:checked');
    expect(checked.value).toBe('fastest');
    expect(document.activeElement).toBe(checked);
    expect(primary().textContent).toBe('Use expressway');
    expect(document.querySelector('[aria-label="Close"]')).toBeTruthy();
    expect(document.getElementById('ch-rc-style')).toBeTruthy();
    expect(document.body.style.overflow).toBe('hidden');
    expect(RC.isOpen()).toBe(true);
  });

  it('escapes place names rather than parsing them as markup', () => {
    RC.open(opts({ title: 'Two roads to <img src=x onerror=alert(1)>' }));
    expect(document.querySelector('[role="dialog"] img')).toBeNull();
    expect(document.querySelector('.ch-rc-title').textContent).toBe('Two roads to <img src=x onerror=alert(1)>');
  });

  it('picking the local road relabels the primary, and the primary reports it once and closes', () => {
    const o = opts();
    RC.open(o);
    const local = document.querySelector('input[name="ch-rc-road"][value="no_tolls"]');
    local.checked = true;
    local.dispatchEvent(new Event('change', { bubbles: true }));
    expect(primary().textContent).toBe('Use local road');
    primary().click();
    expect(o.onPick).toHaveBeenCalledTimes(1);
    expect(o.onPick).toHaveBeenCalledWith('no_tolls');
    expect(o.onDismiss).not.toHaveBeenCalled();
    expect(dialogs()).toHaveLength(0);
    expect(RC.isOpen()).toBe(false);
    expect(document.body.style.overflow).toBe('scroll');
    expect(document.activeElement).toBe(opener);
  });

  it('Escape dismisses once, closes, and hands focus back', () => {
    const o = opts();
    RC.open(o);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(o.onDismiss).toHaveBeenCalledTimes(1);
    expect(o.onPick).not.toHaveBeenCalled();
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe('scroll');
  });

  it("Escape stops at the popup: the page's own Escape handlers never see it", () => {
    const o = opts();
    const pageEsc = vi.fn();
    const onInput = vi.fn();
    window.addEventListener('keydown', pageEsc);
    opener.addEventListener('keydown', onInput);
    RC.open(o);
    const radio = document.querySelector('input[name="ch-rc-road"]:checked');
    radio.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(o.onDismiss).toHaveBeenCalledTimes(1);
    expect(pageEsc).not.toHaveBeenCalled();
    // once closed, the popup swallows nothing
    opener.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.removeEventListener('keydown', pageEsc);
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(pageEsc).toHaveBeenCalledTimes(1);
  });

  it('Decide later, the close button and the scrim all dismiss', () => {
    for (const hit of [
      () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Decide later').click(),
      () => document.querySelector('[aria-label="Close"]').click(),
      () => document.querySelector('.ch-rc-scrim').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    ]) {
      const o = opts();
      RC.open(o);
      hit();
      expect(o.onDismiss).toHaveBeenCalledTimes(1);
      expect(dialogs()).toHaveLength(0);
    }
  });

  it('opens with the local road checked when told so', () => {
    RC.open(opts({ selected: 'no_tolls' }));
    expect(document.querySelector('input[name="ch-rc-road"]:checked').value).toBe('no_tolls');
    expect(primary().textContent).toBe('Use local road');
  });

  it('never stacks: a second open while one is showing is ignored', () => {
    const first = opts(), second = opts({ title: 'Two roads to Kandy' });
    RC.open(first);
    RC.open(second);
    expect(dialogs()).toHaveLength(1);
    expect(document.querySelector('.ch-rc-title').textContent).toBe('Two roads to Ella');
  });
});

describe('CH_ROUTE_CHOICE once-per-tab memory', () => {
  let RC;
  beforeEach(() => { sessionStorage.clear(); RC = load(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('round-trips a pair through sessionStorage', () => {
    expect(RC.wasAsked('Colombo Airport (CMB)>Ella')).toBe(false);
    RC.markAsked('Colombo Airport (CMB)>Ella');
    expect(RC.wasAsked('Colombo Airport (CMB)>Ella')).toBe(true);
    expect(sessionStorage.getItem('chRoadAsked:Colombo Airport (CMB)>Ella')).toBeTruthy();
    expect(RC.wasAsked('Kandy>Ella')).toBe(false);
  });

  it('reads as not asked, and does not throw, when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => RC.markAsked('a>b')).not.toThrow();
    expect(RC.wasAsked('a>b')).toBe(false);
  });
});

describe('CH_ROUTE_CHOICE.fmtMinutes', () => {
  it('reads hours and minutes the way the route meta line does', () => {
    const RC = load();
    expect(RC.fmtMinutes(374)).toBe('6h 14m');
    expect(RC.fmtMinutes(300)).toBe('5h');
    expect(RC.fmtMinutes(45)).toBe('45 min');
  });
});
