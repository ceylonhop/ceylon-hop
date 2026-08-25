# Branded short links for customer quotes and payments

**Date:** 2026-08-24
**Status:** approved for implementation; Step 1 is the current scoped build
**Scope:** newly minted customer quote and quote-payment links only

## 1. Problem

Ceylon Hop sends quote and payment links manually through WhatsApp. The links are secure and
already use compact binary tokens, but they are still about 80 characters long:

```text
https://quote.ceylonhop.com/q?t=<signed-token>
https://pay.ceylonhop.com/p?t=<signed-token>
```

In a WhatsApp message they wrap across multiple lines and resemble machine-generated or phishing
links. That weakens trust at the moment a customer is reviewing a trip or being asked to pay.

The existing packed-token work solved the technical length problem—the original payment URL was
about 208 characters—but it did not solve the actual sharing presentation. The product requirement
is therefore a visibly short, branded URL, not another small reduction in token size.

## 2. Goals

1. Every newly copied quote link is at most 46 characters and uses `quote.ceylonhop.com`.
2. Every newly copied payment link is at most 44 characters and uses `pay.ceylonhop.com`.
3. The existing **Quote link** and **Payment link** buttons copy the short form automatically; ops
   gains no extra steps.
4. A short link preserves all current quote-following, payment-pinning, expiry, revision, partial-leg,
   soft-delete and paid-state behaviour.
5. Every long link already sent to a customer continues to work unchanged.
6. No customer data, quote reference, database ID, price, revision or sequence is exposed in the
   short code.
7. Before production activation, the short URL and its existing share card are proven in the real
   WhatsApp workflow against a screenshot of the current long-link baseline.

Target forms:

```text
https://quote.ceylonhop.com/s/7Hk3pQ9mXs4aBcDe
https://pay.ceylonhop.com/s/N4t8Kq2vWd6pRtYu
```

## 3. Non-goals

- **No third-party shortener.** Bitly and similar services add an external dependency, weaken the
  branded trust signal and place a payment capability in another provider's control.
- **No vanity or human-chosen codes.** Customer names, quote references and sequential IDs are
  enumerable and are not safe bearer capabilities.
- **No change to quote or payment semantics.** The quote link still follows the current quote; the
  payment link still pins one quote revision and one pay-link selection sequence.
- **No replacement of the existing signed-token routes.** `/q?t=...` and `/p?t=...` remain the
  canonical customer pages and the backwards-compatible long-link entry points.
- **No shortening of booking-management, ride-board or staff Ops links in this version.** Each has a
  different security/liveness contract and should be assessed separately.
- **No click analytics or short-link management UI.** Existing page analytics remain authoritative.
- **No direct page rendering at the short path in v1.** The short path redirects to the existing
  customer page. Keeping the short URL in the browser address bar is a possible later improvement.

## 4. User stories

1. As an ops teammate, I want the existing link button to copy a clean branded URL so that I can
   paste it into WhatsApp without editing or hiding it.
2. As a customer, I want a short recognisably Ceylon Hop link so that I can trust what I am opening.
3. As a customer holding an older long link, I want it to continue working so that a deployment does
   not strand me mid-quote or mid-payment.
4. As an ops teammate re-copying the same unchanged link, I want the same short URL again so that the
   customer does not accumulate different links to the same thing.
5. As a customer opening a retired payment link, I want the existing safe revised/unavailable state,
   never a payment page for a changed price.

## 5. Decisions

### D1 — App-owned aliases, not shorter signed payloads

The current tokens carry the minimum data needed to verify a link without storage: purpose, UUID and,
for payments, revision and selection sequence, plus a 128-bit HMAC. A visibly shorter self-contained
token would have to omit target data or reduce its authentication strength.

The short URL is therefore an opaque alias stored in Postgres. Resolving it produces the existing
signed link; the current verifier remains the final security and liveness gate.

### D2 — A 16-character, 96-bit deterministic code

The code is 12 bytes of a domain-separated HMAC encoded as unpadded base64url:

```text
base64url(HMAC-SHA256(BOOKING_LINK_SECRET, semantic_key)[0..12])
```

This yields exactly 16 URL-safe characters and 96 bits of unguessability. A 96-bit random capability
is infeasible to enumerate at Ceylon Hop's scale, and the public resolver is rate-limited as defence in
depth. The full HMAC is never returned or stored.

This is an explicit security-versus-presentation decision: the public capability drops from the signed
token's 128-bit authentication strength to 96 bits in exchange for a six-character shorter code. The
existing 128-bit signed token is still rebuilt after resolution and remains the downstream authority.
At Ceylon Hop's traffic level, 96 bits plus online rate limiting is an acceptable capability strength;
it is not described as equivalent to 128 bits.

