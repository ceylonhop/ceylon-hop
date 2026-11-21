import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');

// Why this file exists (owner, 2026-11-18): CH-H9L3S was paid at 08:23 and was not in the
// Bookings list of an ops tab that had been open since earlier that morning. The list was only
// fetched at boot and on entering the Bookings route, so an agent who stays on Bookings never
// saw a new booking until a reload. The page now refetches on a timer and when the tab comes
// back into view. These guard the rule for WHEN that background refetch may repaint the page,
// evaluated from the real page source so the rule cannot drift from this file.
function extractConst(name) {
  const start = html.indexOf(`const ${name}=`);
  if (start < 0) throw new Error(`const ${name} not found in ops-ui.html`);
  const open = html.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}') depth--;
    if (depth === 0) break;
  }
  return html.slice(html.indexOf('=', start) + 1, i + 1);
}

const canAutoRefresh = () => new Function(`return (${extractConst('canAutoRefresh')});`)();
const onBookings = { route: 'tickets', detail: null };
const doc = (over = {}) => ({ hidden: false, activeElement: { tagName: 'BODY', id: '' }, ...over });

describe('ops Bookings auto-refresh', () => {
  it('refreshes an idle Bookings list', () => {
    expect(canAutoRefresh()(onBookings, doc())).toBe(true);
  });

  it('refreshes while the search box has focus — Bookings focuses it on entry', () => {
    expect(canAutoRefresh()(onBookings, doc({ activeElement: { tagName: 'INPUT', id: 'q' } }))).toBe(true);
  });

  it('does not fetch for a tab nobody is looking at', () => {
    expect(canAutoRefresh()(onBookings, doc({ hidden: true }))).toBe(false);
  });

  it('leaves an open booking alone — a repaint would wipe a half-typed form', () => {
    expect(canAutoRefresh()({ route: 'tickets', detail: 'b1' }, doc())).toBe(false);
  });

  it('stays off every other page — they refetch bookings on the way back in', () => {
    for (const route of ['quote', 'quotes', 'analytics', 'health', 'lookup', 'rates', 'experiences']) {
      expect(canAutoRefresh()({ route, detail: null }, doc())).toBe(false);
    }
  });

  it('waits while a filter dropdown or another field is in use', () => {
    for (const tagName of ['SELECT', 'INPUT', 'TEXTAREA']) {
      expect(canAutoRefresh()(onBookings, doc({ activeElement: { tagName, id: 'chansel' } }))).toBe(false);
    }
  });

  it('is wired to a timer and to the tab coming back into view', () => {
    expect(html).toMatch(/setInterval\(autoRefreshQueue,QUEUE_REFRESH_MS\)/);
    expect(html).toMatch(/addEventListener\('visibilitychange',autoRefreshQueue\)/);
  });
});
