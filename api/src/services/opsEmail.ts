// Shared frame for team-facing emails (spec 2026-07-18). One branded wrapper + a few content
// helpers so the quote emails and the digest are one visual family — deliberately not a
// template engine. Nothing here carries cost/margin; callers pass sell figures only.

export const TEAL_DEEP = '#24758A'; // the rebrand's text-safe deep accent (--blue-deep); old #0a7d6f is retired
export const INK = '#3A3739'; // Bristol Black (--ink) — was a one-off #1b1b1b
export const MUTED = '#6c6a6b'; // --ink-soft — was Tailwind gray-500
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function money(cents: number, currency: string): string {
  return `${currency === 'USD' ? '$' : currency + ' '}${(cents / 100).toFixed(2)}`;
}

export function heroRef(ref: string): string {
  return `<p style="font-size:22px;font-weight:600;color:${TEAL_DEEP};margin:0 0 16px">${esc(ref)}</p>`;
}

export function detailTable(rows: [string, string][]): string {
  return [
    '<table style="border-collapse:collapse;font-size:14px;margin:0 0 20px">',
    ...rows.map(
      ([k, v]) =>
        `<tr><td style="padding:4px 16px 4px 0;color:${MUTED}">${esc(k)}</td>` +
        `<td style="padding:4px 0;font-weight:500">${esc(v)}</td></tr>`,
    ),
    '</table>',
  ].join('');
}

export function ctaBlock(label: string, href: string, fallback: string): string {
  return href
    ? `<p style="margin:0"><a href="${esc(href)}" style="background:${TEAL_DEEP};color:#fff;` +
        `text-decoration:none;padding:10px 20px;border-radius:999px;display:inline-block;font-weight:700">${esc(label)}</a></p>`
    : `<p style="margin:0;color:${MUTED};font-size:14px">${esc(fallback)}</p>`;
}

// A small coloured label ("PAID") that heads a message. Colours are the ops-ui status chips.
export function statusPill(label: string, color: string, bg: string): string {
  return `<span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:.08em;color:${color};` +
    `background:${bg};border-radius:999px;padding:3px 10px">${esc(label)}</span>`;
}

// The two or three facts a reader needs at a glance, as grey boxes in one row. A table, not
// flex/grid: email clients only agree on tables.
export function keyFacts(facts: [string, string][]): string {
  const cells = facts.map(
    ([k, v]) =>
      `<td style="padding:10px 14px;background:#F6F4EE;border-radius:8px;vertical-align:top">` +
      `<div style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:.05em">${esc(k)}</div>` +
      `<div style="font-size:17px;font-weight:700;margin-top:2px">${esc(v)}</div></td>`,
  );
  return `<table style="border-collapse:separate;margin:0 0 20px"><tr>${cells.join('<td style="width:8px"></td>')}</tr></table>`;
}

// A titled group of label/value rows. `strong` rows are bolded (the money line).
export function section(title: string, rows: [string, string][], strong: string[] = []): string {
  return [
    `<p style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};margin:0 0 6px">${esc(title)}</p>`,
    '<table style="border-collapse:collapse;font-size:14px;margin:0 0 18px;width:100%">',
    ...rows.map(
      ([k, v]) =>
        `<tr><td style="padding:5px 16px 5px 0;color:${MUTED};width:110px;vertical-align:top;border-top:1px solid #eee9df">${esc(k)}</td>` +
        `<td style="padding:5px 0;font-weight:${strong.includes(k) ? 700 : 500};border-top:1px solid #eee9df">${esc(v)}</td></tr>`,
    ),
    '</table>',
  ].join('');
}

// Wrap a caller-built body in the branded container + eyebrow + footer.
export function opsEmailShell(bodyHtml: string, bodyText: string): { html: string; text: string } {
  const html = [
    `<div style="font-family:${FONT};color:${INK};max-width:520px">`,
    `<p style="font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${MUTED};margin:0 0 12px">Ceylon Hop ops</p>`,
    bodyHtml,
    `<p style="margin:24px 0 0;color:${MUTED};font-size:12px">You're on the Ceylon Hop ops team.</p>`,
    '</div>',
  ].join('');
  return { html, text: `CEYLON HOP OPS\n\n${bodyText}` };
}