Domain-separated semantic keys:

```text
short:v1:quote-view:<quote_uuid>
short:v1:quote-pay:<quote_uuid>:r<revision>:s<selection_seq>
```

Consequences:

- Re-minting the same semantic link returns the same code.
- Quote edits do not change the quote-view code, matching the existing following-link contract.
- A payment revision or selection change produces a different code, matching the existing pinned-link
  contract.
- Domain separation makes quote and payment outputs independent. A theoretical 96-bit truncation
  collision remains possible; the database uniqueness constraint detects it and minting fails closed.
- No new production secret is required. Domain separation prevents this use from crossing with the
  existing signed-token purposes.

### D3 — Store only a digest of the code

Postgres stores `SHA-256(code)`, never the bearer code itself. Minting can reproduce the code from the
semantic key, while resolution hashes the presented code and performs an indexed lookup. A database
read alone therefore does not reveal usable customer links.

There is deliberately no uniqueness constraint on the semantic fields. If `BOOKING_LINK_SECRET` is
ever rotated, a newly minted code may coexist with the old digest; links already sent continue to
resolve. Under an unchanged secret, insertion is naturally idempotent on `code_digest`.

### D4 — Redirect into the existing flow

```text
Ops presses Quote link / Payment link
  -> existing mint endpoint validates and stamps the quote exactly as today
  -> derive short code and idempotently persist its digest + target metadata
  -> return https://<correct-host>/s/<code>

Customer or WhatsApp crawler opens /s/<code>
  -> validate code shape
  -> SHA-256(code) lookup
  -> rebuild the existing signed token from stored target metadata
  -> 302 to /q?t=<quote-view-token> or /p?t=<quote-pay-token>
  -> existing page, projection, OG card and payment safeguards run unchanged
```

The redirect is intentionally thin. It must not reproduce quote state logic, payment state logic,
customer projections or share-card generation.

### D5 — Existing liveness rules remain authoritative

The alias row does not carry an independent expiry or active flag.

- Quote-view liveness remains status-driven (`ready|sent`, lapsed, won/booked, unavailable) and follows
  the current quote.
- Payment liveness remains pinned to quote revision and selection sequence and is payable only in the
  existing allowed states.
- Lost, expired, won, revised, re-selected, deleted and already-paid behaviour is decided downstream by
  the existing routes.

This prevents two state machines from drifting.

### D6 — Old URLs stay first-class

The existing `/q?t=` and `/p?t=` handlers and all current token verification remain unchanged. No
backfill is required. Only new mint responses switch to `/s/<code>`.

### D7 — Resolver first, minting second, activation last

The resolver must be deployed before any customer can receive a short link. Mint output is controlled
by a validated `CUSTOMER_SHORT_LINKS_ENABLED` configuration flag that defaults to `false`.

- Flag off: the existing mint endpoints return their current long URLs and create no alias.
- Flag on: the same endpoints persist the alias and return `/s/<code>`.
- The resolver is never disabled by this flag. Turning minting off cannot strand short links already
  sent to customers.

This is both the rollout and rollback mechanism. Production stays off until staging has passed the real
WhatsApp checkpoint.

## 6. Data model

Add `customer_short_links`:

| Column | Type | Rules |
|---|---|---|
| `id` | uuid | primary key, `gen_random_uuid()` |
| `code_digest` | text | required, unique; lowercase SHA-256 hex |
| `kind` | text | required; `quote_view` or `quote_pay` |
| `quote_id` | uuid | required FK to `quotes.id`, on delete cascade |
| `quote_revision` | integer | required for `quote_pay`; null for `quote_view`; minimum 1 |
| `pay_link_seq` | integer | required for `quote_pay`; null for `quote_view`; minimum 0 |
| `created_at` | timestamptz | required, default now |

Database checks enforce the two legal shapes:

```text
quote_view => quote_revision IS NULL AND pay_link_seq IS NULL
quote_pay  => quote_revision >= 1 AND pay_link_seq >= 0
```

Indexes:

- unique index on `code_digest` for resolution and collision refusal;
- index on `quote_id` for support/debugging and cascade maintenance.

No raw code, signed token, customer data, amount or destination URL is stored.

The migration must enable PostgreSQL row-level security on `customer_short_links`. It creates no policy
for Supabase `anon` or `authenticated` roles and grants them no table access. Only the backend database
role may read or write the table. The repository must be the sole application access path, and the
existing RLS schema test must cover the new table.

## 7. Interfaces

