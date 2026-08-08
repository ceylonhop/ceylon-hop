import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');

// Bulk close-out (2026-08-07). The team's "Needs closing" pile is cleared a tick at a time, so
// the queue grew a multi-select. These assert the SAFETY properties of that control, which are
// the ones that would cost real money or goodwill if they regressed.
describe('bulk close-out', () => {
  it('offers Completed only — a bulk no-show would email every one of those customers', () => {
    const handler = html.slice(html.indexOf("case 'closedone'"), html.indexOf("case 'advance'"));
    expect(handler).toContain("{to:'completed'}");
    expect(handler).not.toContain('no_show');
  });

  it('confirms before writing, and says what the action is NOT for', () => {
    const handler = html.slice(html.indexOf("case 'closedone'"), html.indexOf("case 'advance'"));
    expect(handler).toContain('confirm(');
    expect(handler).toMatch(/no-show must be marked one at a time/i);
  });

  it('posts one booking at a time to the same audited endpoint a single Complete uses', () => {
    const handler = html.slice(html.indexOf("case 'closedone'"), html.indexOf("case 'advance'"));
    expect(handler).toMatch(/for\s*\(\s*const bid of ids\s*\)/); // sequential, not Promise.all
    expect(handler).not.toContain('Promise.all');
    expect(handler).toContain('/status');
  });

  it('stops on the first failure and keeps the rest ticked so a retry resumes', () => {
    const handler = html.slice(html.indexOf("case 'closedone'"), html.indexOf("case 'advance'"));
    expect(handler).toContain('break;');
    expect(handler).toMatch(/press again to resume/i);
  });

  it('only ever actions rows that are still in Needs closing', () => {
    const handler = html.slice(html.indexOf("case 'closedone'"), html.indexOf("case 'advance'"));
    expect(handler).toContain("dayGroup(x)==='Needs closing'");
  });

  it('goes through the MUTATES guard like every other write', () => {
    expect(html).toMatch(/const MUTATES=\['closedone'/);
  });
});
