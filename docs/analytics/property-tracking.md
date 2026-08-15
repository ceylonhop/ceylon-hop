# Analytics, session replay & error tracking across every Ceylon Hop property

**Status: BUILT 2026-08-07.** Code side complete; the GTM/GA4/Clarity console steps in
§6 are the owner's to click. Supersedes nothing — it extends
[`gtm-container-checklist.md`](gtm-container-checklist.md) (Phase 0, apex only) to the
properties that shipped after it.

---

## 1. What we had, and why it was not "tracked"

Phase 0 instrumented the marketing site. Since then five more customer-facing properties
went live, each one carrying a copy of the GTM loader — which made them *look* tracked.
They were not, for three separate reasons.

| Property | Host | GTM on page | Funnel events before | Clarity replay before |
|---|---|---|---|---|
| Marketing site | `ceylonhop.com`, `prod.` | yes | 15 | yes |
| **Pay link** | `pay.ceylonhop.com` | yes | **0** | **no — consent never granted** |
| **Customer quote** | `quote.ceylonhop.com` | yes | **0** | **no — consent never granted** |
| **Manage booking** | `/manage.html` (site + API host) | yes | **0** | banner only |
| **Ride Board** | `ride.ceylonhop.com` | yes | 8 | banner only |
| Ops dashboard | `ops.ceylonhop.com` | no (internal) | n/a | n/a — deliberate |

### The three faults

**F1 — consent is never granted on `pay` and `quote`.** Both pages set Consent Mode v2
defaults to `denied` and then, by a deliberate owner call (2026-08-01 / 2026-08-06), omit
`consent.js` because the banner overlaid the CTA mid-payment. Nothing else on either page
calls `gtag('consent','update')`. So `analytics_storage` stays denied for the entire
session: Clarity's tag never fires at all, and GA4 is reduced to cookieless pings with no
`client_id`. **This is why there are no replays of a customer paying** — the highest-value
recording we could possibly have.

**F2 — `chIsProd()` recognised two hostnames.** It matched `^(www\.)?ceylonhop\.com$`
only. Every event on `pay.`, `quote.`, `ride.` and `prod.` failed the production check, so
anything gated on it (today: `purchase`) was silently dropped, and the helper could not be
used as a gate on the new properties at all.

**F3 — no funnel events exist off the marketing site.** `pay.html`, `quote.html` and
`manage.html` push nothing. The pay page in particular had *zero* client-side visibility:
when a payment died inside PayHere we could see the resulting `pending` row in Postgres but
had no idea how many payers reached the form, abandoned at billing, or came back on the
cancel leg (see `docs/known-bugs.md` and the iframe-checkout post-mortem). The one signal
that would have diagnosed CH-XKZL3 in minutes did not exist.

Underneath all three: nothing distinguished the properties from one another. Every page
reported as an anonymous hit on container `GTM-NL6K22CM`, so even where data arrived it
could not be segmented, and a Sentry front-end error did not say which property threw it.

---

## 2. Design

### 2.1 One shared vocabulary — `property` and `env`

`analytics.js` gains two pure functions and pushes their result once per page load:

```js
window.chProperty()  // 'site' | 'pay' | 'quote' | 'manage' | 'board' | 'ops'
window.chEnv()       // 'prod' | 'staging' | 'dev'
```

`chProperty()` keys off the **pathname**, not the host, on purpose: `pay.html` is reachable
both at `pay.ceylonhop.com` and directly on the API host (the API serves the customer pages
— see the customer-pages-on-API-host note), and both must report as `pay`. `chEnv()` keys
off the host, which is what actually distinguishes prod from staging from a laptop.

On load, `analytics.js` pushes:

```js
{ event: 'ch_context', ch_property: 'pay', ch_env: 'prod' }
```

...before any other event, and mirrors the pair into Clarity as custom tags
(`clarity('set','property','pay')`) so replays are filterable by property in the Clarity UI.
Every subsequent `chTrack()` call also carries `ch_property` / `ch_env` automatically, so no
call site has to remember to add it and no GA4 tag has to be configured twice.

`chIsProd()` — the **revenue** gate, deliberately narrower than `chEnv()` — now matches
`ceylonhop.com`, `www`, `pay`, `quote` and `ride`. Those subdomains are the sole live home
of their flow (there is no other host a customer reaches them on) and real USD has settled
through `pay.ceylonhop.com` since 2026-08-02, so a purchase there is real revenue.

**`prod.ceylonhop.com` stays out, unchanged.** It is the pre-cutover *copy* of the
marketing site — where the owner does test bookings — and the original rule exists so that
sandbox transactions can never enter revenue, which GA4 cannot undo. At the apex cutover
the site moves to `ceylonhop.com` and matches on its own, with no code change. Also still
false: `ops.*`, every `*staging*` spelling, `onrender.com`, `github.io`, `localhost`, IPs,
and lookalikes like `evil-prod.ceylonhop.com` and `pay.ceylonhop.com.evil.example`.

