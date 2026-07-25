# Ops Team Emails — Design

**Date:** 2026-07-18
**Status:** drafted — pending owner review
**Phase:** Maintenance (tweaks). Extends the internal-notifications work (spec 2026-07-16,
`opsNotifications.ts` / `digest.ts`).

## Goal

Close the highest-value gaps in **team-facing** email without over-building: make the
maker-checker quote flow visible over email, and turn the daily digest from a monospace dump
into a useful briefing — all by reusing plumbing that already exists.

## Scope

**In (three small changes):**
1. **Two new quote-lifecycle emails** — *awaiting approval* and *sent back for changes* —
   fired from the same place the existing *quote assigned* email is ([internalQuote.ts PATCH
   `/:id`](api/src/routes/internalQuote.ts)).
2. **A shared ops-email shell** so the three quote emails are one visual family instead of
   three hand-rolled HTML blobs.
3. **A richer daily digest** — add value-booked + a quote snapshot, humanize alert labels,
   add a dashboard link, and give it light styling.

**Out (deferred — each needs a *new* trigger/query/cron, i.e. not "simple"):** morning-dispatch
/ tomorrow's-trips, payment-failed/disputed, new-web-lead follow-up, booking-needs-dispatch,
weekly founder summary. Spec these separately if/when wanted.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Both new emails fire from the existing `PATCH /internal/quote/:id` transition hook** (where `sendQuoteAssigned` already fires). | Reuses `deps.email`, `deps.opsBaseUrl`, `deps.auth.opsUsers`, the pre-patch `current` row, and the acting `identity` — zero new wiring. |
| D2 | **Awaiting-approval → all `quote:approve` holders, minus the actor.** | Owner call; nothing waits unseen if one approver is away. Actor-exclusion avoids self-notifying a founder who submits their own quote. |
| D3 | **Sent-back → the quote's `createdBy` (the maker), minus the actor**, carrying the founder's note. | The maker is who must act; the note is the one cross-role message the flow already captures. |
| D4 | **All three are best-effort** (a provider blip must not fail the PATCH), matching `sendQuoteAssigned` today. | The status change is the durable fact; the email is a courtesy. |
| D5 | **No cost/margin in any of them** (assignee/approver may lack `margin:view`). | Same rule the existing assignment email follows — sell total only. |
| D6 | **Shared shell = a thin branded wrapper + a couple of content helpers**, not a template engine. | "Don't over-build": one frame (eyebrow + container + footer) the three emails share; the digest reuses only the wrapper. |
| D7 | **Digest quote metrics use only `QuoteRepo.list()` + in-memory filtering** — quotes *created* in 24h (by `createdAt`) and an open-pipeline snapshot (counts by status). | "Won in 24h" would need a `decidedAt` filter the repo lacks — deferred rather than grow the repo interface. |

## Change 1 — quote-lifecycle emails (`opsNotifications.ts` + the PATCH route)

Two new senders alongside `sendQuoteAssigned`, built on the shared shell (Change 2):

- **`sendQuoteAwaitingApproval(q, approvers, submittedBy, email, opsBaseUrl)`**
  - **Trigger:** in the PATCH handler, after a successful patch where `body.status === 'pending_review'`.
  - **Recipients:** `approverOpsUsers(opsUsers)` (new helper in `opsAuth.ts`, mirrors
    `assignableOpsUsers` but filters on `quote:approve`), excluding the actor's email. Send one
    email per approver (loop; each best-effort).
  - **Subject:** `Quote {ref} needs your approval — Ceylon Hop ops`
  - **Body:** "{submittedBy} submitted a quote for approval." · reference (hero) · Customer /
    Total / Status table · CTA "Review the quote" (deep link, with the same linkless fallback).
- **`sendQuoteSentBack(q, maker, sentBackBy, note, email, opsBaseUrl)`**
  - **Trigger:** after a successful patch where `body.status === 'changes_requested'`.
  - **Recipient:** `current.createdBy` — skip if null or equal to the actor.
  - **Subject:** `Changes requested on quote {ref} — Ceylon Hop ops`
  - **Body:** "{sentBackBy} sent your quote back for changes." · reference (hero) · the note as a
    callout (skip the callout if no note) · CTA "Open the quote".

