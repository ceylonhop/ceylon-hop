# M17 — Observability & Alerting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire error tracking, uptime deep-checks, payment-failure alerting, email-deliverability alerts, and a daily ops digest — all env-gated (dormant until launch keys are set) and email-only per the owner's O1 decision.

**Architecture:** A throttled `AlertAdapter` (email via the existing Resend `EmailAdapter`, DB-backed dedupe in a new `alert_log` table) is the single alert seam. A thin `track()` module is the only file touching `@sentry/node` (env-gated on `SENTRY_DSN`). Client errors beacon to our own `POST /errors/client` (no browser SDK, no DSN in frozen files). The payments watchdog alerts inline from `webhooks.ts` and via an authed idempotent sweep tick. `/health` stays static; `/health/deep` checks the DB.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Vitest · Drizzle/Postgres · `@sentry/node` (only new dep) · node:crypto for Resend webhook HMAC.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-03-m17-observability-design.md` (approved; decisions O1–O8 govern).
- **Rule 4 (CLAUDE.md):** every external behind an adapter with a fake; `track.ts` is the only Sentry-touching module; `EmailAlertAdapter` wraps the existing `EmailAdapter`.
- **Env (all optional → dormant):** `ALERT_EMAIL`, `SENTRY_DSN`, `RESEND_WEBHOOK_SECRET`. Watchdog tick authed by existing `ADMIN_API_KEY`.
- **Throttle default:** one alert per `(kind, dedupeKey)` per **30 min** (`alert_log`, restart-safe). Watchdog thresholds: stuck `payment_pending` > **30 min**; paid-without-confirmation > **15 min**. Client-error beacon: ≤ **2 KB** body, ≤ **5** beacons/page, per-IP rate-limited.
- **Gate:** `cd api && npm run check` green before each PR. Tests first (red→green).
- **Delivery:** PR1 `m17-api-observability` (api/ + migration + docs, no frozen files) → PR2 `m17-fe-error-capture` (labelled `allow-ui-change`, freeze restored).

---

## PR1 — `m17-api-observability`

### Task 1: AlertLog repo (in-memory) + AlertAdapter with throttle

**Files:**
- Create: `api/src/db/alertLogRepo.ts`, `api/src/adapters/alerts.ts`
- Test: `api/src/adapters/alerts.test.ts`, `api/src/db/alertLogRepo.test.ts`

**Interfaces (produced, used by every later task):**
```ts
// alertLogRepo.ts
export interface AlertLogRepo {
  // Atomically: if no row for (kind,dedupeKey) or last_sent_at older than cooldownMs → set last_sent_at=now, return true (send).
  // Else increment count, return false (suppressed).
  shouldSend(kind: string, dedupeKey: string, cooldownMs: number, now: Date): Promise<boolean>;
  // last-24h counts per kind, for the digest
  countsSince(since: Date): Promise<Record<string, number>>;
}
export class InMemoryAlertLogRepo implements AlertLogRepo { /* Map-backed */ }

// alerts.ts
export type AlertSeverity = 'critical' | 'warning' | 'info';
export interface Alert { severity: AlertSeverity; kind: string; title: string; body: string; dedupeKey?: string; }
export interface AlertAdapter { send(a: Alert): Promise<void>; }
export class FakeAlertAdapter implements AlertAdapter { readonly sent: Alert[] = []; }
export class LogAlertAdapter implements AlertAdapter { /* console.error one line */ }
export class EmailAlertAdapter implements AlertAdapter { constructor(email: EmailAdapter, to: string) {} }
// The throttling wrapper every caller actually gets:
export class ThrottledAlerts implements AlertAdapter {
  constructor(inner: AlertAdapter, log: AlertLogRepo, opts?: { cooldownMs?: number; now?: () => Date });
  // dedupeKey defaults to kind; send() never throws (alerting must never break a request path)
}
```

- [ ] **Step 1: failing tests** — `alerts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FakeEmailAdapter } from './email';
import { EmailAlertAdapter, FakeAlertAdapter, ThrottledAlerts } from './alerts';
import { InMemoryAlertLogRepo } from '../db/alertLogRepo';