`purchase` carries a **second, independent** gate on top of the host: `pay.html` records
whether the gateway it handed off to was `sandbox.payhere.lk`, at hand-off time, because
the return leg never sees the checkout URL. A sandbox settlement is never reported as
revenue even on a production host — and the purchase is de-duplicated per booking
reference, so a refresh of the confirmation screen cannot bill the funnel twice.

### 2.2 Consent on the transactional properties (fixes F1)

The owner's UX call stands: no cookie banner may cover the pay CTA. But "no banner" had been
implemented as "no consent", which silently turned measurement off rather than deferring it.

**Shipped posture — `ASK_FIRST = false` (owner, 2026-08-07).** `pay.html` and `quote.html`
grant `analytics_storage` on arrival and render nothing. The basis is legitimate interest on a
first-party transactional page: our own site, a customer who has already decided to buy, the
privacy policy one tap away, and — the load-bearing part — **no advertising of any kind**.
`ad_storage`, `ad_user_data` and `ad_personalization` stay denied on these two pages
permanently, so they are out of remarketing entirely and no data leaves for an ad platform.

The trade the owner weighed: asking loses the majority of a mostly-European audience, and at
today's volume the exposure from not asking is small. **Revisit at scale** — flip `ASK_FIRST`
to `true` at the top of `consent-transactional.js` when the business is big enough for that
calculus to change. It is one word and a deploy, and the ask path below is fully built and
still under test so the flip is not a rediscovery.

Two things the switch deliberately does **not** overrule:

- **A stored refusal still wins.** `manage.html` shares this `localStorage` key on the apex via
  `consent.js`, so a customer who rejected there and then opens a booking link has genuinely
  said no. Granting anyway because a constant says so would be the one indefensible version of
  this feature, and there is a test for it on both the unit and e2e side.
