# Ops Team Emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two quote-lifecycle ops emails (awaiting-approval, sent-back), a shared ops-email shell, and a richer daily digest — all reusing existing plumbing.

**Architecture:** The two new emails fire from the existing `PATCH /admin/quote/:id` hook (where `sendQuoteAssigned` already fires). A thin `opsEmail.ts` shell unifies the three quote emails. `buildDigest` gains an optional `quotes` repo for a value/quote section and renders through the shell.

**Tech Stack:** Node 20 · TypeScript (strict) · Hono · Zod · Vitest. Backend in `api/`.

**Spec:** [docs/superpowers/specs/2026-07-18-ops-team-emails-design.md](../specs/2026-07-18-ops-team-emails-design.md)

## Global Constraints

- **Best-effort:** every email send is wrapped so a provider error never fails the PATCH or the digest tick (matches `sendQuoteAssigned` today).
- **No cost/margin** in any ops email (recipients may lack `margin:view`) — sell total only.
- **No schema/migration, no pricing edits, no new *required* config.** `OPS_USERS` and `OPS_BASE_URL` already exist.
- **Green gate:** `cd api && npm run check` (typecheck + lint + test) passes before every commit.
- **TDD, red→green.** Stage by explicit path (never `git add -A`). Commit footer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- **Create** `api/src/services/opsEmail.ts` — palette + `esc`/`money` + shell (`opsEmailShell`, `heroRef`, `detailTable`, `ctaBlock`).
- **Create** `api/src/services/opsEmail.test.ts`.
- **Create** `api/src/services/digest.test.ts` (digest currently has no test).
- **Modify** `api/src/lib/opsAuth.ts` (+ `opsAuth.test.ts`) — `approverOpsUsers`.
- **Modify** `api/src/services/opsNotifications.ts` — refactor `sendQuoteAssigned` onto the shell; add `sendQuoteAwaitingApproval`, `sendQuoteSentBack`.
- **Modify** `api/src/routes/internalQuote.ts` (+ `internalQuote.test.ts`) — fire the two new emails from the PATCH hook.
- **Modify** `api/src/services/digest.ts`, `api/src/routes/admin.ts`, `api/src/app.ts` — richer digest + `quotes` wiring.

---

### Task 1: `approverOpsUsers` helper

**Files:** Modify `api/src/lib/opsAuth.ts`; Test `api/src/lib/opsAuth.test.ts`

**Interfaces:**
- Produces: `approverOpsUsers(raw: string): AssignableUser[]` — the `quote:approve` holders parsed from an `OPS_USERS` string.

- [ ] **Step 1: Write the failing test**