### 7.1 Repository

Add a narrow repository with an in-memory fake and Postgres implementation:

```ts
type CustomerShortLinkTarget =
  | { kind: 'quote_view'; quoteId: string }
  | { kind: 'quote_pay'; quoteId: string; revision: number; seq: number };

interface CustomerShortLinkRepo {
  put(codeDigest: string, target: CustomerShortLinkTarget): Promise<void>;
  getByDigest(codeDigest: string): Promise<CustomerShortLinkTarget | null>;
}
```

`put` is idempotent when the digest and target match. A digest already attached to a different target
is a collision and must fail closed, be reported, and never overwrite the existing row.

### 7.2 Pure code helper

Add pure helpers for:

- semantic-key construction;
- deterministic code derivation;
- SHA-256 digesting;
- strict code validation (`^[A-Za-z0-9_-]{16}$`).

Tests inject a secret and do not depend on real randomness or time.

### 7.3 Mint responses

The existing routes retain their method, authentication, CSRF and response shape:

```text
POST /admin/quote/:id/quote-link
POST /admin/quote/:id/pay-link
```

Only `url` changes from the long form to the short form. All existing side effects—customer-total
stamping, partial selection persistence and `payLinkSeq` handling—must complete before deriving the
target.

The Ops UI already copies the returned `url`, so no front-end change is required.

### 7.4 Public resolver

```text
GET /s/:code
```

Behaviour:

1. Reject a malformed code without a database lookup.
2. Hash the valid code and load its target by digest.
3. Rebuild the appropriate existing token with `BOOKING_LINK_SECRET`.
4. Redirect with `302 Found` to the correct configured origin and page:
   - `quote_view` -> `${QUOTE_BASE_URL}/q?t=<token>`
   - `quote_pay` -> `${PAY_BASE_URL}/p?t=<token>`
5. Send `Cache-Control: no-store` on the resolver response.

Because the same service answers multiple custom domains, the stored `kind`, not the incoming Host
header, decides the canonical destination. Opening a valid payment code on the quote hostname still
lands on `pay.ceylonhop.com`, and vice versa.

Malformed or unknown codes must expose no quote detail. Their result is determined only by the incoming
hostname, because there is no stored target to identify their kind:

- `quote.ceylonhop.com` -> `302` to the existing generic quote-unavailable experience;
- `pay.ceylonhop.com` -> `302` to the existing generic payment-unavailable experience;
- every other hostname, including the Render and Ops hosts -> generic `404` with
  `Cache-Control: no-store`.

A database outage is different from an invalid link: return a generic retryable `503` rather than
telling a customer that a valid quote has expired.

The route uses the existing public-link rate limiter. It must never log the raw code or the rebuilt
signed token in application logs or error reports.

### 7.5 Activation configuration

`CUSTOMER_SHORT_LINKS_ENABLED` is parsed by `config.ts`, defaults to `false`, and is threaded to the
mint routes. It does not guard `GET /s/:code`. Tests cover an unset value, explicit false and explicit
true; production cannot accidentally activate because an arbitrary non-empty string was treated as
truthy.

## 8. Functional requirements and acceptance criteria

### P0 — Must ship

#### R0. Real WhatsApp activation gate

- The foundation may be built and deployed before this check, but production minting remains disabled.
- With staging minting enabled, send one short quote link and one short payment link through the same
  WhatsApp workflow ops uses in production.
- WhatsApp must keep the pasted message URL in its short form, follow the redirect, and render the
  existing correct preview card.
- At the same chat width and font size, each short URL must occupy fewer visible lines than its current
  long-link baseline. A one-line result is desirable but is not promised without measurement.
- Capture owner-approved mobile and desktop screenshots. If the redirect is exposed as the long URL or
  the preview fails, do not enable production; revise the design before proceeding.

#### R1. Short quote link

- Given an approved `ready` or `sent` quote,
- when ops presses **Quote link**,
- then the copied URL matches `https://quote.ceylonhop.com/s/[A-Za-z0-9_-]{16}` and is no more than
  46 characters.
- Opening it renders the same current quote as the existing long quote link.
- Re-copying after an ordinary quote edit returns the same short URL and displays the updated quote.

#### R2. Short payment link

- Given an eligible approved quote,
- when ops presses **Payment link**,
- then the copied URL matches `https://pay.ceylonhop.com/s/[A-Za-z0-9_-]{16}` and is no more than
  44 characters.
- Opening it reaches the existing pay page for the exact quote revision and selection sequence.
- Re-copying without a revision or selection change returns the same URL.
- Changing quote content or the partial-leg selection creates a different URL, and the old URL reaches
  the existing revised/unavailable state rather than charging the new amount.