describe('EmailAlertAdapter', () => {
  it('formats severity + kind into a compact email to ALERT_EMAIL', async () => {
    const email = new FakeEmailAdapter();
    await new EmailAlertAdapter(email, 'ops@ceylonhop.com').send({
      severity: 'critical', kind: 'webhook_signature', title: 'PayHere signature failed', body: 'ref CH-XXX',
    });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe('ops@ceylonhop.com');
    expect(email.sent[0].subject).toContain('[CRITICAL]');
    expect(email.sent[0].subject).toContain('PayHere signature failed');
    expect(email.sent[0].text).toContain('ref CH-XXX');
  });
});

describe('ThrottledAlerts', () => {
  const mk = (nowMs: { t: number }) => {
    const inner = new FakeAlertAdapter();
    const alerts = new ThrottledAlerts(inner, new InMemoryAlertLogRepo(), { cooldownMs: 30 * 60_000, now: () => new Date(nowMs.t) });
    return { inner, alerts };
  };
  const a = { severity: 'critical' as const, kind: 'k', title: 't', body: 'b', dedupeKey: 'x' };

  it('sends the first alert, suppresses repeats inside the cooldown', async () => {
    const now = { t: 0 }; const { inner, alerts } = mk(now);
    await alerts.send(a); await alerts.send(a);
    now.t = 29 * 60_000; await alerts.send(a);
    expect(inner.sent).toHaveLength(1);
  });
  it('sends again after the cooldown', async () => {
    const now = { t: 0 }; const { inner, alerts } = mk(now);
    await alerts.send(a); now.t = 31 * 60_000; await alerts.send(a);
    expect(inner.sent).toHaveLength(2);
  });
  it('different dedupeKeys are independent', async () => {
    const now = { t: 0 }; const { inner, alerts } = mk(now);
    await alerts.send(a); await alerts.send({ ...a, dedupeKey: 'y' });
    expect(inner.sent).toHaveLength(2);
  });
  it('never throws even when the inner adapter does', async () => {
    const boom: any = { send: async () => { throw new Error('smtp down'); } };
    const alerts = new ThrottledAlerts(boom, new InMemoryAlertLogRepo());
    await expect(alerts.send(a)).resolves.toBeUndefined();
  });
});
```

`alertLogRepo.test.ts`: shouldSend true→false-within-cooldown→true-after; countsSince aggregates suppressed counts by kind.

- [ ] **Step 2: red** — `cd api && npx vitest run src/adapters/alerts.test.ts src/db/alertLogRepo.test.ts` → modules missing.
- [ ] **Step 3: implement** both files exactly to the interfaces above (email subject `[CRITICAL] <title> — Ceylon Hop ops`, text body = kind + body + timestamp; ThrottledAlerts wraps `inner.send` in try/catch + `console.error` on failure).
- [ ] **Step 4: green**, then commit `feat(api): throttled alert adapter (email via Resend seam) + alert log (M17 T1)`.

### Task 2: `alert_log` table (migration 0011) + Postgres repo

**Files:**
- Modify: `api/src/db/schema.ts` (add table), Create: `api/src/db/postgresAlertLogRepo.ts`, generated `api/drizzle/0011_*.sql`
- Test: extend `api/src/db/postgres.test.ts` following the existing pattern (skipped without `DATABASE_URL_TEST`)

```ts
// schema.ts addition
export const alertLog = pgTable('alert_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull(),
  count: integer('count').notNull().default(1),
}, (t) => [unique().on(t.kind, t.dedupeKey)]);
```

- [ ] Add table → `npm run db:generate -- --name m17_alert_log` → migration `0011_m17_alert_log.sql` appears.
- [ ] `PostgresAlertLogRepo.shouldSend` = single atomic `INSERT … ON CONFLICT (kind, dedupe_key) DO UPDATE` statement: on conflict, `count = count+1` and `last_sent_at = CASE WHEN excluded-cooldown-passed THEN now ELSE keep END`, `RETURNING` whether it sent (compare returned last_sent_at to now). Postgres test: two rapid calls → one send; time-shifted call → sends.
- [ ] Green (postgres tests via `DATABASE_URL_TEST` if configured locally; CI runs them) → commit `feat(api): alert_log migration 0011 + Postgres repo (M17 T2)`.

### Task 3: `track()` (Sentry, env-gated) + `app.onError` alerting

**Files:**
- Create: `api/src/observability/track.ts`; Modify: `api/src/app.ts` (onError), `api/src/server.ts` (init), `api/src/config.ts` (+`SENTRY_DSN`, `ALERT_EMAIL`, `RESEND_WEBHOOK_SECRET`), `api/package.json` (+`@sentry/node`)
- Test: `api/src/observability/track.test.ts`, extend an app-level test for onError alert

**Interfaces:**
```ts
// track.ts — the ONLY module importing @sentry/node
export function initTracking(dsn: string | undefined, opts: { environment: string; release?: string }): void; // no-op when !dsn
export function track(err: unknown, ctx?: { route?: string; tag?: string; extra?: Record<string, unknown> }): void; // never throws; no-op unless initTracking ran with a dsn
export function _resetForTests(): void;
```

- [ ] Tests: `track()` before init → no throw; `initTracking(undefined)` → `track()` still no-op; with a fake transport injected via `Sentry.init({ transport })` capture → event recorded with tag/route. (If transport injection is brittle, assert via `_getState()` test hook that init happened and capture was invoked on a spy.)
- [ ] `app.onError`: keep the 500 body identical; add `track(err, { route: c.req.path })` + `alerts.send({ severity:'critical', kind:'api_error', title: err.name…, dedupeKey: err.name + ':' + c.req.path })`. `createApp` deps gain `alerts: AlertAdapter` (tests pass `FakeAlertAdapter`; default to `LogAlertAdapter` if omitted so existing tests don't all change).
- [ ] `server.ts`: `initTracking(config.SENTRY_DSN, { environment: config.NODE_ENV, release: process.env.RENDER_GIT_COMMIT })`; build `alerts = new ThrottledAlerts(config.ALERT_EMAIL ? new EmailAlertAdapter(email, config.ALERT_EMAIL) : new LogAlertAdapter(), new PostgresAlertLogRepo(db))` and pass to createApp.
- [ ] App test: route that throws → response 500 unchanged + FakeAlertAdapter got 1 alert; second throw same route → still 1 (throttled).
- [ ] Green → commit `feat(api): env-gated Sentry tracking + alerting on unhandled API errors (M17 T3)`.

### Task 4: `POST /errors/client`

**Files:** Create `api/src/routes/clientErrors.ts`; Modify `api/src/app.ts` (mount + rate limit). Test: `api/src/routes/clientErrors.test.ts`.

- Zod body: `{ message: string.max(500), stack?: string.max(1500), url?: string.max(300), ua?: string.max(300) }`; content-length gate 2 KB → 413; always responds **204** on accepted, 400 on invalid, never 500 (wrap handler). Forwards `track(new Error(message), { tag:'frontend', extra:{stack,url,ua} })` + `alerts.send({ severity:'warning', kind:'client_error', dedupeKey: sha1(message).slice(0,12) … })`. Mount under the existing public `rateLimit` middleware like `/quote`.
- Tests: valid → 204 + alert recorded; invalid body → 400; >2 KB → 413; two same-message posts → 1 alert (throttle); alert adapter throwing → still 204.
- Commit `feat(api): client error beacon endpoint → track + throttled alert (M17 T4)`.

### Task 5: webhook inline alerts + confirmation logged

**Files:** Modify `api/src/routes/webhooks.ts`, `api/src/db/notificationLogRepo.ts` (kind union + `'confirmation'`); Test: extend `api/src/routes/webhooks.test.ts`.

- `NotificationKind = 'trip_reminder' | 'review_request' | 'confirmation'`.
- webhooks deps gain `alerts` + `notificationLog`. On: invalid signature → alert `payhere_signature` (dedupe by day); amount mismatch → alert `payhere_amount` (dedupe by booking ref); confirmation email success → `notificationLog.markSent(booking.id,'confirmation')`; failure → existing console.error + alert `confirmation_email_failed` (dedupe by ref).
- Tests: each path asserts the alert (FakeAlertAdapter) and, for success, the log row; response codes unchanged.
- Commit `feat(api): payment webhook failure alerts + confirmation send logging (M17 T5)`.

### Task 6: watchdog sweep + admin tick

**Files:** Create `api/src/jobs/watchdog.ts`; Modify `api/src/routes/admin.ts` (`POST /jobs/watchdog`); Test: `api/src/jobs/watchdog.test.ts`.

```ts
export async function runWatchdog(now: Date, deps: { bookings: BookingRepo; log: NotificationLogRepo; alerts: AlertAdapter }):
  Promise<{ stuckPending: number; paidUnconfirmed: number }>;