Add to `api/src/lib/opsAuth.test.ts` (match the file's existing import of `opsAuth`):

```ts
import { approverOpsUsers } from './opsAuth';

it('approverOpsUsers returns only quote:approve holders (founders)', () => {
  const raw = 'f@x.com:founder,fin@x.com:finance,op@x.com:ops';
  expect(approverOpsUsers(raw).map((u) => u.email)).toEqual(['f@x.com']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/lib/opsAuth.test.ts -t "approverOpsUsers"`
Expected: FAIL — `approverOpsUsers` is not exported.

- [ ] **Step 3: Implement**

In `api/src/lib/opsAuth.ts`, add directly below `assignableOpsUsers`:

```ts
// Who should be told a quote is waiting for approval (spec 2026-07-18): the quote:approve
// holders. Mirrors assignableOpsUsers, filtered on the approval capability instead.
export function approverOpsUsers(raw: string): AssignableUser[] {
  return [...parseOpsUsers(raw)]
    .filter(([, role]) => can(role, 'quote:approve'))
    .map(([email, role]) => ({ email, role }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/lib/opsAuth.test.ts -t "approverOpsUsers"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd api && npm run check
git add api/src/lib/opsAuth.ts api/src/lib/opsAuth.test.ts
git commit -m "feat(ops): approverOpsUsers helper (quote:approve holders)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: shared ops-email shell + refactor `sendQuoteAssigned`

**Files:** Create `api/src/services/opsEmail.ts`, `api/src/services/opsEmail.test.ts`; Modify `api/src/services/opsNotifications.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `esc(s: string): string`, `money(cents: number, currency: string): string`
  - `heroRef(ref: string): string`, `detailTable(rows: [string, string][]): string`
  - `ctaBlock(label: string, href: string, fallback: string): string`
  - `opsEmailShell(bodyHtml: string, bodyText: string): { html: string; text: string }`

- [ ] **Step 1: Write the failing tests**

Create `api/src/services/opsEmail.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { opsEmailShell, ctaBlock, heroRef, money } from './opsEmail';

describe('opsEmail', () => {
  it('shell wraps body with eyebrow + footer in html and text', () => {
    const { html, text } = opsEmailShell('<p>hi</p>', 'hi');
    expect(html).toContain('Ceylon Hop ops');
    expect(html).toContain('<p>hi</p>');
    expect(html).toContain("You're on the Ceylon Hop ops team.");
    expect(text).toContain('CEYLON HOP OPS');
    expect(text).toContain('hi');
  });

  it('ctaBlock renders a button with a link and a fallback line without one', () => {
    expect(ctaBlock('Open', 'https://x/ops?quote=1', 'Open from the tab')).toContain('href="https://x/ops?quote=1"');
    const none = ctaBlock('Open', '', 'Open from the tab');
    expect(none).not.toContain('href');
    expect(none).toContain('Open from the tab');
  });

  it('money formats USD and other currencies; heroRef escapes', () => {
    expect(money(66900, 'USD')).toBe('$669.00');
    expect(money(5000, 'LKR')).toBe('LKR 50.00');
    expect(heroRef('Q-<b>')).toContain('Q-&lt;b&gt;');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx vitest run src/services/opsEmail.test.ts`
Expected: FAIL — `Cannot find module './opsEmail'`.

- [ ] **Step 3: Implement the shell**

Create `api/src/services/opsEmail.ts`:

```ts
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
```

- [ ] **Step 4: Refactor `sendQuoteAssigned` onto the shell**

In `api/src/services/opsNotifications.ts`: remove the local `TEAL_DEEP/INK/MUTED`, `esc`, `money`, `renderHtml`, `renderText`; import from the shell and rebuild. Keep `statusLabel`, `quoteDeepLink`, `AssignedQuote`, and `sendQuoteAssigned`'s signature unchanged. Replace the render helpers + sender body with:

```ts
import type { EmailAdapter } from '../adapters/email';
import { opsEmailShell, heroRef, detailTable, ctaBlock, money, esc } from './opsEmail';

// ... AssignableQuote interface + quoteDeepLink + statusLabel stay ...

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
```

- [ ] **Step 5: Run tests to verify green**

Run: `cd api && npx vitest run src/services/opsEmail.test.ts src/routes/internalQuote.test.ts`
Expected: PASS — the shell tests pass, and the existing assignment-email test (asserts subject/html/text contain the reference, deep link, actor, and customer name — all preserved) still passes.

- [ ] **Step 6: Commit**

```bash
cd api && npm run check
git add api/src/services/opsEmail.ts api/src/services/opsEmail.test.ts api/src/services/opsNotifications.ts
git commit -m "feat(ops): shared ops-email shell; sendQuoteAssigned adopts it

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: awaiting-approval + sent-back emails, fired from the PATCH hook

**Files:** Modify `api/src/services/opsNotifications.ts`, `api/src/routes/internalQuote.ts`; Test `api/src/routes/internalQuote.test.ts`

**Interfaces:**
- Consumes: `approverOpsUsers` (Task 1); the shell + `assignedBody` pattern (Task 2).
- Produces:
  - `sendQuoteAwaitingApproval(q, to, submittedBy, email, opsBaseUrl): Promise<void>`
  - `sendQuoteSentBack(q, to, sentBackBy, note, email, opsBaseUrl): Promise<void>` (`note: string | null`)

- [ ] **Step 1: Write the failing tests**

In `api/src/routes/internalQuote.test.ts`, add near the assignment-email tests (reuse the file's `FakeEmailAdapter` wiring — the assignment tests already build an app with a `mail` adapter and `OPS_BASE`; mirror that setup). A quote must have `requestedService` set to enter `pending_review` (route gate), and reach `pending_review`/`changes_requested` legally:

```ts
it('emails approvers (not the actor) when a quote enters review', async () => {
  const mail = new FakeEmailAdapter();
  const { app, id } = await seedReviewableQuote(mail); // draft quote w/ requestedService, created by op@x.com
  await patchAs('op@x.com', app, `/admin/quote/${id}`, { status: 'pending_review' });
  const to = mail.sent.map((m) => m.to);
  expect(to).toContain('f@x.com');   // founder holds quote:approve
  expect(to).not.toContain('op@x.com'); // the actor isn't notified
  const msg = mail.sent.find((m) => m.to === 'f@x.com')!;
  expect(msg.subject).toContain('needs your approval');
  expect(msg.html).toContain(`${OPS_BASE}/ops?quote=${id}`);
  expect(JSON.stringify(msg)).not.toMatch(/margin/i);
});

it('emails the maker with the note when a quote is sent back', async () => {
  const mail = new FakeEmailAdapter();
  const { app, id } = await seedReviewableQuote(mail);
  await patchAs('op@x.com', app, `/admin/quote/${id}`, { status: 'pending_review' });
  mail.sent.length = 0;
  await patchAs('f@x.com', app, `/admin/quote/${id}`, { status: 'changes_requested', notes: 'Fix the van rate' });
  const msg = mail.sent.find((m) => m.to === 'op@x.com'); // op@x.com is createdBy
  expect(msg).toBeTruthy();
  expect(msg!.subject).toContain('Changes requested');
  expect(msg!.html).toContain('Fix the van rate');
});
```

Add a `seedReviewableQuote` helper next to the other test helpers. It must produce a `channel:'ops'` quote **created by `op@x.com`** with `requestedService` set (so the review gate passes). Save it through the tool so `createdBy` is stamped:

```ts
async function seedReviewableQuote(mail: FakeEmailAdapter) {
  const app = createApp({ quotes: new InMemoryQuoteRepo(), email: mail, opsBaseUrl: OPS_BASE });
  const save = await postAs('op@x.com', app, '/admin/quote/save', {
    vehicle: 'car', passengerCount: 2, luggageCount: 1, requestedService: 'private',
    legs: [leg({ from: 'Colombo City', to: 'Kandy', distanceKm: 120 })],
  });
  const id = (await save.json()).id as string;
  return { app, id };
}
```

(If `createApp` in this test file doesn't already thread `email`/`opsBaseUrl`, extend its options object to pass them through to `realCreateApp` — the assignment-email tests already do this; reuse their harness. `postAs`/`patchAs`/`leg`/`OPS_BASE` are existing helpers.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t "approvers|sent back"`
Expected: FAIL — no such emails are sent yet.

- [ ] **Step 3: Add the two senders** (`api/src/services/opsNotifications.ts`)

```ts
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
```

- [ ] **Step 4: Fire them from the PATCH hook** (`api/src/routes/internalQuote.ts`)

Add the imports: `import { sendQuoteAssigned, sendQuoteAwaitingApproval, sendQuoteSentBack } from '../services/opsNotifications';` and `import { approverOpsUsers } from '../lib/opsAuth';` (extend the existing imports). Insert immediately **after** the existing `sendQuoteAssigned` best-effort block (after its closing `}`), before the `stripQuoteMargin` return:

```ts
    // Awaiting-approval → all quote:approve holders except the actor (spec 2026-07-18).
    if (body.status === 'pending_review' && deps.email) {
      for (const u of approverOpsUsers(deps.auth.opsUsers)) {
        if (u.email === actor.toLowerCase()) continue;
        try {
          await sendQuoteAwaitingApproval(updated, u.email, actor, deps.email, deps.opsBaseUrl ?? '');
        } catch (err) {
          console.error('quote awaiting-approval email failed', { quote: updated.reference, to: u.email, err });
        }
      }
    }
    // Sent-back → the maker (createdBy), except the actor, carrying the note (spec 2026-07-18).
    if (body.status === 'changes_requested' && deps.email && updated.createdBy && updated.createdBy !== actor.toLowerCase()) {
      try {
        await sendQuoteSentBack(updated, updated.createdBy, actor, body.notes ?? null, deps.email, deps.opsBaseUrl ?? '');
      } catch (err) {
        console.error('quote sent-back email failed', { quote: updated.reference, err });
      }
    }
```

(`updated` is the post-patch `SavedQuote` and carries `createdBy`; `actor`/`deps.auth.opsUsers`/`deps.email`/`deps.opsBaseUrl` are already in scope from the assignment block.)

- [ ] **Step 5: Run tests to verify green**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: PASS (new tests + all existing).

- [ ] **Step 6: Commit**

```bash
cd api && npm run check
git add api/src/services/opsNotifications.ts api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts
git commit -m "feat(ops): email approvers on submit + maker on send-back

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: richer daily digest

**Files:** Modify `api/src/services/digest.ts`, `api/src/routes/admin.ts`, `api/src/app.ts`; Create `api/src/services/digest.test.ts`

**Interfaces:**
- Consumes: `opsEmailShell`, `money`, `detailTable` (Task 2); `QuoteRepo` (`../db/quoteRepo`).
- Produces: `buildDigest(now, { bookings, alertLog?, quotes?, opsBaseUrl? })` — unchanged return shape `{ subject, text, html }`.

- [ ] **Step 1: Write the failing test**

Create `api/src/services/digest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildDigest } from './digest';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import { InMemoryQuoteRepo } from '../db/quoteRepo';

