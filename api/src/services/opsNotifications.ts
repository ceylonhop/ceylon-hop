import type { EmailAdapter } from '../adapters/email';
import { opsEmailShell, heroRef, detailTable, ctaBlock, money, esc } from './opsEmail';

// Internal staff notifications (spec 2026-07-16). Deliberately separate from
// services/notifications.ts: that file is customer-facing and Booking-shaped, this one goes to
// colleagues and is quote-shaped. Nothing here may carry cost or margin — an assignee can be
// finance/ops without margin:view, so this email only ever states the sell total.

export interface AssignedQuote {
  id: string;
  reference: string;
  status: string;
  customerName: string | null;
  totalCents: number;
  currency: string;
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

function assignedBody(q: AssignedQuote, lead: string, cta: { label: string; link: string }): { html: string; text: string } {
  const rows: [string, string][] = [
    ['Customer', q.customerName || '—'],
    ['Total', money(q.totalCents, q.currency)],
    ['Status', statusLabel(q.status)],
  ];
  const html = [
    `<p style="font-size:16px;margin:0 0 4px">${lead}</p>`,
    heroRef(q.reference),
    detailTable(rows),
    ctaBlock(cta.label, cta.link, 'Open it from the Quotes tab in the ops dashboard.'),
  ].join('');
  const text = [
    lead.replace(/<[^>]+>/g, ''),
    '',
    `Reference: ${q.reference}`,
    `Customer:  ${q.customerName || '—'}`,
    `Total:     ${money(q.totalCents, q.currency)}`,
    `Status:    ${statusLabel(q.status)}`,
    '',
    cta.link ? `${cta.label}: ${cta.link}` : 'Open it from the Quotes tab in the ops dashboard.',
  ].join('\n');
  return opsEmailShell(html, text);
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
  const { html, text } = assignedBody(q, `<strong>${esc(assignedBy)}</strong> assigned you a quote.`, {
    label: 'Open the quote',
    link,
  });
  await email.send({ to: assignedTo, subject: `Quote ${q.reference} assigned to you — Ceylon Hop ops`, html, text });
}

export async function sendQuoteAwaitingApproval(
  q: AssignedQuote,
  to: string,
  submittedBy: string,
  email: EmailAdapter,
  opsBaseUrl: string,
): Promise<void> {
  const link = quoteDeepLink(q.id, opsBaseUrl);
  const { html, text } = assignedBody(q, `<strong>${esc(submittedBy)}</strong> submitted a quote for approval.`, {
    label: 'Review the quote',
    link,
  });
  await email.send({ to, subject: `Quote ${q.reference} needs your approval — Ceylon Hop ops`, html, text });
}

export async function sendQuoteSentBack(
  q: AssignedQuote,
  to: string,
  sentBackBy: string,
  note: string | null,
  email: EmailAdapter,
  opsBaseUrl: string,
): Promise<void> {
  const link = quoteDeepLink(q.id, opsBaseUrl);
  const lead = `<strong>${esc(sentBackBy)}</strong> sent your quote back for changes.`;
  const noteHtml = note ? `<p style="margin:0 0 20px;padding:12px 14px;background:#f3f4f6;border-radius:6px;font-size:14px">${esc(note)}</p>` : '';
  const html = [`<p style="font-size:16px;margin:0 0 4px">${lead}</p>`, heroRef(q.reference), noteHtml, ctaBlock('Open the quote', link, 'Open it from the Quotes tab in the ops dashboard.')].join('');
  const text = [lead.replace(/<[^>]+>/g, ''), '', `Reference: ${q.reference}`, note ? `\nNote: ${note}` : '', '', link ? `Open the quote: ${link}` : 'Open it from the Quotes tab.'].join('\n');
  const wrapped = opsEmailShell(html, text);
  await email.send({ to, subject: `Changes requested on quote ${q.reference} — Ceylon Hop ops`, html: wrapped.html, text: wrapped.text });
}