#### R3. Compatibility

- Long quote and pay links minted before deployment still render exactly as before.
- No existing token verifier or customer endpoint is removed.
- No DNS, new domain, new external service or new secret is required.

#### R4. Preview preservation

- WhatsApp/social crawler requests must follow the redirect and receive the existing quote or pay OG
  metadata and image.
- The payment share card continues to omit the amount.
- Invalid short codes produce the same generic, non-probing preview behaviour as invalid long tokens.

#### R5. Failure safety

- Invalid shape -> no lookup and no customer detail.
- Unknown digest -> generic unavailable experience.
- Alias collision -> mint fails closed; it never repoints an existing code.
- Repository failure -> no false “expired” result and no unsafe long-token logging.
- The payment mint cannot return any link until its existing quote/selection writes have succeeded.
- Supabase anonymous and authenticated roles cannot select, insert, update or delete alias rows.

#### R6. Safe activation and rollback

- Resolver deployment precedes mint activation.
- Production defaults to long links until the flag is explicitly enabled.
- Disabling the flag immediately returns new mints to long URLs without disabling any existing short
  URL.
- A normal deployment rollback must target the resolver-capable foundation release, never a release
  from before `/s/:code` existed.

### P1 — Fast follow

- Add an internal, redacted diagnostic showing short-link kind, quote reference and creation time for
  support. Never show or recover the raw code.
- Add a resolver error-rate dashboard if production traffic makes aggregate route monitoring useful.

### P2 — Future consideration

- Serve the customer page directly at `/s/:code` so the browser address bar remains short after open.
- Assess whether booking-management and ride-board links need the same treatment.
- Consider a dedicated short-link key with explicit key versions if routine secret rotation becomes a
  requirement.

## 9. Security and privacy

- A short code is a bearer capability and must be protected exactly like the current signed token.
- 96 bits of HMAC-derived entropy plus rate limiting makes online enumeration infeasible.
- Codes are non-semantic and reveal no ordering, volume, identity, itinerary or value.
- Only a SHA-256 digest is stored, so a database reader cannot copy usable links.
- HMAC input is domain-separated by version and kind.
- Digest collisions never overwrite or retarget an existing row.
- RLS is enabled with no public policy or grant for the alias table.
- The resolver returns no customer projection; it delegates to the existing margin-safe public routes.
- Existing status, revision, sequence and payment checks remain the final authority.
- Resolver responses are `no-store`; existing customer-page cache rules continue to apply.
- Raw codes and rebuilt signed tokens are redacted from application errors and structured logs.

## 10. Testing strategy

All tests are network-free and use the in-memory repository or the existing test Postgres.

### Unit

- Code is exactly 16 base64url characters.
- Same semantic target + secret -> identical code.
- Quote view code is unchanged by quote revision because revision is not in its semantic key.
- Quote/pay kind, quote ID, revision or sequence change -> different code.
- Malformed codes are rejected before lookup.
- Digest is stable and never equals the raw code.

### Repository integration

- Insert then resolve by digest.
- Repeated identical insert is idempotent.
- Same digest with a different target fails and does not mutate the row.
- Both legal row shapes round-trip.
- Illegal kind/revision/sequence combinations fail database checks.
- Deleting a quote cascades its aliases.
- RLS is enabled and no public policy exposes the table.

### HTTP

- Quote mint returns the short branded URL and its resolver redirects to a valid `/q?t=` target.
- Payment mint returns the short branded URL and its resolver redirects to a valid `/p?t=` target.
- Full and partial payment targets preserve `revision` and `seq` exactly.
- Re-mint stability for both kinds.
- Quote edit: quote short code stable; rendered content follows.
- Payment edit/re-selection: new short code; old code cannot pay the changed selection.
- Cross-host open redirects to the host dictated by kind.
- Unknown/malformed codes leak no quote data and follow the exact quote-host, pay-host and other-host
  responses defined in §7.4.
- Database failure returns retryable `503`.
- Resolver response carries `Cache-Control: no-store`.
- Existing long-link compatibility suites remain green.
- Existing OG/share-card tests pass when reached through a followed short redirect.
- Mint output remains long while the activation flag is unset or false and becomes short only when it
  is explicitly true.
- The resolver continues to work with the activation flag off.

### End-to-end

- In the real Ops UI, **Quote link** copies a short URL and opens the correct proposal.
- **Payment link** copies a short URL and opens the correct checkout without starting a charge.
- WhatsApp preview is checked manually for both links at the same widths as the baseline screenshot;
  both short URLs occupy fewer lines, and production activation remains blocked until the owner signs
  off.

