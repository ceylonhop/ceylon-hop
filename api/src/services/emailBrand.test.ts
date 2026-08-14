// The email templates never went through the #441 rebrand sweep — the retired deep teal
// was literally the accent constant of the whole customer email family, and nothing
// scanned api/ for it (web-tests/unit/retired-hexes.test.js is structurally blind to
// this directory). This is the same guard, pointed at every file that builds email HTML.
// Comments are stripped first: a comment can't paint.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const EMAIL_FILES = [
  'src/services/notifications.ts',
  'src/services/rideBoardEmails.ts',
  'src/services/opsEmail.ts',
  'src/services/opsNotifications.ts',
  'src/services/digest.ts',
  'src/routes/devEmails.ts',
  'src/adapters/alerts.ts',
];

// The pre-rebrand palette, from #441's diff + the 2026-08-12/13 sweeps. Zero legitimate
// occurrences. #25D366 is the raw WhatsApp green that site.css:250 replaced because white
// text on it is 1.98:1 — emails must use #0B7A44 like the site.
const RETIRED = [
  '#0d8f8c', '#2aa9bf', '#0a9d9a', '#0f8a80', '#39d6d0', '#7fe3df',
  '#0a7d6f', '#3a9fc0', '#2d7e93', '#12312e', '#2C2A2B', '#0c3a38',
  '#4a5a57', '#5a6b68', '#f6f3ec', '#e7e2d8', '#e8623a', '#f6543b',
  '#25D366',
];

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('no email template uses a retired pre-rebrand colour', () => {
  for (const rel of EMAIL_FILES) {
    it(rel, () => {
      const src = stripComments(readFileSync(join(__dirname, '../..', rel), 'utf8'));
      for (const hex of RETIRED) {
        const re = new RegExp(`${hex}(?![0-9a-fA-F])`, 'i');
        expect(src.match(re), `${rel} uses retired ${hex} — see the 2026-08-13 email audit / #441`).toBeNull();
      }
    });
  }
});