```
- stuck: `bookings.list({status:'payment_pending'})` where `createdAt < now-30min` → alert per booking `watchdog_stuck_pending` dedupe=booking.id.
- unconfirmed: `list({status:'paid'})` where `createdAt < now-15min` and `!await log.wasSent(id,'confirmation')` → alert `watchdog_paid_unconfirmed` dedupe=booking.id.
- Route: authed like `/jobs/notifications`, returns counts; sweep failure inside route → 500 with alert attempt but never crash.
- Tests: seeded in-memory bookings + fake clock cover: fresh pending (no alert), old pending (alert), old paid w/ confirmation logged (no alert), old paid w/o (alert), dedupe across two runs (throttle) — assert counts + FakeAlertAdapter contents.
- Commit `feat(api): payments watchdog sweep + authed cron tick (M17 T6)`.

### Task 7: `/health/deep`

**Files:** Modify `api/src/app.ts` (+ route; deps gain optional `pingDb?: () => Promise<void>`), `api/src/server.ts` (pass `pingDb: () => sql\`SELECT 1\``-equivalent via client). Test: app-level.
- `/health` unchanged. `/health/deep`: pingDb ok → 200 `{status:'ok',db:'ok'}`; throws → 503 `{status:'degraded',db:'down'}` (+ throttled critical alert `db_down`). Without pingDb dep (unit tests/dev in-memory) → 200 `{status:'ok',db:'skipped'}`.
- Commit `feat(api): /health/deep DB check for the uptime monitor (M17 T7)`.

