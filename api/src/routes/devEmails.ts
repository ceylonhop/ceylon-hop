import { Hono } from 'hono';
import { FakeEmailAdapter } from '../adapters/email';
import type { Booking } from '../db/bookingRepo';
import { sampleBooking, sampleVariants, type SampleMode } from '../services/__fixtures__/sampleBookings';
import {
  sendBookingConfirmation,
  sendDetailsNeeded,
  sendBookingConfirmed,
  sendCancellationConfirmation,
  sendRefundConfirmation,
  sendNoShowNotice,
  sendTripReminder,
  sendReviewRequest,
  sendPaymentIncomplete,
} from '../services/notifications';

// Dev-only preview harness for the customer emails. Renders the ACTUAL sender output
// (via a FakeEmailAdapter) so what you see is exactly what ships — no template
// duplication. Mounted only when nodeEnv !== 'production' (see app.ts).

const LINKS = {
  manage: 'https://ceylonhop.com/manage.html?t=preview-token',
  resume: 'https://ceylonhop.com/booking.html?id=preview',
};

interface EmailDef {
  name: string;
  label: string;
  run: (b: Booking, e: FakeEmailAdapter) => Promise<void>;
}

const EMAILS: EmailDef[] = [
  { name: 'confirmation', label: 'Booking confirmation', run: (b, e) => sendBookingConfirmation(b, e, { manage: LINKS.manage }) },
  { name: 'details-needed', label: 'Awaiting details', run: (b, e) => sendDetailsNeeded(b, e, { manage: LINKS.manage }) },
  { name: 'booking-confirmed', label: 'Booking confirmed', run: (b, e) => sendBookingConfirmed(b, e, { manage: LINKS.manage }) },
  { name: 'cancellation', label: 'Cancellation', run: (b, e) => sendCancellationConfirmation(b, e) },
  { name: 'refund', label: 'Refund processed', run: (b, e) => sendRefundConfirmation(b, e) },
  { name: 'no-show', label: 'No-show notice', run: (b, e) => sendNoShowNotice(b, e) },
  { name: 'trip-reminder', label: 'Pre-trip reminder', run: (b, e) => sendTripReminder(b, e, { manage: LINKS.manage }) },
  { name: 'review-request', label: 'Review request', run: (b, e) => sendReviewRequest(b, e) },
  { name: 'payment-incomplete', label: 'Payment incomplete (recovery)', run: (b, e) => sendPaymentIncomplete(b, e, { resume: LINKS.resume }) },
];

const MODES = ['single', 'trip', 'trip-private', 'roundtrip', 'shared', 'flexible', 'deposit'] as const;

function resolveBooking(mode: string): Booking {
  if (mode === 'flexible') return sampleVariants.singleFlexible;
  if (mode === 'deposit') return sampleVariants.singleDeposit;
  if (mode === 'trip-private') return sampleVariants.tripPrivate;
  if (mode === 'roundtrip') return sampleVariants.roundTrip;
  if (mode === 'trip' || mode === 'shared' || mode === 'single') return sampleBooking(mode as SampleMode);
  return sampleBooking('single');
}

async function render(def: EmailDef, mode: string): Promise<{ subject: string; html: string; text: string }> {
  const email = new FakeEmailAdapter();
  await def.run(resolveBooking(mode), email);
  const m = email.sent[0];
  return { subject: m?.subject ?? '(no email sent)', html: m?.html ?? '', text: m?.text ?? '' };
}

export function devEmailRoutes(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const rows = EMAILS.map(
      (def) => `
      <tr>
        <td class="lbl"><code>${def.name}</code><div class="sub">${def.label}</div></td>
        <td>${MODES.map((mode) => `<a href="/dev/emails/${def.name}?mode=${mode}">${mode}</a>`).join('')}
          <span class="txt">${MODES.map((mode) => `<a href="/dev/emails/${def.name}?mode=${mode}&format=text">txt</a>`).join('')}</span>
        </td>
      </tr>`,
    ).join('');
    return c.html(`<!doctype html><meta charset="utf-8"><title>Email preview — Ceylon Hop</title>
      <style>
        body{font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1b1b1b;max-width:760px;margin:32px auto;padding:0 16px}
        h1{font-size:20px}p{color:#6b7280}
        table{border-collapse:collapse;width:100%;margin-top:16px}
        td{border-top:1px solid #eee;padding:12px 8px;vertical-align:top}
        .lbl{width:230px}.sub{color:#6b7280;font-size:13px;margin-top:2px}
        code{background:#f1faf8;color:#0a7d6f;padding:2px 6px;border-radius:5px;font-size:13px}
        a{display:inline-block;margin:2px 8px 2px 0;color:#0a7d6f;text-decoration:none;border:1px solid #d7ece7;border-radius:6px;padding:3px 9px;font-size:13px}
        a:hover{background:#f1faf8}.txt a{color:#9ca3af;border-color:#eee}.txt{display:block;margin-top:4px}
      </style>
      <h1>Ceylon Hop — email preview</h1>
      <p>Dev-only harness. Each link renders the real sender output for a sample booking. <code>txt</code> shows the plain-text alternative.</p>
      <table>${rows}</table>`);
  });

  app.get('/:name', async (c) => {
    const def = EMAILS.find((e) => e.name === c.req.param('name'));
    if (!def) return c.text('unknown email', 404);
    const mode = c.req.query('mode') ?? 'single';
    const { html, text } = await render(def, mode);
    if (c.req.query('format') === 'text') {
      return c.html(`<!doctype html><meta charset="utf-8"><pre style="white-space:pre-wrap;font:14px/1.6 ui-monospace,Menlo,monospace;max-width:680px;margin:24px auto;padding:0 16px">${text.replace(/[&<>]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[x] as string)}</pre>`);
    }
    return c.html(html);
  });

  return app;
}
