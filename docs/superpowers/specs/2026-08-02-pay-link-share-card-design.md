# Pay-link WhatsApp share card (owner-approved 2026-08-02)

## Problem

Ops sends payment links over WhatsApp. Today `pay.html` carries **zero** `og:` tags, so the
message unfurls as nothing: a ~200-character URL with a base64 token in it, no image, no
context — arriving immediately before a request for several hundred dollars. That is the visual
grammar of a phishing link, at the exact moment the customer most needs to trust it.

The quote share card (`shareCard.ts` + `shareCardImage.ts`) already solves this shape for ride
lists. This applies the same treatment to pay links.

## The blocker that dictates the design

**WhatsApp's crawler does not execute JavaScript.** `pay.html` is entirely client-rendered — the
trip, total and name all arrive from `fetch('/quotes/pay/view')` after load. So the tags cannot
be populated client-side. They must be **server-rendered per token**.

## Owner decisions

1. **Trip + branding on the card; NO amount.** The itinerary is what proves the link is
   genuinely from Ceylon Hop — no phisher knows the customer's route. The price stays one tap
   away on a page that is already bearer-authenticated. The card is public to anyone the link
   reaches: group chats, lock screens, forwards.
2. **Every state previews as something.** A link that unfurls to nothing reads as broken.

## Architecture

Three pieces, each reusing what exists:

**1. `api/src/routes/payCard.ts`** — `payCardModel(quote)` + `payCardSvg(model)`.
Built on `payPageCopy()` (already derives the trip title and date span from a quote) and the
exported `wrap()` from `shareCardImage.ts`. Same 1200×630 canvas and brand palette as the ride
card, so the two feel like one family.

**2. `GET /pay/card.png?t=…`** — verify token → load quote → `payCardSvg` → `Resvg` → PNG.
Mirrors `/:code/card.png`, including its `cache-control: public, max-age=300, s-maxage=300`.

**3. `customerPages.ts` injects the meta tags** into the `pay.html` it already rewrites:
`og:title`, `og:description`, `og:image`, `og:url`, `og:type`, `twitter:card`,
`twitter:title`, `twitter:description`, `twitter:image`.

### The one structural change

`customerPagesRoutes()` currently takes **no deps** and caches the fully-transformed file. It
gains `{ quotes, linkSecret, payBaseUrl }`. The base HTML stays cached per-deploy; only the OG
block is built per request.

### Data flow

```
WhatsApp crawler → GET /pay.html?t=…
                   ├─ verifyQuotePayToken → quoteId, revision
                   ├─ quotes.get(quoteId) → payPageCopy(quote)
                   └─ inject <meta og:*>, og:image = <payBaseUrl>/pay/card.png?t=…
                                            └─ crawler fetches → Resvg → PNG
```

## Card content

```
🄲  CEYLON HOP
Your trip is ready to confirm
Colombo Airport → Kandy → Ella
16–21 August · Private car · 2 guests
🔒 Secure payment · PayHere
```

`og:title` — "Your trip is ready to confirm · Ceylon Hop"
`og:description` — the route line + date span + vehicle/pax. **Never the amount.**

## Failure modes

Every state renders something; the fallback is the **same generic card** for all of them, so a
crawler cannot probe token validity by diffing previews.

| State | Card | HTTP |
|---|---|---|
| `payable` | full trip card | 200 |
| `revised` / `unavailable` / `paid` | generic Ceylon Hop card | 200 |
| bad / garbage / unsigned token | generic card | **200, not 404** |
| quote lookup throws | generic card | 200 — never a 500 to a crawler |

Generic card: brand mark, "Secure payment", "Confirm your Sri Lanka trip", PayHere lock. No
customer data of any kind.

## Out of scope

- The amount, per the owner decision above.
- `manage.html` — same seam, but a booking link is sent after payment, when trust is already
  established. Deliberately deferred.
- Any new dependency: `@resvg/resvg-js` is already in `package.json` and already rasterizes the
  ride card in production.
- Customer deduplication and the traveller/customer split — unrelated, specced separately.

## Testing

- A payable token → `og:title`/`og:image` correct, `og:image` absolute and https.
- Each dead state (`revised`, `unavailable`, `paid`) → generic card, **no trip text**.
- Garbage token → 200 with the generic card, never 404 or 500.
- **The amount never appears** in the OG tags or the SVG — the guard on the owner's decision.
- `/pay/card.png` returns `image/png` with the cache header.
- **Mount order**: `customerPages` is mounted before the share-card `/:code` route, which would
  otherwise swallow `/pay.html`. `customerPages.test.ts` already asserts this end-to-end through
  the real `createApp`; extend it to cover `/pay/card.png`.

## Definition of done

`cd api && npm run check` green, `web-tests npm run test:all` green, a rendered PNG checked by
eye against the approved card content, one PR. No migration.