const booking: NewBooking = {
  mode: 'single',
  input: { from: 'CMB', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1,
    customer: { firstName: 'A', lastName: 'B', email: 'a@b.com', whatsapp: '+94', country: 'LK' } },
  total: 6690, amountDueNow: 6690, currency: 'USD',
};

describe('buildDigest', () => {
  it('reports value booked and a quote snapshot, and humanizes alert labels', async () => {
    const bookings = new InMemoryBookingRepo();
    await bookings.create(booking);
    await bookings.create(booking);
    const quotes = new InMemoryQuoteRepo();
    await quotes.save({ channel: 'ops', product: 'private', totalCents: 1000, currency: 'USD', rateCardVersion: 'v1', request: {}, result: {} });
    const alertLog = { countsSince: async () => ({ watchdog_stuck_pending: 1 }) };
    const d = await buildDigest(new Date(), { bookings, quotes, alertLog: alertLog as never });
    expect(d.text).toContain('Value booked (24h): $133.80'); // 2 × $66.90
    expect(d.text).toContain('Quotes created (24h): 1');
    expect(d.text).toContain('Payments stuck in pending: 1'); // humanized, not watchdog_stuck_pending
    expect(d.html).toContain('Ceylon Hop ops'); // rendered through the shell, not a <pre> dump
  });

  it('omits the quote section when no quotes repo is provided', async () => {
    const d = await buildDigest(new Date(), { bookings: new InMemoryBookingRepo() });
    expect(d.text).not.toContain('Quotes created');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/services/digest.test.ts`
Expected: FAIL — no value/quote lines, output is still a `<pre>` dump.

- [ ] **Step 3: Implement the richer digest** (`api/src/services/digest.ts`)

```ts
import type { BookingRepo } from '../db/bookingRepo';
import type { AlertLogRepo } from '../db/alertLogRepo';
import type { QuoteRepo } from '../db/quoteRepo';
import { opsEmailShell, detailTable, money } from './opsEmail';

const ALERT_LABELS: Record<string, string> = {
  watchdog_stuck_pending: 'Payments stuck in pending',
  watchdog_paid_unconfirmed: 'Paid, no confirmation sent',
  payment_failed: 'Payment failed',
};
const alertLabel = (kind: string): string => ALERT_LABELS[kind] ?? kind;

export async function buildDigest(
  now: Date,
  deps: { bookings: BookingRepo; alertLog?: AlertLogRepo; quotes?: QuoteRepo; opsBaseUrl?: string },
): Promise<{ subject: string; text: string; html: string }> {
  const since = new Date(now.getTime() - 24 * 60 * 60_000);
  const all = await deps.bookings.list();
  const recent = all.filter((b) => Date.parse(b.createdAt) >= since.getTime());
  const byStatus = (s: string) => all.filter((b) => b.status === s).length;
  const valueBooked = recent.reduce((sum, b) => sum + b.total, 0);

  const rows: [string, string][] = [
    ['Bookings created (24h)', String(recent.length)],
    ['Value booked (24h)', money(valueBooked, 'USD')],
    ['Now paid', String(byStatus('paid'))],
    ['Confirmed', String(byStatus('confirmed'))],
    ['Payment pending', String(byStatus('payment_pending'))],
  ];

  if (deps.quotes) {
    // QuoteSummary.createdAt is a Date (see db/quoteRepo.ts).
    const q = await deps.quotes.list({ channel: 'ops' });
    const qRecent = q.filter((r) => r.createdAt.getTime() >= since.getTime());
    const qByStatus = (s: string) => q.filter((r) => r.status === s).length;
    rows.push(['Quotes created (24h)', String(qRecent.length)]);
    rows.push(['Open pipeline', `ready: ${qByStatus('ready')} · sent: ${qByStatus('sent')}`]);
  }

  const alertCounts = deps.alertLog ? await deps.alertLog.countsSince(since) : {};
  const alertRows: [string, string][] = Object.entries(alertCounts)
    .filter(([kind]) => kind !== 'ops_digest')
    .sort(([, a], [, b]) => b - a)
    .map(([kind, n]) => [alertLabel(kind), String(n)]);

  const link = (deps.opsBaseUrl || '').trim().replace(/\/+$/, '');
  const textLines = [
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    alertRows.length ? `Alerts fired (24h):\n${alertRows.map(([k, v]) => `  ${k}: ${v}`).join('\n')}` : 'Alerts fired (24h): none',
    ...(link ? ['', `Dashboard: ${link}/ops`] : []),
  ];
  const html = [
    '<h2 style="font-size:18px;margin:0 0 12px">Daily ops digest</h2>',
    detailTable(rows),
    alertRows.length ? `<h3 style="font-size:14px;margin:0 0 8px">Alerts fired (24h)</h3>${detailTable(alertRows)}` : '<p style="font-size:14px;color:#6b7280">No alerts fired in the last 24h.</p>',
    link ? `<p style="margin:16px 0 0"><a href="${link}/ops" style="color:#0a7d6f">Open the ops dashboard</a></p>` : '',
  ].join('');

  const wrapped = opsEmailShell(html, textLines.join('\n'));
  return { subject: `Ceylon Hop ops digest — ${now.toISOString().slice(0, 10)}`, text: wrapped.text, html: wrapped.html };
}
```

- [ ] **Step 4: Wire `quotes` + `opsBaseUrl` into the digest caller**

In `api/src/routes/admin.ts`: add `quotes?: QuoteRepo;` and `opsBaseUrl?: string;` to the `adminRoutes` deps type (import `QuoteRepo` from `../db/quoteRepo`), and pass them at the call site (~line 129):

```ts
const d = await buildDigest(new Date(), { bookings, alertLog: deps.alertLog, quotes: deps.quotes, opsBaseUrl: deps.opsBaseUrl });
```

In `api/src/app.ts`, extend the `adminRoutes({...})` call with:

```ts
      quotes,
      opsBaseUrl: deps.opsBaseUrl ?? config.OPS_BASE_URL,
```

(`quotes` is already constructed in `createApp`; `config.OPS_BASE_URL` is already read for `internalQuoteRoutes`.)

- [ ] **Step 5: Run tests to verify green**

Run: `cd api && npx vitest run src/services/digest.test.ts`
Expected: PASS (2 tests). Then `cd api && npm run check` for the whole suite + typecheck.

- [ ] **Step 6: Commit**

```bash
cd api && npm run check
git add api/src/services/digest.ts api/src/services/digest.test.ts api/src/routes/admin.ts api/src/app.ts
git commit -m "feat(ops): richer daily digest (value, quote snapshot, styled)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Awaiting-approval → all `quote:approve` holders minus actor → Task 1 + Task 3. ✓
- Sent-back → `createdBy` minus actor, with note → Task 3. ✓
- Both fire from the existing PATCH hook, best-effort → Task 3. ✓
- No cost/margin → tests assert no `margin` in the payload (Task 3); shell carries sell figures only. ✓
- Shared shell + `sendQuoteAssigned` adopts it → Task 2. ✓
- Richer digest (value, quote snapshot, humanized alerts, dashboard link, styled) + graceful omit → Task 4. ✓
- `decidedAt`-based "won (24h)" deferred → not built (Open items). ✓
- No schema/migration/pricing/required-config → none introduced. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The `qRecent` filter has a clarifying note directing the implementer to the clean `Date` form.

**Type consistency:** `opsEmailShell`/`heroRef`/`detailTable`/`ctaBlock`/`money`/`esc` names match Task 2 → Tasks 3, 4. `approverOpsUsers` matches Task 1 → Task 3. `sendQuoteAwaitingApproval`/`sendQuoteSentBack` signatures match their senders → PATCH call sites. `buildDigest` deps `{ bookings, alertLog?, quotes?, opsBaseUrl? }` match the admin.ts call site.