The route already resolves `current` (pre-patch), `actor`, and `updated`; these calls slot in
next to the existing `sendQuoteAssigned` block, each wrapped in the same best-effort try/catch.

## Change 2 — shared ops-email shell (`opsEmail.ts`, new)

A small module owning the palette (moved from `opsNotifications.ts`) and one wrapper:

```
opsEmailShell(bodyHtml: string, bodyText: string): { html: string; text: string }
```

It wraps the caller's body in the branded container (system font, max-width, `Ceylon Hop ops`
eyebrow, and a one-line footer: "You're on the Ceylon Hop ops team.") and prepends the eyebrow
to the text part. Plus three tiny content helpers the quote emails compose:
`heroRef(ref)`, `detailTable(rows)`, and `ctaBlock(label, href, fallbackText)` (button when
`href`, muted fallback line otherwise). `sendQuoteAssigned` is refactored to build its body from
these + the shell (behaviour unchanged; its test still passes). No other email is touched by
this change beyond the three quote emails.

## Change 3 — richer daily digest (`digest.ts` + `admin.ts` wiring)

`buildDigest(now, { bookings, alertLog?, quotes? })` gains an optional `quotes: QuoteRepo`
(passed from `admin.ts`, which gets `quotes` added to `adminRoutes` deps + `app.ts` wiring).
New content, all from existing repo reads:

- **Value booked (24h):** sum of `total` over bookings created in the last 24h → money.
- **Quote snapshot:** quotes *created* (24h) via `createdAt`; open pipeline `ready: X · sent: Y`
  from status counts (via `quotes.list({ channel: 'ops' })`).
- **Humanized alerts:** map alert `kind`s to friendly labels (e.g. `watchdog_stuck_pending` →
  "Payments stuck in pending"); unknown kinds fall back to the raw key.
- **Dashboard link** to `opsBaseUrl` when set.
- **Light styling:** render through `opsEmailShell` with a simple labelled stat table instead of
  the `<pre>` dump (plaintext stays a clean list). Existing counts (bookings 24h, status
  snapshot, alerts) are preserved.

If `quotes` is not wired (e.g. a caller that doesn't pass it), the quote section is omitted —
the digest degrades gracefully, exactly as it tolerates a missing `alertLog` today.

## Error handling

Every send is best-effort and logged on failure; a provider error never aborts the PATCH or the
digest tick (matches the current `sendQuoteAssigned` / digest contracts). No new failure modes.

## Testing (TDD, red → green)

- **`opsAuth`:** `approverOpsUsers` returns only `quote:approve` holders (founder in; finance/ops
  out) for a mixed OPS_USERS string.
- **`opsNotifications` / route (`internalQuote.test.ts`):** a `→ pending_review` patch emails each
  approver but not the actor, with subject + deep link; a `→ changes_requested` patch emails
  `createdBy` (not the actor) and includes the note; neither carries cost/margin; a provider throw
  doesn't fail the PATCH.
- **`opsEmail`:** shell wraps body + eyebrow + footer in both html and text; `ctaBlock` renders a
  button with a link and a fallback line without one.
- **`digest.test.ts`:** value-booked sums recent bookings; the quote snapshot reflects seeded
  quotes; alert labels are humanized; the section is omitted when `quotes` is absent.

## Rollout

Additive — new senders, one new module, optional digest input. No schema/migration, no pricing,
no config *required* (approver list already lives in `OPS_USERS`; `OPS_BASE_URL` already gates the
deep links). Money-adjacent only in that the digest reports a value total (no writes). Prod effect:
teammates start receiving two more (best-effort) emails and a nicer digest.

## Open items (deferred)

- The bigger ops emails listed under Scope-Out (dispatch, payment-failed, new-lead, weekly).
- "Quotes won (24h)" in the digest — needs a `decidedAt` filter on `QuoteRepo` (own change).
- Channel choice (some of these may serve the team better via WhatsApp/Slack than email).
