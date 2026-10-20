#!/usr/bin/env node
// Gate for a /partner-leads run: checks leads.csv against the lead row contract
// (.claude/skills/partner-leads/lead-row.md) and the outreach ledger, so no agency is
// pitched twice and every hook carries a source. No dependencies — node: built-ins only.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COLUMNS = [
  'lead_id', 'market', 'run_date', 'agency', 'legal_entity', 'city', 'country', 'website', 'segment',
  'destination_url', 'format', 'score', 'score_breakdown', 'wave', 'to', 'cc', 'attn_name', 'attn_title',
  'contact_confidence', 'contact_sources', 'email_label', 'follow_up', 'hook', 'hook_source_url',
  'verified_at', 'subject', 'body', 'status', 'notes',
];
const REQUIRED = ['lead_id', 'market', 'run_date', 'agency', 'country', 'website', 'segment', 'destination_url',
  'format', 'score', 'wave', 'to', 'contact_confidence', 'email_label', 'hook', 'hook_source_url',
  'verified_at', 'subject', 'body', 'status'];
const ENUMS = {
  format: ['private', 'mixed', 'group'],
  wave: ['1', '2'],
  contact_confidence: ['HIGH', 'MEDIUM', 'LOW', 'none'],
  email_label: ['published', 'registry-filed', 'pattern-inferred'],
  status: ['draft', 'needs-owner'],
};
export const MAX_WORDS = 170;
export const MAX_SUBJECT = 90;
export const OPT_OUT = 'no thanks';
const EMAIL = /^[^\s@;,]+@[^\s@;,]+\.[a-z]{2,}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
/** Shape AND calendar: rejects 2026-13-45 and 2026-02-31, which Date.parse rolls over. */
const isRealDate = s => DATE.test(s) && !Number.isNaN(Date.parse(s))
  && new Date(Date.parse(s)).toISOString().slice(0, 10) === s;

/** RFC 4180-style CSV: quoted fields may hold commas, "" quotes and newlines. */
export function parseCsv(text) {
  text = text.replace(/^﻿/, ''); // a UTF-8 BOM from a spreadsheet export would corrupt the first header
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

export function toObjects(text) {
  const [head = [], ...rest] = parseCsv(text || '');
  return { head, rows: rest.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']))) };
}

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

/** Slug = brief file name; segments = the bold names under "## Segments". */
export function readBrief(text, file) {
  const slug = path.basename(file, '.md');
  const section = (text.split(/^## Segments\s*$/m)[1] || '').split(/^## /m)[0];
  const segments = [...section.matchAll(/^- \*\*([^*]+?):?\*\*/gm)].map(m => m[1].trim());
  return { slug, segments };
}

const isHttps = v => { try { return new URL(v).protocol === 'https:'; } catch { return false; } };

export function validateLeads({ leadsCsv, ledgerCsv, brief }) {
  const errors = [];
  const err = (row, column, rule) => errors.push({ row, column, rule });
  const { head, rows } = toObjects(leadsCsv);
  for (const c of COLUMNS) if (!head.includes(c)) err(0, c, 'missing column');
  if (errors.length) return { ok: false, errors };

  const ledger = new Set(toObjects(ledgerCsv).rows
    .map(r => (r.domain || '').trim().toLowerCase().replace(/^www\./, '')).filter(Boolean));
  const ids = new Set(), domains = new Set();
  rows.forEach((r, i) => {
    const n = i + 1;
    for (const c of REQUIRED) if (!r[c].trim()) err(n, c, 'required');
    for (const [c, allowed] of Object.entries(ENUMS)) {
      if (r[c] && !allowed.includes(r[c])) err(n, c, `must be one of ${allowed.join('|')}`);
    }
    if (r.market && r.market !== brief.slug) err(n, 'market', `must be ${brief.slug}`);
    if (r.segment && !brief.segments.includes(r.segment)) err(n, 'segment', 'not a brief segment');

    for (const c of ['website', 'destination_url', 'hook_source_url']) {
      if (!isHttps(r[c])) err(n, c, 'must be an https URL');
    }
    const domain = domainOf(r.website);
    if (domain) {
      if (ledger.has(domain)) err(n, 'website', 'domain already in ledger');
      if (domains.has(domain)) err(n, 'website', 'duplicate domain in file');
      domains.add(domain);
      const want = `${brief.slug}-${domain}`;
      if (r.lead_id && r.lead_id !== want) err(n, 'lead_id', `must be ${want}`);
    }
    if (r.lead_id) {
      if (ids.has(r.lead_id)) err(n, 'lead_id', 'duplicate');
      ids.add(r.lead_id);
    }

    if (r.score && !(/^\d+$/.test(r.score) && +r.score <= 15)) err(n, 'score', 'must be an integer 0–15');
    if (r.to && !EMAIL.test(r.to.trim())) err(n, 'to', 'not an email');
    const cc = r.cc.split(';').map(s => s.trim()).filter(Boolean);
    if (cc.some(a => !EMAIL.test(a))) err(n, 'cc', 'not an email');
    if (['HIGH', 'MEDIUM'].includes(r.contact_confidence) && !r.attn_name.trim()) err(n, 'attn_name', 'required for HIGH/MEDIUM');

    const runOk = isRealDate(r.run_date), verifiedOk = isRealDate(r.verified_at);
    if (r.run_date && !runOk) err(n, 'run_date', 'must be YYYY-MM-DD');
    if (r.verified_at && !verifiedOk) err(n, 'verified_at', 'must be YYYY-MM-DD');
    if (runOk && verifiedOk) {
      const gap = (Date.parse(r.run_date) - Date.parse(r.verified_at)) / DAY;
      if (gap < 0 || gap > 7) err(n, 'verified_at', 'must be within 7 days before run_date');
    }

    if (r.subject.length > MAX_SUBJECT) err(n, 'subject', `over ${MAX_SUBJECT} characters`);
    if (r.body) {
      if (!r.body.toLowerCase().includes(OPT_OUT)) err(n, 'body', `missing opt-out ("${OPT_OUT}")`);
      const words = r.body.split('[Name]')[0].trim().split(/\s+/).filter(Boolean).length;
      if (words > MAX_WORDS) err(n, 'body', `over ${MAX_WORDS} words`);
    }
  });
  return { ok: errors.length === 0, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [leadsPath, ledgerPath, briefPath] = process.argv.slice(2);
  if (!leadsPath || !ledgerPath || !briefPath) {
    console.error('usage: validate-leads.mjs <leads.csv> <ledger.csv> <brief.md>');
    process.exit(2);
  }
  const res = validateLeads({
    leadsCsv: readFileSync(leadsPath, 'utf8'),
    ledgerCsv: existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '',
    brief: readBrief(readFileSync(briefPath, 'utf8'), briefPath),
  });
  if (res.ok) {
    console.log(`OK ${toObjects(readFileSync(leadsPath, 'utf8')).rows.length} leads`);
  } else {
    for (const e of res.errors) console.log(`row ${e.row} · ${e.column} · ${e.rule}`);
    process.exit(1);
  }
}
