// Shared frame for team-facing emails (spec 2026-07-18). One branded wrapper + a few content
// helpers so the quote emails and the digest are one visual family — deliberately not a
// template engine. Nothing here carries cost/margin; callers pass sell figures only.

export const TEAL_DEEP = '#0a7d6f';
export const INK = '#1b1b1b';
export const MUTED = '#6b7280';
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
        `text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-weight:500">${esc(label)}</a></p>`
    : `<p style="margin:0;color:${MUTED};font-size:14px">${esc(fallback)}</p>`;
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
