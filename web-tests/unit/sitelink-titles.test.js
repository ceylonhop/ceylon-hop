import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from '../../tools/generate-route-pages.mjs';

// The five Google sitelinks the owner chose on 2026-09-25, in order. Google picks sitelinks
// itself and usually names one after the page's <title> or the anchor text pointing at it, so
// each title LEADS with the same words as its header link (static-chrome-crawlable.test.js pins
// the header). Read through JSDOM so "&amp;" decodes and the check can't pass vacuously.
const SITELINKS = [
  ['Shared taxi', 'board.html'],
  ['Popular routes & prices', 'trip/index.html'],
  ['Plan a multi-stop trip', 'plan.html'],
  ['Full tours', 'tours.html'],
  ['About us', 'about.html'],
];

const title = (file) => new JSDOM(readFileSync(join(ROOT, file), 'utf8')).window.document.title;

describe('each sitelink page title starts with its sitelink name', () => {
  it.each(SITELINKS)('%s → %s', (name, file) => {
    expect(title(file).startsWith(name + ' — ')).toBe(true);
  });
});
