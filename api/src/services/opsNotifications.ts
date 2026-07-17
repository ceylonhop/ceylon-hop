import type { EmailAdapter } from '../adapters/email';

// Internal staff notifications (spec 2026-07-16). Deliberately separate from
// services/notifications.ts: that file is customer-facing and Booking-shaped, this one goes to
// colleagues and is quote-shaped. Nothing here may carry cost or margin — an assignee can be
// finance/ops without margin:view, so this email only ever states the sell total.

const TEAL_DEEP = '#0a7d6f';
const INK = '#1b1b1b';
const MUTED = '#6b7280';

export interface AssignedQuote {
  id: string;
  reference: string;
  status: string;
  customerName: string | null;
  totalCents: number;
  currency: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function money(cents: number, currency: string): string {
  return `${currency === 'USD' ? '$' : currency + ' '}${(cents / 100).toFixed(2)}`;
}

// 'pending_review' → 'Pending review'
function statusLabel(s: string): string {
  const words = s.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The whole point of the email: land on THIS quote, not the queue. ops-ui's routeStateFromUrl
// reads ?quote= before the hash, so no #quote fragment is needed. Empty when OPS_BASE_URL is
// unset — we'd rather send a linkless email than stay silent, so callers must tolerate ''.
export function quoteDeepLink(id: string, opsBaseUrl: string): string {
  const base = (opsBaseUrl || '').trim().replace(/\/+$/, '');
  return base ? `${base}/ops?quote=${encodeURIComponent(id)}` : '';
}

function renderHtml(q: AssignedQuote, assignedBy: string, link: string): string {
  const rows: [string, string][] = [
    ['Customer', q.customerName || '—'],
    ['Total', money(q.totalCents, q.currency)],
    ['Status', statusLabel(q.status)],
  ];
  return [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${INK};max-width:520px">`,
    `<p style="font-size:16px;margin:0 0 4px"><strong>${esc(assignedBy)}</strong> assigned you a quote.</p>`,
    `<p style="font-size:22px;font-weight:600;color:${TEAL_DEEP};margin:0 0 16px">${esc(q.reference)}</p>`,
    '<table style="border-collapse:collapse;font-size:14px;margin:0 0 20px">',
    ...rows.map(
      ([k, v]) =>
        `<tr><td style="padding:4px 16px 4px 0;color:${MUTED}">${esc(k)}</td>` +
        `<td style="padding:4px 0;font-weight:500">${esc(v)}</td></tr>`,
    ),
    '</table>',
    link
      ? `<p style="margin:0"><a href="${esc(link)}" style="background:${TEAL_DEEP};color:#fff;` +
        `text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-weight:500">Open the quote</a></p>`
      : `<p style="margin:0;color:${MUTED};font-size:14px">Open it from the Quotes tab in the ops dashboard.</p>`,
    '</div>',
  ].join('');
}

function renderText(q: AssignedQuote, assignedBy: string, link: string): string {
  return [
    `${assignedBy} assigned you a quote.`,
    '',
    `Reference: ${q.reference}`,
    `Customer:  ${q.customerName || '—'}`,
    `Total:     ${money(q.totalCents, q.currency)}`,
    `Status:    ${statusLabel(q.status)}`,
    '',
    link ? `Open the quote: ${link}` : 'Open it from the Quotes tab in the ops dashboard.',
  ].join('\n');
}

// Throws on a provider failure — callers make it best-effort. An assignment that only half-lands
// (row updated, nobody told) is bad, but an assign that 500s because Resend blipped is worse.
export async function sendQuoteAssigned(
  q: AssignedQuote,
  assignedTo: string,
  assignedBy: string,
  email: EmailAdapter,
  opsBaseUrl: string,
): Promise<void> {
  const link = quoteDeepLink(q.id, opsBaseUrl);
  await email.send({
    to: assignedTo,
    subject: `Quote ${q.reference} assigned to you — Ceylon Hop ops`,
    html: renderHtml(q, assignedBy, link),
    text: renderText(q, assignedBy, link),
  });
}