### Task 8: Resend deliverability webhook

**Files:** Modify `api/src/routes/webhooks.ts` (`POST /webhooks/resend`); config already has `RESEND_WEBHOOK_SECRET` (T3). Test: extend `webhooks.test.ts`.
- Disabled (404) when secret unset. Verify svix HMAC with node:crypto: `signedContent = \`${svix-id}.${svix-timestamp}.${rawBody}\``, key = base64-decode of secret after `whsec_`, expect `v1,<base64 hmac-sha256>` ∈ `svix-signature` header; reject 401 otherwise; reject stale timestamp (>5 min skew).
- On `email.bounced` / `email.complained` → alert `email_bounce` (warning, dedupe=recipient) with recipient+subject. Other events → 204.
- Tests: unset secret → 404; bad sig → 401; good sig bounce → 204 + alert; delivered event → 204 no alert.
- Commit `feat(api): Resend bounce/complaint webhook → alerts (M17 T8)`.

### Task 9: daily ops digest + docs + PR1

**Files:** Create `api/src/jobs/digest.ts`; Modify `api/src/routes/admin.ts` (ride the notifications tick, best-effort), `docs/go-live-checklist.md` (env rows + launch steps per spec “At launch”), `docs/observability-plan.md` (status: built). Test: `api/src/jobs/digest.test.ts`.
- `buildDigest(now, {bookings, alertLog}): Promise<{subject,text}>` — counts created/paid/cancelled last 24 h (from `list()` + createdAt; status counts) + `alertLog.countsSince(now-24h)`. `admin.ts`: after notifications run, `if (alertEmailConfigured) try { email.send(digest) } catch { console.error }` — gated so it only mails when `ALERT_EMAIL` set (dep `digestTo?: string`).
- Tests: digest content from seeded repos; notifications tick still returns its result when digest send throws.
- Full gate `npm run check` green → push branch → `gh pr create` (no label needed) → merge on green CI.