## 11. Implementation scope

This feature is two build-plan steps, two branches and two PRs. Each step is independently green and
deployable.

### Step 1 — Short-link foundation

Build only:

1. Forward-only migration and Drizzle schema for `customer_short_links`, including checks, indexes,
   RLS and no public policies/grants.
2. In-memory and Postgres `CustomerShortLinkRepo` implementations.
3. Pure short-code/digest helper.
4. `GET /s/:code` resolver with exact host-specific invalid-code behaviour.
5. Unit, DB integration and HTTP coverage for the foundation.

The existing mint endpoints must remain byte-for-byte compatible in this step. Deploy this step before
starting activation work.

### Step 2 — Mint integration and controlled activation

Build only:

1. Validated `CUSTOMER_SHORT_LINKS_ENABLED` config, default off.
2. Wiring into the two existing mint endpoints.
3. Flag-off, flag-on, compatibility, revision/selection and focused Ops E2E coverage.
4. Staging activation and the real WhatsApp human checkpoint.
5. Production activation only after owner sign-off.

Do not change customer page design, payment calculation, quote state transitions, PayHere integration,
Ops button layout, share-card content or any other link type.

## 12. Rollout and rollback

### Rollout

1. Merge and deploy Step 1: migration, repository and resolver. Confirm existing long links are
   unchanged.
2. Verify the resolver technically with automated tests and a staging alias fixture.
3. Merge and deploy Step 2 with production flag off and staging flag on.
4. Mint one staging quote link and one staging payment link; perform the real WhatsApp screenshot and
   preview checkpoint.
5. If the checkpoint passes, enable the production flag and restart the service.
6. Mint fresh production links from Ops and verify both custom hosts.
7. Leave the resolver, table and all old routes enabled permanently.

No backfill is needed because rows are created lazily when ops next copies a link.

### Rollback

Turn `CUSTOMER_SHORT_LINKS_ENABLED` off first. New mints immediately return the existing long URL while
already-created `/s/` links continue resolving. If a code rollback is required, roll back Step 2 only or
deploy from the Step 1 foundation release. Never roll the service back past Step 1 after any short link
has been sent. The table and resolver remain permanently; unused rows are harmless.

## 13. Success measures

Evaluate after 30 days:

- While the production flag is enabled, 100% of newly minted quote/payment URLs use
  `/s/<16-character-code>`.
- 100% of legacy long-link regression tests remain green.
- Zero incidents where a short payment URL resolves to the wrong revision, selection or quote.
- On the owner-approved WhatsApp mobile and desktop screenshots, both new links occupy fewer visible
  lines than their long-link baselines and retain the correct preview.
- No redacted resolver `5xx` is recorded during the first seven days of production short-link traffic.
  Aggregate resolution-rate instrumentation remains a P1 follow-up, so the spec does not claim an
  unmeasurable percentage target.

## 14. Definition of done

- New tests are shown failing before implementation and green afterward.
- `cd api && npm run check` passes.
- `cd api && npm run smoke` passes.
- `cd web-tests && npm run test:all` passes.
- Migration applies to an empty test database and the current schema without data loss.
- Manual staging checkpoint verifies quote link, payment link and both WhatsApp previews.
- Existing long links are manually opened after deployment.
- The resolver is deployed and verified before short minting is activated.
- Production activation is off by default and the WhatsApp screenshot gate is signed off.
- RLS verification covers `customer_short_links`.
- No files outside the approved step scope changed.

## 15. Decision to revisit later

The v1 redirect means the address bar becomes the existing long URL after a customer opens the short
link. That is acceptable because the stated problem is the URL pasted into WhatsApp, and forwarding the
original message preserves the short form. If customers commonly copy links from their browser instead,
serve the pages directly at `/s/:code` in a separate step; do not expand this build while implementing v1.

## 16. Open questions

There are no blocking questions before Step 1. Production activation has one blocking evidence gate:
the owner must approve the real WhatsApp mobile and desktop screenshots from staging. The proposed
`/s/<16-character-code>` format explicitly accepts 96-bit capability strength; changing that to 128 bits
would produce a 22-character code and must be decided before Step 2 tests are frozen. Any request to keep
the short URL in the browser address bar changes the route and customer-page interfaces and belongs in a
separate follow-up.

## 17. Timeline considerations

There is no external deadline or third-party dependency. Build this as the next explicitly approved
customer-link pair of steps after the current worktree changes are isolated or completed. Step 1 must be
deployed before Step 2, and the WhatsApp evidence gate must pass before the production flag is enabled.
