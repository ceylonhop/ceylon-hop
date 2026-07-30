# GTM-NL6K22CM — Phase 0 configuration checklist

Do this in the Google Tag Manager + GA4 web UI. The site code already pushes all events
below to `dataLayer`; these steps turn them into tags. Reuse the EXISTING container/property.

## GA4
- [ ] GA4 Configuration tag → Measurement ID `G-XEW62ZD7B3`, trigger: Consent Initialization.
- [ ] Mark `purchase` as a **key event** (Admin → Events).
- [ ] Register custom dimensions (event-scoped): `payment_type`, `name` (checkout step),
      `item_category`, `source`, `mode`.

## GA4 event tags (one per dataLayer event; Custom Event trigger on the event name)
- [ ] `search`, `view_item_list`, `select_item`, `begin_checkout`, `checkout_step`,
      `add_payment_info`, `payment_initiated`, `purchase`, `payment_dismissed`,
      `payment_failed`, `reprice_shown`, `reprice_accepted`.
- [ ] Map event params via Data Layer Variables (value, currency, items, payment_type, step…).

## Microsoft Clarity
- [ ] Add the Microsoft Clarity tag (Community template) → project `qrhbzsb6w8`,
      trigger: All Pages (respecting consent). Verify replays appear in Clarity.

## Consent
- [ ] Enable Consent Mode; confirm all tags have "Require additional consent" =
      `analytics_storage` / `ad_storage` as appropriate. Defaults are set in the page head.

## WhatsApp contact tracking (added 2026-07-30)

`analytics.js` fires **`contact_whatsapp`** on every click of a `wa.me/<number>` link,
plus search.js's programmatic 6+ pax handoff. Params: `method` (`whatsapp`), `link_id`
(the anchor's id, `''` if unset), `page` (pathname). No phone number, no href, no PII.

- [ ] GA4 event tag → Custom Event trigger on `contact_whatsapp`, params `method`,
      `link_id`, `page`. Requires `analytics_storage`.
- [ ] Register `link_id` and `method` as event-scoped custom dimensions.
- [ ] Mark `contact_whatsapp` a **key event** — for a WhatsApp-first business this is a
      conversion, not an engagement signal.

**Do not** trigger on all `wa.me` clicks. board.js builds phone-less `wa.me/?text=…`
links for travellers sharing a van with a friend; those are shares, not contacts, and the
site code already excludes them. A broad `Click URL contains wa.me` trigger in GTM would
put them straight back in and inflate the metric with the board's own virality loop.

## Deferred to Phase 1 (do NOT configure yet)
- [ ] Google Ads `AW-16942077888` conversion on `purchase`.
- [ ] Meta Pixel `656008603498739` base + Purchase.
- [ ] Server-side Measurement Protocol / Meta CAPI.

## Verify
- [ ] GTM Preview (Tag Assistant) → walk the funnel on the live app → each event shows.
- [ ] GA4 DebugView → funnel events arrive with params.
- [ ] Build a Funnel Exploration: page_view → search → view_item_list → select_item →
      begin_checkout → checkout_step → add_payment_info → payment_initiated → purchase.
