// Contract for the partner-leads gate (tools/outreach/validate-leads.mjs).
// The lead row is the interface to the outreach Sheet (spec 2), so every ★ rule in
// .claude/skills/partner-leads/lead-row.md has a failing case here.
import { describe, it, expect } from 'vitest';
import { COLUMNS, parseCsv, readBrief, validateLeads } from '../../tools/outreach/validate-leads.mjs';

const brief = { slug: 'india-ramayana', segments: ['South India FIT', 'Pilgrimage specialists'] };

const good = (over = {}) => ({
  lead_id: 'india-ramayana-example.in',
  market: 'india-ramayana',
  run_date: '2026-10-19',
  agency: 'Example Holidays',
  legal_entity: '',
  city: 'Chennai',
  country: 'India',
  website: 'https://www.example.in',
  segment: 'South India FIT',
  destination_url: 'https://www.example.in/sri-lanka',
  format: 'private',
  score: '12',
  score_breakdown: 'fit3 format3 hook2 reach2 cred2',
  wave: '1',
  to: 'info@example.in',
  cc: 'sales@example.in; ops@example.in',
  attn_name: 'A. Person',
  attn_title: 'Founder',
  contact_confidence: 'HIGH',
  contact_sources: 'https://www.example.in/about',
  email_label: 'published',
  follow_up: 'WhatsApp +91 90000 00000',
  hook: 'Their 6-day Sri Lanka trip runs by private car.',
  hook_source_url: 'https://www.example.in/sri-lanka',
  verified_at: '2026-10-19',
  subject: 'A ground partner for your Sri Lanka trips',
  body: 'Dear A. Person,\n\nWe can add the southern sites, for guests who want them.\n\nIf this isn\'t for you, just reply "no thanks" and I won\'t write again.\n\n[Name]\nCeylon Hop',
  status: 'draft',
  notes: '',
  ...over,
});

const cell = v => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = rows => [COLUMNS.join(','), ...rows.map(r => COLUMNS.map(c => cell(r[c] ?? '')).join(','))].join('\n') + '\n';
const LEDGER = 'domain,market,first_seen,last_run,status\nalready.in,india-ramayana,2026-10-19,2026-10-19,researched\n';
const run = (rows, ledgerCsv = LEDGER) => validateLeads({ leadsCsv: csv(rows), ledgerCsv, brief });
const rules = res => res.errors.map(e => `${e.column}:${e.rule}`);

describe('parseCsv', () => {
  it('keeps commas, quotes and newlines inside quoted fields', () => {
    expect(parseCsv('a,b\n"x, ""y""\nz",2\n')).toEqual([['a', 'b'], ['x, "y"\nz', '2']]);
  });
});

describe('readBrief', () => {
  it('takes the slug from the file name and segments from the Segments section', () => {
    const md = '# Brief\n\n## Segments\n- **South India FIT:** agencies in Chennai\n- **Pilgrimage specialists:** yatra operators\n\n## Pitch\n- x\n';
    expect(readBrief(md, '/a/markets/india-ramayana.md')).toEqual({ slug: 'india-ramayana', segments: ['South India FIT', 'Pilgrimage specialists'] });
  });
});

describe('validateLeads', () => {
  it('accepts a good file', () => {
    const res = run([good()]);
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('rejects a missing column', () => {
    const res = validateLeads({ leadsCsv: 'lead_id,market\nx,y\n', ledgerCsv: LEDGER, brief });
    expect(res.ok).toBe(false);
    expect(rules(res)).toContain('agency:missing column');
  });

  it('rejects a domain already in the ledger', () => {
    const res = run([good({ website: 'https://already.in', lead_id: 'india-ramayana-already.in' })]);
    expect(rules(res)).toContain('website:domain already in ledger');
  });

  it('rejects the same domain twice in one file and a duplicate lead_id', () => {
    const res = run([good(), good()]);
    expect(rules(res)).toEqual(expect.arrayContaining(['website:duplicate domain in file', 'lead_id:duplicate']));
  });

  it('rejects a lead_id that is not <market>-<domain>', () => {
    expect(rules(run([good({ lead_id: 'x' })]))).toContain('lead_id:must be india-ramayana-example.in');
  });

  it('rejects a market that is not the brief slug and an unknown segment', () => {
    expect(rules(run([good({ market: 'europe' })]))).toContain('market:must be india-ramayana');
    expect(rules(run([good({ segment: 'Luxury' })]))).toContain('segment:not a brief segment');
  });

  it('rejects a missing hook source and non-https URLs', () => {
    expect(rules(run([good({ hook_source_url: '' })]))).toContain('hook_source_url:must be an https URL');
    expect(rules(run([good({ destination_url: 'http://www.example.in/sri-lanka' })]))).toContain('destination_url:must be an https URL');
  });

  it('rejects a body without the opt-out line', () => {
    expect(rules(run([good({ body: 'Dear A,\n\nHello.\n\n[Name]' })]))).toContain('body:missing opt-out ("no thanks")');
  });

  it('rejects a body over 170 words before [Name]', () => {
    const long = `${'word '.repeat(171)}reply "no thanks"\n\n[Name]`;
    expect(rules(run([good({ body: long })]))).toContain('body:over 170 words');
  });

  it('rejects bad enum values', () => {
    const res = run([good({ format: 'coach', wave: '3', contact_confidence: 'high', email_label: 'guessed', status: 'sent' })]);
    expect(rules(res)).toEqual(expect.arrayContaining([
      'format:must be one of private|mixed|group',
      'wave:must be one of 1|2',
      'contact_confidence:must be one of HIGH|MEDIUM|LOW|none',
      'email_label:must be one of published|registry-filed|pattern-inferred',
      'status:must be one of draft|needs-owner',
    ]));
  });

  it('rejects a bad to/cc address and a score outside 0–15', () => {
    const res = run([good({ to: 'info at example', cc: 'ok@example.in; nope', score: '16' })]);
    expect(rules(res)).toEqual(expect.arrayContaining(['to:not an email', 'cc:not an email', 'score:must be an integer 0–15']));
  });

  it('requires attn_name when contact confidence is HIGH or MEDIUM', () => {
    expect(rules(run([good({ attn_name: '', contact_confidence: 'MEDIUM' })]))).toContain('attn_name:required for HIGH/MEDIUM');
    expect(run([good({ attn_name: '', contact_confidence: 'LOW' })]).ok).toBe(true);
  });

  it('rejects a stale or future verified_at and a long subject', () => {
    expect(rules(run([good({ verified_at: '2026-10-11' })]))).toContain('verified_at:must be within 7 days before run_date');
    expect(rules(run([good({ verified_at: '2026-10-20' })]))).toContain('verified_at:must be within 7 days before run_date'); // date-bomb-ok: one day after the run_date fixture, not wall-clock
    expect(rules(run([good({ subject: 'x'.repeat(91) })]))).toContain('subject:over 90 characters');
  });

  it('treats an empty ledger as no prior domains', () => {
    expect(run([good({ website: 'https://already.in', lead_id: 'india-ramayana-already.in' })], '').ok).toBe(true);
  });
});