---

## PR2 — `m17-fe-error-capture`

### Task 10: beacon snippet — generated pages + frozen pages (labelled unfreeze)

**Files:**
- Modify: `tools/site-chrome.mjs` (export `errorBeaconSnippet`; include in `headAssets`), regenerate `trip/**` + terms/privacy/404 (`npm run generate`)
- Modify (unfreeze): the 9 frozen page heads (`index, about, blog, booking, plan, search, tour, tours, why`) + `.claude/hooks/protect-ui.sh` / `.claude/settings.json` temporarily (restore after, exactly the M16 PR3 procedure)
- Test: `web-tests/unit/seo-error-beacon.test.js` (snippet present on all pages; codegen test re-covers generated ones), `web-tests/e2e/error-beacon.spec.js`

Snippet (inline, ~same on all pages; `API` resolves like booking.html does — `window.CEYLON_HOP_API` default Render URL):
```html
<script>
(function(){var n=0,A=(window.CEYLON_HOP_API||'https://ceylon-hop-api.onrender.com');
function r(m,s){if(n>=5)return;n++;try{var b=JSON.stringify({message:String(m).slice(0,500),stack:String(s||'').slice(0,1500),url:location.href.slice(0,300),ua:navigator.userAgent.slice(0,300)});(navigator.sendBeacon&&navigator.sendBeacon(A+'/errors/client',new Blob([b],{type:'application/json'})))||fetch(A+'/errors/client',{method:'POST',headers:{'content-type':'application/json'},body:b,keepalive:true}).catch(function(){})}catch(e){}}
window.addEventListener('error',function(e){r(e.message,e.error&&e.error.stack)});
window.addEventListener('unhandledrejection',function(e){var x=e.reason||{};r(x.message||String(x),x.stack)});})();
</script>
```
- [ ] web-tests unit red → add snippet to `site-chrome.mjs` `headAssets` + regenerate → frozen heads under unfreeze → green (unit asserts all 9 + samples of generated).
- [ ] e2e: stub `/errors/client` route in Playwright, inject a throwing script on a route page, assert one beacon request; assert cap (force 7 errors → ≤5 beacons).
- [ ] Restore freeze; full `web-tests npm run test:all` + hook self-test green; PR with `allow-ui-change` label; merge on green.

---

## Self-review
- **Spec coverage:** O1 email adapter (T1) · O2 Sentry gated (T3) · O3/O4 FE beacon (T4+T10) · O5 alert_log throttle (T1/T2) · O6 health/deep (T7) · O7 watchdog tick (T6) · O8 digest + no-logging-scope (T9). Resend webhook (T8). Checklist/launch steps (T9). Migration 0011 (T2).
- **Placeholders:** none; all thresholds/limits from the spec's Global Constraints.
- **Type consistency:** `AlertAdapter.send(Alert)`, `AlertLogRepo.shouldSend/countsSince`, `track/initTracking`, `runWatchdog` signatures used consistently across tasks.
