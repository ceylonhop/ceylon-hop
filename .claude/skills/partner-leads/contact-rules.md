# Contact rules

Goal: the right named decision-maker and the best **published** business channel.
Target, in order: founder / owner / MD / CEO; else the head of international, outbound,
product/contracting or partnerships (prefer that over the CEO at large firms).

## Allowed sources (professional context only)

- the agency's own site: About, Team, Contact, footer, legal pages
- trade press and interviews quoting the person in their role (TravTalk, TravelBiz Monitor,
  Travel Trade Journal, Express TravelWorld, TTG; European trade press for EU briefs)
- association directories and committee lists (TAAI, OTOAI, ADTOI, IATO, TAFI, ETAA; ABTA, DRV,
  ANVR for Europe)
- award listings
- company registries: Tofler, Zaubacorp, Tracxn, Falconebiz (India); Companies House (UK);
  national registries elsewhere
- the company's own LinkedIn **company** page, or YouTube/Instagram where the founder presents the company

## Email labels (for `email_label`, describing the `to` address)

- `published`: shown on the company's own site, or in the person's professional context.
- `registry-filed`: filed with a registry but not on the site. **Cc only, never To.**
- `pattern-inferred`: only when at least one other named address at that domain shows the
  pattern (e.g. `firstname@`). Note the evidence in `notes`.

Decode Cloudflare-obfuscated addresses (`data-cfemail`) rather than skipping them.

## Confidence

- **HIGH:** two or more independent sources agree.
- **MEDIUM:** one good source (own site, registry, or press).
- **LOW:** search snippet only, or testimonials only.

Team pages that look like template placeholders (generic names and bios that don't match the
registry) are not a source.

## Never collect

Personal Gmail/Yahoo/Outlook addresses (unless the company publishes it as its business contact),
personal mobile numbers the company doesn't publish as a business line, home addresses, family
relationships, personal social profiles, or personal LinkedIn profiles. Never submit a form,
sign up, or message anyone.