- **`?chc=1` cross-property hand-off** still applies. `quote.ceylonhop.com` and
  `pay.ceylonhop.com` are separate origins, so `localStorage` cannot travel between them.
  (Only observable while `ASK_FIRST` is true; most pay links arrive from email, where there is
  no upstream consent to carry, and §6.2's cross-domain list does the session stitching.)

> ⚠️ **The privacy policy now contradicts the code, and needs one sentence changed.**
> `tools/legal/privacy.body.html` says analytics cookies are *"off by default until you accept
> them in the cookie banner"*. On `pay` and `quote` there is no banner and they are now on by
> default, so that promise is not kept — which is precisely the kind of inconsistency that
> turns a defensible legitimate-interest posture into an indefensible one. Suggested wording,
> to be reviewed rather than applied silently (it is legal copy in a `@generated:` source, so
> it is the owner's call, then `npm run generate:static`):
>
> *"We use cookies and third-party analytics (Google Analytics and Microsoft Clarity) to
> understand how visitors use the site and improve it, and advertising cookies (via Google) to
> measure and personalise ads. On our main site these are off until you accept them in the
> cookie banner. On our payment and quote pages we use analytics only — never advertising —
> to make sure checkout works; email us and we'll exclude you."*

**The ask path (`ASK_FIRST = true`)** renders a slim strip that **reserves its own height** as
body padding instead of floating. That single detail is the answer to the owner's original
objection — `consent.js` is `position: fixed` with nothing reserving room, which is how it came
to sit on "Pay with PayHere" on a phone. An e2e test asserts the strip's bounding box never
intersects the CTA at 390px wide, and it runs against the real module with the switch rewritten
to `true`, so it cannot rot while the path is dormant.

### 2.3 Funnel events (fixes F3)

Named to match GA4's ecommerce vocabulary wherever one exists, so the existing funnel
exploration extends rather than forks.

**`pay.html`** — the money path, instrumented at every branch that can lose a payer:

| Event | Fires when | Key params |
|---|---|---|
| `pay_link_opened` | `/quotes/pay/view` resolves | `state` (payable/paid/revised/unavailable), `value`, `currency` |
| `view_item` | the payable ticket paints | `value`, `currency`, `item_category` |
| `begin_checkout` | "Pay with PayHere" tapped | `value`, `currency` |
| `pay_form_invalid` | client-side validation blocks Continue | `reason` (country/phone/address/city/bill_country/terms/cardholder) |
| `add_payment_info` | details pass validation | `value`, `currency` |
| `payment_initiated` | immediately before the top-level POST to PayHere | `value`, `currency` |
| `payment_start_failed` | `/quotes/pay/start` or `/checkout` refuses | `reason` |
| `purchase` | our own server confirms `paid` on the return leg | `transaction_id`, `value`, `currency` |
| `payment_failed` | our server reports `failed` | `leg` (return/cancel) |
| `payment_cancelled` | cancel leg, no terminal answer | — |
| `payment_unconfirmed` | poll budget exhausted with no answer | `leg`, `tries` |

`pay_form_invalid` and `payment_unconfirmed` are the two that did not exist in any form
before and are the two that explain the `pending` rows.

**`quote.html`**: `quote_link_opened` (`state`: live/lapsed/booked/unavailable),
`view_item_list` + `select_item` across the option cards, `quote_lapsed_shown`, and the
existing delegated `contact_whatsapp` now correctly attributed by property. The
"Confirm on WhatsApp" CTAs are the conversion point on this page and were previously
indistinguishable from a WhatsApp click anywhere else on the estate.

**`manage.html`**: `manage_opened` (`status`, `has_balance`), `begin_checkout`,
`payment_initiated`, `purchase`, `payment_failed`, `payment_dismissed`, `manage_link_invalid`.

### 2.4 Error tracking parity

The `/errors/client` beacon already existed on all five pages, but every copy reported
identically — a Sentry issue said "front-end error" with no way to tell a pay-page failure
from a blog-page failure. Two changes:

1. every beacon on the four app properties now sends a `property` field; the endpoint
   validates it against a **closed** set (it becomes a Sentry tag and an alert subject line
   on a public, unauthenticated endpoint, so an open string field would be a way to write
   arbitrary text into both), tags the Sentry event `property:<name>`, and puts it in the
   alert subject. The property also joins the alert **dedupe key**, so a chatty
   marketing-page error can no longer swallow the identical error on the payment page.

   The marketing site's beacon is deliberately **not** changed: it is baked into 44
   generated pages by `tools/site-chrome.mjs`, and the endpoint already defaults a missing
   property to `site` — which is the correct answer for every one of them. Regenerating the
   whole static site to hard-code a value the server infers correctly is blast radius for
   nothing. (Pages cached before this change also keep reporting, for the same reason.)
2. the **silent catch paths are now reported**. `pay.html`'s `load().catch(renderUnavailable)`,
   `quote.html`'s `load().catch(renderUnavailable)` and `manage.html`'s fetch rejections all
   used to swallow a dead or 500-ing API and show the customer a friendly "this link has
   sailed off" — indistinguishable, to us, from a genuinely expired link. They now beacon
   first. An outage on the pay endpoint used to be invisible until someone complained.

### 2.5 Clarity and PII

Clarity's default masking covers form **inputs**, not rendered text. The customer pages
render the traveller's first name, full booking reference, itinerary and totals as ordinary
text, all of which would land in a replay. Every such region now carries
`data-clarity-mask="true"`: the greeting, the passenger cells, the booking reference chip,
and the whole billing/details form. Layout and interaction are still fully visible — which
is the entire point of watching the replay — while the identity is not.

---

## 3. Cross-domain session continuity

GA4 treats `quote.ceylonhop.com` → `pay.ceylonhop.com` as two sessions unless the domains
are declared. Code side is done (the `chc` hand-off and the shared container); §6.2 is the
console step. Without it, every payment appears to originate from a referral and the quote
that produced it is invisible in attribution.

## 4. What is deliberately NOT tracked

- **The ops dashboard.** Internal tooling, staff only, and it already has its own
  `opsReportError` beacon. Sending staff behaviour to GA4 would pollute the funnel; the
  `chProperty()` value `ops` exists only so an error beacon can say where it came from.
- **Anything on staging or localhost.** `chEnv()` reports it and `chIsProd()` blocks it.
- **Ad/remarketing signals on `pay` and `quote`.** See §2.2.
- **PII of any kind in an event parameter.** No name, email, phone, address, or pay token
  is ever pushed to the dataLayer. `transaction_id` is the booking reference, which is what
  GA4 needs for dedupe and what already appears in the confirmation email.

## 5. Verification

`web-tests/unit/` covers the helper's host/property/env matrix, the presence and shape of
every new call site, and the consent module's grant scope. Run:

```bash
npm run test:all
```

## 6. Console steps (owner)

### 6.1 GA4 — new event tags
Add a Custom Event trigger + GA4 event tag for each of: `pay_link_opened`,
`pay_form_invalid`, `payment_start_failed`, `payment_cancelled`, `payment_unconfirmed`,
`quote_link_opened`, `quote_lapsed_shown`, `manage_opened`, `manage_link_invalid`.
Register `ch_property`, `ch_env`, `state`, `reason` and `leg` as event-scoped custom
dimensions. Mark `purchase` a key event on the new properties too.

### 6.2 GA4 — cross-domain
Admin → Data Streams → the web stream → Configure tag settings → Configure your domains.
Add all of: `ceylonhop.com`, `prod.ceylonhop.com`, `pay.ceylonhop.com`,
`quote.ceylonhop.com`, `ride.ceylonhop.com`.

### 6.3 Clarity
Project `qrhbzsb6w8`, trigger All Pages, consent-gated on `analytics_storage`. Then in the
Clarity UI, confirm the `property` custom tag appears and build a saved filter per property
— `property = pay` is the one to watch first.

### 6.4 Sanity check
GTM Preview on `pay.ceylonhop.com` with a real (small) payment: accept the analytics strip,
confirm `ch_context` fires first with `ch_property: pay`, then walk to `purchase`. Confirm
the replay appears in Clarity with the name and reference masked.
